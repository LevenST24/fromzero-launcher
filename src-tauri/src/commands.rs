use crate::indexer::{self, AppItem};
use crate::settings::{self, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub apps: Mutex<Vec<AppItem>>,
    pub settings_lock: Mutex<()>,
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
    pub captured_background: Mutex<String>,
}

#[tauri::command]
pub fn get_settings(app_handle: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;
    Ok(settings::load_settings(&app_handle))
}

#[tauri::command]
pub fn update_settings(app_handle: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;
    
    // Compare old and new autostart setting to prevent writing registry on every launch
    let old_settings = settings::load_settings(&app_handle);
    if old_settings.autostart != settings.autostart {
        eprintln!("[FromZero] Autostart setting changed: {} -> {}", old_settings.autostart, settings.autostart);
        let _ = settings::apply_autostart_setting(&app_handle, settings.autostart);
    }
    
    settings::save_settings(&app_handle, &settings)?;
    
    // Dynamically register the new global hotkey
    register_shortcut_internal(&app_handle, &settings.shortcut)?;
    Ok(())
}

#[tauri::command]
pub fn bump_recent_app(app_handle: AppHandle, state: State<'_, AppState>, path: String) -> Result<Settings, String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;
    let mut settings = settings::load_settings(&app_handle);
    
    // Update chronological recent apps list (bump existing app to front)
    let recent_index = settings.recent_apps.iter().position(|p| p == &path);
    if let Some(idx) = recent_index {
        settings.recent_apps.remove(idx);
    }
    settings.recent_apps.insert(0, path);
    settings.recent_apps.truncate(16);
    
    settings::save_settings(&app_handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn scan_apps(app_handle: AppHandle, state: State<'_, AppState>) -> Result<Vec<AppItem>, String> {
    let apps = indexer::scan_start_menu(&app_handle);
    
    // Update memory cache
    if let Ok(mut cache) = state.apps.lock() {
        *cache = apps.clone();
    }
    
    // Extract icons asynchronously in background
    indexer::trigger_icon_extraction(app_handle.clone(), apps.clone());
    
    Ok(apps)
}

/// Score an app name against a query string. Returns 0 for no match.
/// Scoring: perfect=100, prefix=80, contains=60, pinyin_initials_prefix=50,
/// pinyin_initials_contains=40, pinyin_full_prefix=30, pinyin_full_contains=20
fn score_app(query_lower: &str, name_lower: &str, initials_lower: &str, full_lower: &str) -> u32 {
    if name_lower == query_lower {
        100
    } else if name_lower.starts_with(query_lower) {
        80
    } else if name_lower.contains(query_lower) {
        60
    } else if initials_lower.starts_with(query_lower) {
        50
    } else if initials_lower.contains(query_lower) {
        40
    } else if full_lower.starts_with(query_lower) {
        30
    } else if full_lower.contains(query_lower) {
        20
    } else {
        0
    }
}

#[tauri::command]
pub fn search_apps(query: String, state: State<'_, AppState>) -> Vec<AppItem> {
    let query_lower = query.to_lowercase().trim().to_string();

    // Lock and inspect cache directly to eliminate deep cloning on every keystroke
    let apps_cache = match state.apps.lock() {
        Ok(cache) => cache,
        Err(e) => {
            eprintln!("[FromZero] Apps lock poisoned: {}", e);
            return Vec::new();
        }
    };

    if query_lower.is_empty() {
        return apps_cache.clone();
    }

    let mut scored_apps = Vec::new();
    for app in apps_cache.iter() {
        let name_lower = app.name.to_lowercase();
        let initials_lower = app.pinyin_initials.to_lowercase();
        let full_lower = app.pinyin_full.to_lowercase();

        let score = score_app(&query_lower, &name_lower, &initials_lower, &full_lower);

        if score > 0 {
            scored_apps.push((score, app.clone())); // Clone only matched items
        }
    }

    // Sort by score (descending), then by name alphabetically as tiebreaker
    scored_apps.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
    });
    scored_apps.into_iter().map(|(_, app)| app).collect()
}

#[tauri::command]
pub fn launch_app(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("应用文件路径不存在: {}", path));
    }
    
    // Security verification: Whitelist execution to only allow files in scanned apps cache
    let is_whitelisted = if let Ok(apps) = state.apps.lock() {
        apps.iter().any(|app| app.path == path)
    } else {
        false
    };
    
    if !is_whitelisted {
        return Err("Security Error: Target application is not in the whitelist".to_string());
    }

    open::that(&path).map_err(|e| format!("Failed to launch app: {}", e))
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    // Clean and translate Unix-style folder paths to Windows paths
    let mut resolved = path.replace('/', "\\");
    
    // Resolve Windows system drive dynamically instead of hardcoding C:
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    
    if resolved == "\\" {
        resolved = format!("{}\\", system_drive);
    } else if resolved.starts_with('\\') && !resolved.starts_with("\\\\") {
        // e.g. "/Windows" -> "C:\Windows"
        resolved = format!("{}{}", system_drive, resolved);
    }

    let path_buf = std::path::PathBuf::from(&resolved);
    if !path_buf.exists() {
        return Err(format!("文件夹路径不存在: {}", resolved));
    }
    
    // Security restriction: Force path to be a directory, preventing EXE execution
    if !path_buf.is_dir() {
        return Err("Security Error: The path is not a folder directory".to_string());
    }

    open::that(&resolved).map_err(|e| format!("Failed to open folder: {}", e))
}

#[tauri::command]
pub fn open_search(url: String) -> Result<(), String> {
    // Security restriction: Only allow standard HTTP/HTTPS schemes to prevent protocol handler abuses
    let trimmed = url.trim();
    let lower = trimmed.to_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("Security Error: Only http:// and https:// URL protocol schemas are allowed".to_string());
    }
    open::that(trimmed).map_err(|e| format!("Failed to open search: {}", e))
}

#[tauri::command]
pub fn execute_sys_command(command: String) -> Result<(), String> {
    match command.as_str() {
        "lock" => {
            std::process::Command::new("rundll32.exe")
                .args(["user32.dll,LockWorkStation"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "sleep" => {
            std::process::Command::new("rundll32.exe")
                .args(["powrprof.dll,SetSuspendState", "0,1,0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "shutdown" => {
            std::process::Command::new("shutdown")
                .args(["/s", "/t", "0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "restart" => {
            std::process::Command::new("shutdown")
                .args(["/r", "/t", "0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("Unknown system command".to_string()),
    }
    Ok(())
}

pub fn register_shortcut_internal(app_handle: &AppHandle, shortcut_str: &str) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let shortcut = Shortcut::from_str(shortcut_str)
        .map_err(|e| format!("Invalid shortcut format '{}': {}", shortcut_str, e))?;

    // Unregister all existing shortcuts first
    let _ = app_handle.global_shortcut().unregister_all();

    // Register the new shortcut with toggle visibility handler
    match app_handle.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(visible) = window.is_visible() {
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = capture_background_before_show(app);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        }
    }) {
        Ok(()) => {
            eprintln!("[FromZero] ✓ Shortcut '{}' registered successfully", shortcut_str);
            Ok(())
        }
        Err(e) => {
            // Registration failed — try to restore the default shortcut as fallback
            eprintln!("[FromZero] ✗ Failed to register shortcut '{}': {}", shortcut_str, e);
            if let Ok(default_shortcut) = Shortcut::from_str("Ctrl+Space") {
                let _ = app_handle.global_shortcut().on_shortcut(default_shortcut, move |app, _shortcut, event| {
                    if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(visible) = window.is_visible() {
                                if visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = capture_background_before_show(app);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                });
                eprintln!("[FromZero] ↻ Restored default Alt+Space as fallback");
            }
            Err(format!("快捷键 '{}' 注册失败: {}", shortcut_str, e))
        }
    }
}

#[tauri::command]
pub fn debug_log(_msg: String) {
    #[cfg(debug_assertions)]
    println!("[Frontend-Debug] {}", _msg);
}

#[cfg(target_os = "windows")]
fn capture_screen_region(x: i32, y: i32, width: i32, height: i32) -> Result<String, String> {
    use std::ptr;
    use winapi::um::wingdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, SRCCOPY,
    };
    use winapi::um::winuser::{GetDC, ReleaseDC};

    unsafe {
        let hwnd_desktop = ptr::null_mut();
        let hdc_screen = GetDC(hwnd_desktop);
        if hdc_screen.is_null() {
            return Err("GetDC failed".to_string());
        }
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_null() {
            ReleaseDC(hwnd_desktop, hdc_screen);
            return Err("CreateCompatibleDC failed".to_string());
        }
        let hbitmap = CreateCompatibleBitmap(hdc_screen, width, height);
        if hbitmap.is_null() {
            DeleteDC(hdc_mem);
            ReleaseDC(hwnd_desktop, hdc_screen);
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let h_old = SelectObject(hdc_mem, hbitmap as *mut _);

        // Copy screen contents
        let success = BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, x, y, SRCCOPY);
        if success == 0 {
            SelectObject(hdc_mem, h_old);
            DeleteObject(hbitmap as *mut _);
            DeleteDC(hdc_mem);
            ReleaseDC(hwnd_desktop, hdc_screen);
            return Err("BitBlt failed".to_string());
        }

        // Get bitmap pixel bits
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // negative for top-down DIB
                biPlanes: 1,
                biBitCount: 32, // BGRA
                biCompression: BI_RGB,
                biSizeImage: (width * height * 4) as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [winapi::um::wingdi::RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }; 1],
        };

        let buf_size = (width * height * 4) as usize;
        let mut pixels = vec![0u8; buf_size];

        let result = GetDIBits(
            hdc_screen,
            hbitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup
        SelectObject(hdc_mem, h_old);
        DeleteObject(hbitmap as *mut _);
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd_desktop, hdc_screen);

        if result == 0 {
            return Err("GetDIBits failed".to_string());
        }

        // Assemble BMP file in memory
        let file_size = 54 + buf_size;
        let mut bmp = Vec::with_capacity(file_size);

        // BMP Header (14 bytes)
        bmp.push(0x42); // 'B'
        bmp.push(0x4D); // 'M'
        bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]); // Reserved
        bmp.extend_from_slice(&54u32.to_le_bytes()); // Offset to pixel data

        // DIB Header (40 bytes)
        bmp.extend_from_slice(&40u32.to_le_bytes()); // header size
        bmp.extend_from_slice(&(width as i32).to_le_bytes());
        bmp.extend_from_slice(&(-(height as i32)).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes()); // planes
        bmp.extend_from_slice(&32u16.to_le_bytes()); // bpp (32-bit BGRA)
        bmp.extend_from_slice(&BI_RGB.to_le_bytes());
        bmp.extend_from_slice(&(buf_size as u32).to_le_bytes());
        bmp.extend_from_slice(&0i32.to_le_bytes());
        bmp.extend_from_slice(&0i32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());

        // Append pixel bytes
        bmp.extend_from_slice(&pixels);

        // Encode as Base64 BMP data URL
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bmp);
        Ok(format!("data:image/bmp;base64,{}", encoded))
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_screen_region(_x: i32, _y: i32, _width: i32, _height: i32) -> Result<String, String> {
    Err("Only Windows is supported".to_string())
}

pub fn capture_background_before_show(app_handle: &AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let pos = window.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
        let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(640, 450));
        match capture_screen_region(pos.x, pos.y, size.width as i32, size.height as i32) {
            Ok(base64_str) => {
                let state = app_handle.state::<AppState>();
                if let Ok(mut bg_guard) = state.captured_background.lock() {
                    *bg_guard = base64_str;
                }
                Ok(())
            }
            Err(e) => {
                eprintln!("[FromZero] Background capture error: {}", e);
                Err(e)
            }
        }
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn get_background(state: State<'_, AppState>) -> Result<String, String> {
    let bg_guard = state.captured_background.lock().map_err(|e| e.to_string())?;
    Ok(bg_guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_score_app_perfect_match() {
        assert_eq!(score_app("chrome", "chrome", "chrome", "chrome"), 100);
    }

    #[test]
    fn test_score_app_prefix_match() {
        assert_eq!(score_app("ch", "chrome", "chrome", "chrome"), 80);
    }

    #[test]
    fn test_score_app_contains_match() {
        assert_eq!(score_app("rom", "chrome", "chrome", "chrome"), 60);
    }

    #[test]
    fn test_score_app_pinyin_initials_prefix() {
        // "wx" matches "微信" via pinyin initials "wx"
        assert_eq!(score_app("wx", "微信", "wx", "weixin"), 50);
    }

    #[test]
    fn test_score_app_pinyin_initials_contains() {
        assert_eq!(score_app("x", "微信", "wx", "weixin"), 40);
    }

    #[test]
    fn test_score_app_pinyin_full_prefix() {
        assert_eq!(score_app("weix", "微信", "wx", "weixin"), 30);
    }

    #[test]
    fn test_score_app_pinyin_full_contains() {
        assert_eq!(score_app("ixin", "微信", "wx", "weixin"), 20);
    }

    #[test]
    fn test_score_app_no_match() {
        assert_eq!(score_app("xyz", "微信", "wx", "weixin"), 0);
    }

    #[test]
    fn test_score_app_caller_handles_case() {
        // The caller lowercases the query before passing; score_app expects lowercase input
        let query_lower = "chrome".to_lowercase();
        assert_eq!(score_app(&query_lower, "chrome", "chrome", "chrome"), 100);
    }
}
