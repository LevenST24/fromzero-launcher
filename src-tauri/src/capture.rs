use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
type CaptureCtrl = windows_capture::capture::CaptureControl<
    CaptureHandler,
    Box<dyn std::error::Error + Send + Sync>,
>;

static SEQ: AtomicU64 = AtomicU64::new(0);
// Incremented as soon as a stop is requested. Work queued before that point
// carries the old epoch and is refused even if it starts running later.
static LIFECYCLE_EPOCH: AtomicU64 = AtomicU64::new(1);
// Capture session control handle
static CONTROL: OnceLock<Mutex<Option<CaptureCtrl>>> = OnceLock::new();
// Global target capture FPS
pub static CAPTURE_FPS: AtomicU32 = AtomicU32::new(60);

fn control_slot() -> &'static Mutex<Option<CaptureCtrl>> {
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
        let Ok(crop) = CROP.lock() else {
            return Ok(());
        };
        let (x0, y0, x1, y1) = *crop;
        drop(crop);

        let mut cropped = frame.buffer_crop(x0, y0, x1, y1)?;
        let bytes = cropped.as_nopadding_buffer()?;

        let src_w = x1 - x0;
        let src_h = y1 - y0;

        let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;

        let Ok(mut slot) = LATEST_FRAME.lock() else {
            return Ok(());
        };
        // Reclaim the previous frame's buffer if nobody else holds it,
        // reusing its capacity instead of allocating ~1MB per frame.
        let mut buf = slot
            .take()
            .and_then(|old| Arc::try_unwrap(old.data).ok())
            .unwrap_or_default();
        buf.clear();
        buf.extend_from_slice(bytes);

        *slot = Some(FrameData {
            w: src_w,
            h: src_h,
            seq,
            data: Arc::new(buf),
        });
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // The control handle can outlive a session that the OS closed. Mark it
        // inactive so the next focus event creates a fresh session.
        SESSION_FPS.store(0, Ordering::Release);
        if let Ok(mut frame) = LATEST_FRAME.lock() {
            *frame = None;
        }
        Ok(())
    }
}

/// Check if capture session is active
pub fn is_active() -> bool {
    SESSION_FPS.load(Ordering::Acquire) != 0
        && control_slot()
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false)
}

/// FPS the current session was created with (0 = no session). Lets `start`
/// reuse a live session when only the crop region changed.
static SESSION_FPS: AtomicU32 = AtomicU32::new(0);
/// Serializes capture lifecycle changes. Pre-warm, frontend start and focus-loss
/// stop can otherwise race and leave a hidden window capturing the desktop.
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub fn lifecycle_epoch() -> u64 {
    LIFECYCLE_EPOCH.load(Ordering::Acquire)
}

fn stop_session() {
    let control = control_slot().lock().ok().and_then(|mut slot| slot.take());
    if let Some(control) = control {
        let _ = control.stop();
    }
    SESSION_FPS.store(0, Ordering::Release);
    if let Ok(mut frame) = LATEST_FRAME.lock() {
        *frame = None;
    }
}

/// Start graphics capture on the primary monitor.
/// Coordinates are physical screen pixels.
/// Reuses a live session (only updating the crop) when the FPS is unchanged —
/// WGC session creation costs hundreds of ms and dominates summon latency.
pub fn start_for_epoch(
    expected_epoch: u64,
    win_x: i32,
    win_y: i32,
    win_w: u32,
    win_h: u32,
    pad_phys: u32,
) -> Result<bool, String> {
    let _lifecycle_guard = LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "capture lifecycle mutex poisoned".to_string())?;
    if expected_epoch != lifecycle_epoch() {
        return Ok(false);
    }

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

    *CROP.lock().map_err(|_| "CROP mutex poisoned".to_string())? = (x0, y0, x1, y1);

    let fps = CAPTURE_FPS.load(Ordering::Relaxed).max(1);
    if is_active() && SESSION_FPS.load(Ordering::Relaxed) == fps {
        // Live session with the right FPS: crop already updated, nothing to do.
        return Ok(true);
    }

    stop_session();

    // stop() invalidates the epoch before waiting for this lock, so check once
    // more after monitor setup and before creating the expensive WGC session.
    if expected_epoch != lifecycle_epoch() {
        return Ok(false);
    }

    let duration = std::time::Duration::from_nanos((1_000_000_000.0 / fps as f64).round() as u64);

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(duration),
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        (),
    );

    let control = CaptureHandler::start_free_threaded(settings).map_err(|e| e.to_string())?;
    *control_slot()
        .lock()
        .map_err(|_| "control mutex poisoned".to_string())? = Some(control);
    SESSION_FPS.store(fps, Ordering::Release);
    Ok(true)
}

/// Terminate the capture session.
pub fn stop() {
    LIFECYCLE_EPOCH.fetch_add(1, Ordering::AcqRel);
    // Recover a poisoned lifecycle lock here: stopping capture is a privacy
    // boundary and should remain best-effort even after another thread panics.
    let _lifecycle_guard = LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stop_session();
}
