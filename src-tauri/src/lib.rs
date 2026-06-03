mod commands;
mod indexer;
mod settings;

use crate::commands::AppState;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewWindow};

#[allow(dead_code)]
fn apply_window_vibrancy(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        // Try Acrylic FIRST — most visible frosted glass effect, works on Windows 10+
        // Tint (R, G, B, Alpha): Alpha 25/255 = ~10% tint, letting 90% of blur show through
        match window_vibrancy::apply_acrylic(window, Some((18, 18, 26, 25))) {
            Ok(_) => {
                eprintln!("[FromZero] ✓ Acrylic blur applied successfully");
                return;
            }
            Err(e) => eprintln!("[FromZero] Acrylic failed: {e}, trying Mica..."),
        }

        // Try Mica (Windows 11 22H2+) — premium subtle blur
        match window_vibrancy::apply_mica(window, Some(true)) {
            Ok(_) => {
                eprintln!("[FromZero] ✓ Mica blur applied successfully");
                return;
            }
            Err(e) => eprintln!("[FromZero] Mica failed: {e}, trying basic Blur..."),
        }

        // Final fallback: basic DWM blur
        match window_vibrancy::apply_blur(window, Some((18, 18, 24, 160))) {
            Ok(_) => eprintln!("[FromZero] ✓ Basic blur applied successfully"),
            Err(e) => eprintln!("[FromZero] ✗ All blur effects failed: {e}"),
        }
    }
}

fn should_toggle_from_tray_event(event: &TrayIconEvent) -> bool {
    match event {
        // DoubleClick is Windows-only; prefer it to avoid duplicate Click events on that platform.
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => true,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => !cfg!(target_os = "windows"),
        _ => false,
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let quit_i = MenuItem::with_id(handle, "quit", "退出 FromZero Launcher", true, None::<&str>)?;
    let show_i = MenuItem::with_id(handle, "show", "呼出启动器", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&show_i, &quit_i])?;

    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("FromZero Launcher — 双击呼出，右键菜单")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if !should_toggle_from_tray_event(&event) {
                return;
            }

            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(visible) = window.is_visible() {
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    // Store tray icon in managed state to extend its lifetime and prevent garbage collection drop
    let state = handle.state::<AppState>();
    if let Ok(mut tray_guard) = state.tray.lock() {
        *tray_guard = Some(tray);
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(AppState {
            apps: Mutex::new(Vec::new()),
            settings_lock: Mutex::new(()),
            tray: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::bump_recent_app,
            commands::scan_apps,
            commands::search_apps,
            commands::launch_app,
            commands::open_folder,
            commands::open_search,
            commands::execute_sys_command,
            commands::debug_log,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // 1. Load settings
            let settings = settings::load_settings(app.handle());

            // 2. Refresh registry autostart registration if enabled to cure path drifts
            if settings.autostart {
                let _ = settings::apply_autostart_setting(app.handle(), true);
            }

            // 3. Register global shortcut from settings
            eprintln!("[FromZero] Registering shortcut: {}", settings.shortcut);
            match commands::register_shortcut_internal(app.handle(), &settings.shortcut) {
                Ok(_) => eprintln!("[FromZero] ✓ Shortcut '{}' registered successfully", settings.shortcut),
                Err(e) => {
                    eprintln!("[FromZero] ✗ Primary shortcut failed: {e}");
                    let fallback = "Ctrl+Alt+Space";
                    eprintln!("[FromZero]   Trying fallback: {fallback}");
                    match commands::register_shortcut_internal(app.handle(), fallback) {
                        Ok(_) => {
                            eprintln!("[FromZero] ✓ Fallback shortcut '{fallback}' registered");
                            // Persist fallback shortcut back to settings file so configuration matches actual bound key
                            let mut updated_settings = settings.clone();
                            updated_settings.shortcut = fallback.to_string();
                            let _ = settings::save_settings(app.handle(), &updated_settings);
                        }
                        Err(e2) => eprintln!("[FromZero] ✗ Fallback also failed: {e2}"),
                    }
                }
            }

            // 4. Configure System Tray
            setup_tray(app)?;

            // 5. Silent Boot/Tray Boot Implementation
            let args: Vec<String> = std::env::args().collect();
            let is_autostart = args.iter().any(|arg| arg == "--autostart");

            if !is_autostart {
                eprintln!("[FromZero] Showing window...");
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                eprintln!("[FromZero] Booted silently via autostart. Window remains hidden in tray.");
            }

            // 6. Apply Mica/Acrylic AFTER window setup
            // Commented out to eliminate the Windows 11 DWM rendering bug where applying native Mica/Acrylic
            // on transparent borderless windows forces a solid black/grey shadow box on the bottom and right margins.
            // Our CSS backdrop-filter handles the Liquid Glass frosted blur beautifully inside the client area.
            // apply_window_vibrancy(&window);

            #[cfg(target_os = "windows")]
            remove_dwm_border(&window);

            eprintln!("[FromZero] ✓ Setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn remove_dwm_border(window: &WebviewWindow) {
    use std::ffi::c_void;

    type DwmSetWindowAttributeFn = unsafe extern "system" fn(
        hwnd: *mut c_void,
        dw_attribute: u32,
        pv_attribute: *const c_void,
        cb_attribute: u32,
    ) -> i32;

    unsafe {
        let module_name = std::ffi::CString::new("dwmapi.dll").unwrap();
        let handle = winapi::um::libloaderapi::LoadLibraryA(module_name.as_ptr());
        if !handle.is_null() {
            let func_name = std::ffi::CString::new("DwmSetWindowAttribute").unwrap();
            let proc_addr = winapi::um::libloaderapi::GetProcAddress(handle, func_name.as_ptr());
            if !proc_addr.is_null() {
                let dwm_set_window_attribute: DwmSetWindowAttributeFn = std::mem::transmute(proc_addr);
                if let Ok(hwnd) = window.hwnd() {
                    let raw_hwnd = hwnd.0 as *mut c_void;

                    // 1. Disable native DWM window rounding (Windows 11).
                    // This is critical because DWM rounding natively draws a 1px border around the window.
                    // By forcing DONOTROUND, the window remains a perfect native rectangle, and our CSS border-radius
                    // rounds it smoothly inside WebView2 without drawing any native system borders.
                    let corner_preference: u32 = 1; // DWMWCP_DONOTROUND = 1
                    let hr_corner = dwm_set_window_attribute(
                        raw_hwnd,
                        33, // DWMWA_WINDOW_CORNER_PREFERENCE = 33
                        &corner_preference as *const _ as *const c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                    if hr_corner == 0 {
                        eprintln!("[FromZero] ✓ Successfully disabled native DWM window rounding");
                    } else {
                        eprintln!("[FromZero] DwmSetWindowAttribute failed to disable native rounding: hr = {}", hr_corner);
                    }

                    // 2. Set DWM border color to NONE.
                    let border_color: u32 = 0xFFFFFFFE; // DWM_COLOR_NONE = 0xFFFFFFFE
                    let hr_border = dwm_set_window_attribute(
                        raw_hwnd,
                        34, // DWMWA_BORDER_COLOR = 34
                        &border_color as *const _ as *const c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                    if hr_border == 0 {
                        eprintln!("[FromZero] ✓ Successfully disabled native DWM window border color");
                    } else {
                        eprintln!("[FromZero] DwmSetWindowAttribute failed to remove border color: hr = {}", hr_border);
                    }
                }
            }
            winapi::um::libloaderapi::FreeLibrary(handle);
        }
    }
}

