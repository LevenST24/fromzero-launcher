mod commands;
mod indexer;
mod settings;

use crate::commands::AppState;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewWindow};

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

    let _tray = TrayIconBuilder::new()
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

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            apps: Mutex::new(Vec::new()),
            settings_lock: Mutex::new(()),
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
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // 1. Register global shortcut from settings
            let settings = settings::load_settings(app.handle());
            eprintln!("[FromZero] Registering shortcut: {}", settings.shortcut);
            match commands::register_shortcut_internal(app.handle(), &settings.shortcut) {
                Ok(_) => eprintln!("[FromZero] ✓ Shortcut '{}' registered successfully", settings.shortcut),
                Err(e) => {
                    eprintln!("[FromZero] ✗ Primary shortcut failed: {e}");
                    let fallback = "Ctrl+Alt+Space";
                    eprintln!("[FromZero]   Trying fallback: {fallback}");
                    match commands::register_shortcut_internal(app.handle(), fallback) {
                        Ok(_) => eprintln!("[FromZero] ✓ Fallback shortcut '{fallback}' registered"),
                        Err(e2) => eprintln!("[FromZero] ✗ Fallback also failed: {e2}"),
                    }
                }
            }

            // 2. Configure System Tray
            setup_tray(app)?;

            // 3. Show window FIRST, then apply vibrancy
            //    (Some systems require the window to be visible for vibrancy to take effect)
            eprintln!("[FromZero] Showing window...");
            let _ = window.show();
            let _ = window.set_focus();

            // 4. Apply Mica/Acrylic AFTER window is visible
            apply_window_vibrancy(&window);

            eprintln!("[FromZero] ✓ Setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
