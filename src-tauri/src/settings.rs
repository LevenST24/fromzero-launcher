use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub shortcut: String,
    pub theme: String,
    pub web_engines: HashMap<String, String>,
    pub recent_apps: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        let mut web_engines = HashMap::new();
        web_engines.insert("g".to_string(), "https://google.com/search?q={}".to_string());
        web_engines.insert("b".to_string(), "https://baidu.com/s?wd={}".to_string());
        web_engines.insert("bi".to_string(), "https://bing.com/search?q={}".to_string());
        web_engines.insert("gh".to_string(), "https://github.com/search?q={}".to_string());

        Self {
            shortcut: "Alt+Space".to_string(),
            theme: "dark".to_string(),
            web_engines,
            recent_apps: Vec::new(),
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
    if let Some(path) = get_settings_path(app_handle) {
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        fs::write(path, content)
            .map_err(|e| format!("Failed to write settings file: {}", e))?;
        Ok(())
    } else {
        Err("Failed to resolve settings path".to_string())
    }
}
