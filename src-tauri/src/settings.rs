use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GlassSettings {
    #[serde(default = "default_glass_blur")]
    pub glass_blur: i32,
    #[serde(default = "default_border_opacity")]
    pub border_opacity: f64,
    #[serde(default = "default_glass_fps")]
    pub glass_fps: i32,
    #[serde(default = "default_strength")]
    pub strength: i32,
    #[serde(default = "default_chroma")]
    pub chroma: f64,
    #[serde(default = "default_frost")]
    pub frost: f64,
    #[serde(default = "default_beer")]
    pub beer: i32,
    #[serde(default = "default_caustic")]
    pub caustic: f64,
    #[serde(default = "default_squircle_n")]
    pub squircle_n: f64,
    #[serde(default = "default_search_height")]
    pub search_height: i32,
    #[serde(default = "default_search_offset")]
    pub search_offset: i32,
}

fn default_glass_blur() -> i32 { 8 }
fn default_border_opacity() -> f64 { 0.60 }
fn default_glass_fps() -> i32 { 60 }
fn default_strength() -> i32 { 30 }
fn default_chroma() -> f64 { 0.045 }
fn default_frost() -> f64 { 3.0 }
fn default_beer() -> i32 { 15 }
fn default_caustic() -> f64 { 0.6 }
fn default_squircle_n() -> f64 { 4.5 }
fn default_search_height() -> i32 { 46 }
fn default_search_offset() -> i32 { 10 }

impl Default for GlassSettings {
    fn default() -> Self {
        Self {
            glass_blur: default_glass_blur(),
            border_opacity: default_border_opacity(),
            glass_fps: default_glass_fps(),
            strength: default_strength(),
            chroma: default_chroma(),
            frost: default_frost(),
            beer: default_beer(),
            caustic: default_caustic(),
            squircle_n: default_squircle_n(),
            search_height: default_search_height(),
            search_offset: default_search_offset(),
        }
    }
}

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
    #[serde(default)]
    pub glass_settings: GlassSettings,
}

fn default_shortcut() -> String {
    "Ctrl+Space".to_string()
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
            glass_settings: GlassSettings::default(),
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

#[cfg(target_os = "windows")]
fn save_settings_win_atomic(from_path: &std::path::Path, to_path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    
    extern "system" {
        fn MoveFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            dwFlags: u32,
        ) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 1;
    
    let from: Vec<u16> = from_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to_path.as_os_str().encode_wide().chain(Some(0)).collect();
    
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    if ok == 0 {
        return Err(format!(
            "Failed to atomically replace settings file: Windows OS Error {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
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
            
        // Perform atomic replacement: MoveFileExW on Windows (NTFS single-step transaction),
        // or std::fs::rename on POSIX systems (which is natively atomic).
        let replace_res = {
            #[cfg(target_os = "windows")]
            {
                save_settings_win_atomic(&tmp_path, &path)
            }
            #[cfg(not(target_os = "windows"))]
            {
                fs::rename(&tmp_path, &path)
                    .map_err(|e| format!("Failed to replace settings file: {}", e))
            }
        };

        // Clean up temp file on failure to avoid leaking temp files
        if replace_res.is_err() {
            let _ = fs::remove_file(&tmp_path);
        }
        
        replace_res
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settings_default_values() {
        let settings = Settings::default();
        assert_eq!(settings.shortcut, "Ctrl+Space");
        assert_eq!(settings.theme, "dark");
        assert!(!settings.autostart);
        assert!(settings.recent_apps.is_empty());
        assert!(settings.web_engines.contains_key("g"));
        assert_eq!(settings.web_engines["g"], "https://google.com/search?q={}");
    }

    #[test]
    fn test_settings_serialization_roundtrip() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings.shortcut, deserialized.shortcut);
        assert_eq!(settings.theme, deserialized.theme);
        assert_eq!(settings.autostart, deserialized.autostart);
        assert_eq!(settings.web_engines, deserialized.web_engines);
    }

    #[test]
    fn test_settings_deserialization_missing_fields() {
        // When fields are missing, serde defaults should fill them in
        let json = "{}";
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.shortcut, "Ctrl+Space");
        assert_eq!(settings.theme, "dark");
        assert!(!settings.autostart);
    }

    #[test]
    fn test_settings_deserialization_partial() {
        let json = "{\"shortcut\": \"Ctrl+Space\", \"theme\": \"light\"}";
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.shortcut, "Ctrl+Space");
        assert_eq!(settings.theme, "light");
        assert!(!settings.autostart);
        assert!(settings.web_engines.contains_key("g")); // defaults filled in
    }
}
