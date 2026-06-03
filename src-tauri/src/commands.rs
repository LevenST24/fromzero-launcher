use crate::indexer::{self, AppItem};
use crate::settings::{self, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub apps: Mutex<Vec<AppItem>>,
    pub settings_lock: Mutex<()>,
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
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

    // First, try registering the new shortcut WITHOUT removing the old one.
    // If it succeeds, then unregister all + re-register to cleanly replace.
    // If it fails, the old shortcut remains intact — no silent hotkey loss.
    let test_result = app_handle.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
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
    });

    match test_result {
        Ok(_) => {
            // New shortcut registered successfully — clean up by removing all old ones,
            // then re-register the new one (unregister_all clears it too)
            let _ = app_handle.global_shortcut().unregister_all();

            // Re-register the verified shortcut
            let shortcut2 = Shortcut::from_str(shortcut_str)
                .map_err(|e| format!("Invalid shortcut format '{}': {}", shortcut_str, e))?;
            app_handle.global_shortcut().on_shortcut(shortcut2, move |app, _shortcut, event| {
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

            eprintln!("[FromZero] ✓ Shortcut '{}' registered successfully", shortcut_str);
            Ok(())
        }
        Err(e) => {
            // New shortcut failed — old one is still active, no disruption
            Err(format!("Failed to register shortcut '{}': {}. Old shortcut remains active.", shortcut_str, e))
        }
    }
}

#[tauri::command]
pub fn debug_log(_msg: String) {
    #[cfg(debug_assertions)]
    println!("[Frontend-Debug] {}", _msg);
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
