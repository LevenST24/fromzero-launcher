use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_web_engines")]
    pub web_engines: HashMap<String, String>,
    #[serde(default)]
    pub recent_apps: Vec<String>,
    #[serde(default = "default_autostart")]
    pub autostart: bool,
}

fn default_shortcut() -> String {
    "Alt+Space".to_string()
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_autostart() -> bool {
    false
}

fn default_web_engines() -> HashMap<String, String> {
    let mut web_engines = HashMap::new();
    web_engines.insert("g".to_string(), "https://google.com/search?q={}".to_string());
    web_engines.insert("b".to_string(), "https://baidu.com/s?wd={}".to_string());
    web_engines.insert("bi".to_string(), "https://bing.com/search?q={}".to_string());
    web_engines.insert("gh".to_string(), "https://github.com/search?q={}".to_string());
    web_engines
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: default_shortcut(),
            theme: default_theme(),
            web_engines: default_web_engines(),
            recent_apps: Vec::new(),
            autostart: default_autostart(),
        }
    }
}

pub fn get_settings_path(app_handle: &AppHandle) -> Option<PathBuf> {
    let mut config_dir = app_handle.path().app_config_dir().ok()?;
    // Ensure parent directory exists
    let _ = fs::create_dir_all(&config_dir);
    config_dir.push("settings.json");
    Some(config_dir)
}

pub fn load_settings(app_handle: &AppHandle) -> Settings {
    if let Some(path) = get_settings_path(app_handle) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                    return settings;
                }
            }
        }
    }
    Settings::default()
}

pub fn save_settings(app_handle: &AppHandle, settings: &Settings) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;
    
    if let Some(path) = get_settings_path(app_handle) {
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        
        let mut tmp_path = path.clone();
        // Construct filename cleanly to avoid set_extension side-effects
        tmp_path.pop();
        tmp_path.push("settings.json.tmp");
        
        // Write temporary file and sync to disk
        {
            let mut file = File::create(&tmp_path)
                .map_err(|e| format!("Failed to create temporary settings file: {}", e))?;
            file.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write temporary settings file: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to sync temporary settings file: {}", e))?;
        }
            
        // Windows atomic replacement safely: if rename fails because destination exists,
        // we can try removing the destination first on Windows.
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        
        fs::rename(&tmp_path, &path)
            .map_err(|e| format!("Failed to replace settings file: {}", e))?;
            
        Ok(())
    } else {
        Err("Failed to resolve settings path".to_string())
    }
}

pub fn apply_autostart_setting(app_handle: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_manager = app_handle.autolaunch();
    
    if enabled {
        autostart_manager
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
    } else {
        // If the key is already missing (e.g. manually deleted or not yet registered),
        // disable returns os error 2. We robustly ignore this expected error.
        if let Err(e) = autostart_manager.disable() {
            let err_msg = e.to_string();
            if !err_msg.contains("os error 2") && !err_msg.contains("找不到指定的文件") {
                return Err(format!("Failed to disable autostart: {}", e));
            }
        }
    }
    Ok(())
}
