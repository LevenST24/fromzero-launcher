use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

#[derive(Clone)]
pub struct FrameData {
    pub w: u32,
    pub h: u32,
    pub seq: u64,
    pub data: Arc<Vec<u8>>, // RGBA, no padding
}

// Latest captured frame (frontend pulls via custom protocol)
pub static LATEST_FRAME: Mutex<Option<FrameData>> = Mutex::new(None);
// Crop region: x0, y0, x1, y1 (in physical pixels relative to primary monitor)
pub static CROP: Mutex<(u32, u32, u32, u32)> = Mutex::new((0, 0, 1, 1));
// Global frame sequence counter
static SEQ: AtomicU64 = AtomicU64::new(0);
// Capture session control handle
static CONTROL: OnceLock<Mutex<Option<windows_capture::capture::CaptureControl<CaptureHandler, Box<dyn std::error::Error + Send + Sync>>>>> = OnceLock::new();

fn control_slot() -> &'static Mutex<Option<windows_capture::capture::CaptureControl<CaptureHandler, Box<dyn std::error::Error + Send + Sync>>>> {
    CONTROL.get_or_init(|| Mutex::new(None))
}

pub struct CaptureHandler;

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = ();
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(_ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self)
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let (x0, y0, x1, y1) = *CROP.lock().unwrap();
        // Crop the frame buffer to match the window bounds on screen
        let mut cropped = frame.buffer_crop(x0, y0, x1, y1)?;
        let bytes = cropped.as_nopadding_buffer()?;
        
        let src_w = x1 - x0;
        let src_h = y1 - y0;
        
        // Downscale by 3x to reduce data size by 9x, optimizing IPC and rendering performance
        let dst_w = src_w / 3;
        let dst_h = src_h / 3;
        let mut dst_data = Vec::with_capacity((dst_w * dst_h * 4) as usize);
        for dy in 0..dst_h {
            let sy = dy * 3;
            let row_start = (sy * src_w * 4) as usize;
            for dx in 0..dst_w {
                let sx = dx * 3;
                let idx = row_start + (sx * 4) as usize;
                if idx + 3 < bytes.len() {
                    dst_data.push(bytes[idx]);
                    dst_data.push(bytes[idx + 1]);
                    dst_data.push(bytes[idx + 2]);
                    dst_data.push(bytes[idx + 3]);
                }
            }
        }

        let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;

        *LATEST_FRAME.lock().unwrap() = Some(FrameData {
            w: dst_w,
            h: dst_h,
            seq,
            data: Arc::new(dst_data),
        });
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Start graphics capture on the primary monitor.
/// Coordinates are physical screen pixels.
pub fn start(win_x: i32, win_y: i32, win_w: u32, win_h: u32, pad_phys: u32) -> Result<(), String> {
    stop(); // Guarantee idempotence by stopping any existing session first

    let monitor = Monitor::primary().map_err(|e| e.to_string())?;
    let mon_w = monitor.width().map_err(|e| e.to_string())?;
    let mon_h = monitor.height().map_err(|e| e.to_string())?;

    // Apply the physical padding to expand the capture bounding box outside the window
    let x0 = (win_x - pad_phys as i32).max(0) as u32;
    let y0 = (win_y - pad_phys as i32).max(0) as u32;
    let x1 = ((win_x + win_w as i32 + pad_phys as i32) as u32).min(mon_w);
    let y1 = ((win_y + win_h as i32 + pad_phys as i32) as u32).min(mon_h);

    if x1 <= x0 || y1 <= y0 {
        return Err("Invalid window capture bounds: window is off-screen".to_string());
    }

    *CROP.lock().unwrap() = (x0, y0, x1, y1);

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        (),
    );

    let control = CaptureHandler::start_free_threaded(settings).map_err(|e| e.to_string())?;
    *control_slot().lock().unwrap() = Some(control);
    Ok(())
}

/// Terminate the capture session.
pub fn stop() {
    let control = {
        let mut slot = control_slot().lock().unwrap();
        slot.take()
    };
    if let Some(c) = control {
        let _ = c.stop();
    }
    *LATEST_FRAME.lock().unwrap() = None;
}
