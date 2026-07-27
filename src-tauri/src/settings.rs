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
    #[serde(default = "default_glass_fps")]
    pub glass_fps: i32,
    #[serde(default = "default_strength")]
    pub strength: i32,
    #[serde(default = "default_chroma")]
    pub chroma: f64,
    #[serde(default = "default_squircle_n")]
    pub squircle_n: f64,
    #[serde(default = "default_search_height")]
    pub search_height: i32,
    #[serde(default = "default_search_offset")]
    pub search_offset: i32,
    #[serde(default = "default_results_height")]
    pub results_height: i32,

    // New Liquid Glass properties
    #[serde(default = "default_edge_hl")]
    pub edge_hl: f64,
    #[serde(default = "default_specular")]
    pub specular: f64,
    #[serde(default = "default_fresnel")]
    pub fresnel: f64,
    #[serde(default = "default_corner_radius")]
    pub corner_radius: f64,
    #[serde(default = "default_z_radius")]
    pub z_radius: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default = "default_shadow_opacity")]
    pub shadow_opacity: f64,
    #[serde(default = "default_shadow_spread")]
    pub shadow_spread: f64,
    #[serde(default = "default_distortion")]
    pub distortion: f64,
    #[serde(default = "default_saturation")]
    pub saturation: f64,
    #[serde(default = "default_brightness")]
    pub brightness: f64,
    #[serde(default = "default_tint_strength")]
    pub tint_strength: f64,
    #[serde(default = "default_bevel_mode")]
    pub bevel_mode: bool,
}

fn default_glass_blur() -> i32 {
    20
}
fn default_glass_fps() -> i32 {
    60
}
fn default_strength() -> i32 {
    28
}
fn default_chroma() -> f64 {
    0.05
}
fn default_squircle_n() -> f64 {
    4.5
}
fn default_search_height() -> i32 {
    46
}
fn default_search_offset() -> i32 {
    10
}
fn default_results_height() -> i32 {
    280
}

fn default_edge_hl() -> f64 {
    0.05
}
fn default_specular() -> f64 {
    0.50
}
fn default_fresnel() -> f64 {
    1.00
}
fn default_corner_radius() -> f64 {
    30.0
}
fn default_z_radius() -> f64 {
    100.0
}
fn default_opacity() -> f64 {
    1.00
}
fn default_shadow_opacity() -> f64 {
    0.00
}
fn default_shadow_spread() -> f64 {
    0.00
}
fn default_distortion() -> f64 {
    0.00
}
fn default_saturation() -> f64 {
    0.00
}
fn default_brightness() -> f64 {
    -0.20
}
fn default_tint_strength() -> f64 {
    0.20
}
fn default_bevel_mode() -> bool {
    false
}

impl Default for GlassSettings {
    fn default() -> Self {
        Self {
            glass_blur: default_glass_blur(),
            glass_fps: default_glass_fps(),
            strength: default_strength(),
            chroma: default_chroma(),
            squircle_n: default_squircle_n(),
            search_height: default_search_height(),
            search_offset: default_search_offset(),
            results_height: default_results_height(),
            edge_hl: default_edge_hl(),
            specular: default_specular(),
            fresnel: default_fresnel(),
            corner_radius: default_corner_radius(),
            z_radius: default_z_radius(),
            opacity: default_opacity(),
            shadow_opacity: default_shadow_opacity(),
            shadow_spread: default_shadow_spread(),
            distortion: default_distortion(),
            saturation: default_saturation(),
            brightness: default_brightness(),
            tint_strength: default_tint_strength(),
            bevel_mode: default_bevel_mode(),
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
    /// Extra directories scanned for portable apps / games (.exe), e.g. E:\galgame
    #[serde(default)]
    pub custom_app_dirs: Vec<String>,
    #[serde(default)]
    pub glass_settings: GlassSettings,
}

fn default_shortcut() -> String {
    "Ctrl+Alt+Space".to_string()
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_autostart() -> bool {
    false
}

fn default_web_engines() -> HashMap<String, String> {
    let mut web_engines = HashMap::new();
    web_engines.insert(
        "g".to_string(),
        "https://google.com/search?q={}".to_string(),
    );
    web_engines.insert("b".to_string(), "https://baidu.com/s?wd={}".to_string());
    web_engines.insert("bi".to_string(), "https://bing.com/search?q={}".to_string());
    web_engines.insert(
        "gh".to_string(),
        "https://github.com/search?q={}".to_string(),
    );
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
            custom_app_dirs: Vec::new(),
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
                if let Ok(mut settings) = serde_json::from_str::<Settings>(&content) {
                    settings.glass_settings.glass_fps =
                        settings.glass_settings.glass_fps.clamp(15, 60);
                    if settings.shortcut == "Shift+Q" {
                        settings.shortcut = default_shortcut();
                    }
                    // Older recordings stored "Control"; normalize to "Ctrl" for
                    // consistent display (both parse identically for registration).
                    if settings.shortcut.split('+').any(|p| p == "Control") {
                        settings.shortcut = settings
                            .shortcut
                            .split('+')
                            .map(|p| if p == "Control" { "Ctrl" } else { p })
                            .collect::<Vec<_>>()
                            .join("+");
                    }
                    return settings;
                }
            }
        }
    }
    Settings::default()
}

#[cfg(target_os = "windows")]
fn save_settings_win_atomic(
    from_path: &std::path::Path,
    to_path: &std::path::Path,
) -> Result<(), String> {
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
        assert_eq!(settings.shortcut, "Ctrl+Alt+Space");
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
        assert_eq!(settings.shortcut, "Ctrl+Alt+Space");
        assert_eq!(settings.theme, "dark");
        assert!(!settings.autostart);
    }

    #[test]
    fn test_settings_deserialization_partial() {
        let json = "{\"shortcut\": \"Ctrl+Alt+Space\", \"theme\": \"light\"}";
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.shortcut, "Ctrl+Alt+Space");
        assert_eq!(settings.theme, "light");
        assert!(!settings.autostart);
        assert!(settings.web_engines.contains_key("g")); // defaults filled in
    }
}
