mod capture;
mod commands;
mod dwm;
mod indexer;
mod preview;
mod settings;

use crate::commands::AppState;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewWindow};

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

    let tray_icon = app.default_window_icon();
    if tray_icon.is_none() {
        eprintln!("[FromZero] Warning: No default window icon available, skipping tray icon setup");
        return Ok(());
    }

    let quit_i = MenuItem::with_id(handle, "quit", "退出 FromZero Launcher", true, None::<&str>)?;
    let show_i = MenuItem::with_id(handle, "show", "呼出启动器", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&show_i, &quit_i])?;

    let tray = TrayIconBuilder::new()
        .icon(tray_icon.unwrap().clone())
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .register_uri_scheme_protocol("bgframe", |_app, _request| {
            let since_seq: Option<u64> = _request.uri().query().and_then(|q| {
                q.split('&')
                    .find(|pair| pair.starts_with("since="))
                    .and_then(|pair| pair.split('=').nth(1))
                    .and_then(|val| val.parse::<u64>().ok())
            });

            let frame_opt = {
                let guard = crate::capture::LATEST_FRAME.lock().unwrap();
                guard.clone()
            };

            if let Some(since) = since_seq {
                if let Some(ref f) = frame_opt {
                    if f.seq <= since {
                        return tauri::http::Response::builder()
                            .status(204)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(Vec::new())
                            .unwrap();
                    }
                }
            }

            match frame_opt {
                Some(f) => {
                    let data = (*f.data).clone();
                    tauri::http::Response::builder()
                        .header("Content-Type", "application/octet-stream")
                        .header("Cache-Control", "no-store")
                        .header("X-Frame-Width", f.w.to_string())
                        .header("X-Frame-Height", f.h.to_string())
                        .header("X-Frame-Seq", f.seq.to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .header(
                            "Access-Control-Expose-Headers",
                            "X-Frame-Width, X-Frame-Height, X-Frame-Seq",
                        )
                        .body(data)
                        .unwrap()
                }
                None => tauri::http::Response::builder()
                    .status(204)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::new())
                    .unwrap(),
            }
        })
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
            commands::list_directory,
            commands::search_files,
            commands::get_file_preview,
            commands::read_preview_bytes,
            commands::open_file,
            commands::start_bg_capture,
            commands::stop_bg_capture,
            commands::set_capture_fps,
        ])
        .setup(|app| {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!("[FromZero] Error: Main window not found during setup");
                return Err(Box::from("Main window not found during setup"));
            };

            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Focused(focused) => {
                    if !*focused {
                        crate::capture::stop();
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    crate::capture::stop();
                }
                _ => {}
            });

            // 1. Load settings
            let settings = settings::load_settings(app.handle());
            crate::capture::CAPTURE_FPS.store(
                settings.glass_settings.glass_fps as u32,
                std::sync::atomic::Ordering::Relaxed,
            );

            // 1.5. Clear old low-res icon cache to force extraction of high-res icons
            let cache_dir = app.path().app_cache_dir().unwrap_or_default();
            if !cache_dir.as_os_str().is_empty() {
                let version_file = cache_dir.join("icon_version.txt");
                let mut needs_clear = true;
                if version_file.exists() {
                    if let Ok(v) = std::fs::read_to_string(&version_file) {
                        if v.trim() == "256" {
                            needs_clear = false;
                        }
                    }
                }
                if needs_clear {
                    let icons_dir = cache_dir.join("icons");
                    let _ = std::fs::remove_dir_all(&icons_dir);
                    let _ = std::fs::create_dir_all(&cache_dir);
                    let _ = std::fs::write(&version_file, "256");
                    eprintln!("[FromZero] Cleared old low-res icons cache.");
                }
            }

            // 2. Refresh registry autostart registration if enabled to cure path drifts
            if settings.autostart {
                let _ = settings::apply_autostart_setting(app.handle(), true);
            }

            // 3. Register global shortcut from settings
            eprintln!("[FromZero] Registering shortcut: {}", settings.shortcut);
            match commands::register_shortcut_internal(app.handle(), &settings.shortcut) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[FromZero] ✗ Primary shortcut failed: {e}");
                    let fallback = "Ctrl+Shift+Space";
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
                eprintln!(
                    "[FromZero] Booted silently via autostart. Window remains hidden in tray."
                );
            }

            // 6. DWM Acrylic (desktop blur) + native rounding.
            // DWM Acrylic is the only way to blur the desktop behind a transparent WebView2 window.
            // DWMWCP_ROUND prevents sharp-corner artifacts from the Acrylic material.
            // DwmExtendFrameIntoClientArea is NOT used (causes caption buttons on borderless windows).

            #[cfg(target_os = "windows")]
            {
                remove_dwm_border(&window);
                exclude_from_capture(&window);
            }

            eprintln!("[FromZero] ✓ Setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn remove_dwm_border(window: &WebviewWindow) {
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWCP_DONOTROUND: u32 = 1;
    const DWM_COLOR_NONE: u32 = 0xFFFFFFFE;

    if let Ok(hwnd) = window.hwnd() {
        let raw_hwnd = hwnd.0;
        match dwm::set_dwm_attribute(raw_hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND) {
            Ok(()) => eprintln!(
                "[FromZero] ✓ Native DWM window rounding disabled (letting WebGL shape corners)"
            ),
            Err(e) => eprintln!("[FromZero] DWM disable rounding failed: {e}"),
        }
        match dwm::set_dwm_attribute(raw_hwnd, DWMWA_BORDER_COLOR, DWM_COLOR_NONE) {
            Ok(()) => eprintln!("[FromZero] ✓ Native DWM border color removed"),
            Err(e) => eprintln!("[FromZero] DWM border color removal failed: {e}"),
        }
    }
}

#[cfg(target_os = "windows")]
fn exclude_from_capture(window: &WebviewWindow) {
    use std::ffi::c_void;
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: *mut c_void, affinity: u32) -> i32;
    }
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowDisplayAffinity(hwnd.0, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}
