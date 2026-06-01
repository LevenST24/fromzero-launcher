use crate::indexer::{self, AppItem};
use crate::settings::{self, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub apps: Mutex<Vec<AppItem>>,
    pub settings_lock: Mutex<()>,
}

#[tauri::command]
pub fn get_settings(app_handle: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;
    Ok(settings::load_settings(&app_handle))
}

#[tauri::command]
pub fn update_settings(app_handle: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn search_apps(query: String, state: State<'_, AppState>) -> Vec<AppItem> {
    let apps_cache = if let Ok(cache) = state.apps.lock() {
        cache.clone()
    } else {
        Vec::new()
    };

    let query_lower = query.to_lowercase().trim().to_string();
    if query_lower.is_empty() {
        return apps_cache;
    }

    let mut scored_apps = Vec::new();
    for app in apps_cache {
        let name_lower = app.name.to_lowercase();
        let initials_lower = app.pinyin_initials.to_lowercase();
        let full_lower = app.pinyin_full.to_lowercase();

        let mut score = 0;
        
        if name_lower == query_lower {
            score = 100; // Perfect match
        } else if name_lower.starts_with(&query_lower) {
            score = 80;
        } else if name_lower.contains(&query_lower) {
            score = 60;
        } else if initials_lower.starts_with(&query_lower) {
            score = 50; // Pinyin initials (e.g. "wx" matches "微信")
        } else if initials_lower.contains(&query_lower) {
            score = 40;
        } else if full_lower.starts_with(&query_lower) {
            score = 30; // Pinyin full (e.g. "weixin" matches "微信")
        } else if full_lower.contains(&query_lower) {
            score = 20;
        }

        if score > 0 {
            scored_apps.push((score, app));
        }
    }

    // Sort by score (descending)
    scored_apps.sort_by(|a, b| b.0.cmp(&a.0));
    scored_apps.into_iter().map(|(_, app)| app).collect()
}

#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("应用文件路径不存在: {}", path));
    }
    open::that(&path).map_err(|e| format!("Failed to launch app: {}", e))
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    // Clean and translate Unix-style folder paths to Windows paths
    let mut resolved = path.replace('/', "\\");
    if resolved == "\\" {
        resolved = "C:\\".to_string();
    } else if resolved.starts_with('\\') && !resolved.starts_with("\\\\") {
        // e.g. "/Windows" -> "C:\Windows"
        resolved = format!("C:{}", resolved);
    }

    let path_buf = std::path::PathBuf::from(&resolved);
    if !path_buf.exists() {
        return Err(format!("文件夹路径不存在: {}", resolved));
    }

    open::that(&resolved).map_err(|e| format!("Failed to open folder: {}", e))
}

#[tauri::command]
pub fn open_search(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open search: {}", e))
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

    // Try unregistering all to prevent double-binding errors
    let _ = app_handle.global_shortcut().unregister_all();

    // Register and register toggle visibility handler
    app_handle.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        // Only handle key press, not release
        if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(visible) = window.is_visible() {
                    if visible {
                        eprintln!("[FromZero] Shortcut: hiding window");
                        let _ = window.hide();
                    } else {
                        eprintln!("[FromZero] Shortcut: showing window");
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        }
    }).map_err(|e| format!("Failed to register shortcut '{}': {}", shortcut_str, e))?;

    Ok(())
}
