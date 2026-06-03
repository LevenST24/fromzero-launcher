# FromZero Launcher — Project Source Code Audit (v0.1.4)

This document aggregates all production source code files of the **FromZero Launcher** project for security, performance, and stability review.

## 📋 Table of Contents
1. [Cargo.toml (Tauri Crate Configuration)](#1-cargotoml-tauri-crate-configuration)
2. [tauri.conf.json (Tauri Framework Settings)](#2-tauriconfjson-tauri-framework-settings)
3. [src-tauri/src/main.rs (Rust Entry Point)](#3-src-taurisrcmainrs-rust-entry-point)
4. [src-tauri/src/lib.rs (Rust Application Setup)](#4-src-taurisrclibrs-rust-application-setup)
5. [src-tauri/src/commands.rs (Rust IPC Bridge Commands)](#5-src-taurisrccommandsrs-rust-ipc-bridge-commands)
6. [src-tauri/src/settings.rs (Rust Atomic Config Serialization)](#6-src-taurisrcsettingsrs-rust-atomic-config-serialization)
7. [src-tauri/src/indexer.rs (Rust Background Scanner & Timeout Executer)](#7-src-taurisrcindexerrs-rust-background-scanner--timeout-executer)
8. [src/index.html (HTML Layout & Liquid Glass SVG Filters)](#8-srcindexhtml-html-layout--liquid-glass-svg-filters)
9. [src/styles.css (Vanilla CSS Liquid Glass Theme & Specular Highlight)](#9-srcstylescss-vanilla-css-liquid-glass-theme--specular-highlight)
10. [src/main.js (JS Frontend Orchestration & Idle Loop Blocker)](#10-srcmainjs-js-frontend-orchestration--idle-loop-blocker)

---

## 1. Cargo.toml (Tauri Crate Configuration)
```toml
[package]
name = "fromzero-launcher"
version = "0.1.4"
description = "A Tauri App"
authors = ["LevenST"]
edition = "2021"

# See more keys and their definitions at https://doc.rust-lang.org/cargo/reference/manifest.html

[lib]
# The `_lib` suffix may seem redundant but it is necessary
# to make the lib name unique and wouldn't conflict with the bin name.
# This seems to be only an issue on Windows, see https://github.com/rust-lang/cargo/issues/8519
name = "fromzero_launcher_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["protocol-asset", "tray-icon"] }
tauri-plugin-opener = "2"
tauri-plugin-autostart = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
window-vibrancy = "0.6.0"
pinyin = "0.10"
open = "5"
winapi = { version = "0.3.9", features = ["libloaderapi"] }

[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-global-shortcut = "2"
```

---

## 2. tauri.conf.json (Tauri Framework Settings)
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "fromzero-launcher",
  "version": "0.1.4",
  "identifier": "com.levenst.fromzero-launcher",
  "build": {
    "frontendDist": "../src"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "FromZero Launcher",
        "width": 640,
        "height": 450,
        "resizable": false,
        "decorations": false,
        "transparent": true,
        "shadow": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "visible": false,
        "center": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline';",
      "assetProtocol": {
        "enable": true,
        "scope": [
          "$APPCACHE/**"
        ]
      }
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

---

## 3. src-tauri/src/main.rs (Rust Entry Point)
```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fromzero_launcher_lib::run()
}
```

---

## 4. src-tauri/src/lib.rs (Rust Application Setup)
```rust
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
```

---

## 5. src-tauri/src/commands.rs (Rust IPC Bridge Commands)
```rust
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

#[tauri::command]
pub fn search_apps(query: String, state: State<'_, AppState>) -> Vec<AppItem> {
    let query_lower = query.to_lowercase().trim().to_string();
    
    // Lock and inspect cache directly to eliminate deep cloning on every keystroke
    let apps_cache = match state.apps.lock() {
        Ok(cache) => cache,
        Err(_) => return Vec::new(),
    };

    if query_lower.is_empty() {
        return apps_cache.clone();
    }

    let mut scored_apps = Vec::new();
    for app in apps_cache.iter() {
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
            scored_apps.push((score, app.clone())); // Clone only matched items
        }
    }

    // Sort by score (descending)
    scored_apps.sort_by(|a, b| b.0.cmp(&a.0));
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

#[tauri::command]
pub fn debug_log(_msg: String) {
    #[cfg(debug_assertions)]
    println!("[Frontend-Debug] {}", _msg);
}
```

---

## 6. src-tauri/src/settings.rs (Rust Atomic Config Serialization)
```rust
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
```

---

## 7. src-tauri/src/indexer.rs (Rust Background Scanner & Timeout Executer)
```rust
use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::thread;
use tauri::{AppHandle, Emitter};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppItem {
    pub name: String,
    pub path: String,
    pub target: String,
    pub pinyin_initials: String,
    pub pinyin_full: String,
    pub icon_path: String,
}

#[derive(Deserialize, Debug)]
struct RawAppItem {
    name: String,
    path: String,
    target: String,
}

pub fn get_pinyin(text: &str) -> (String, String) {
    let mut initials = String::new();
    let mut full = String::new();
    for c in text.chars() {
        if let Some(py) = c.to_pinyin() {
            let plain = py.plain();
            if let Some(first_char) = plain.chars().next() {
                initials.push(first_char);
            }
            full.push_str(plain);
        } else {
            let lower = c.to_ascii_lowercase();
            initials.push(lower);
            full.push(lower);
        }
    }
    (initials, full)
}

pub fn scan_start_menu(app_handle: &AppHandle) -> Vec<AppItem> {
    let mut apps = Vec::new();
    let mut seen_targets = HashSet::new();

    // PowerShell script to recursively query start menu and resolve all shortcut links safely using WScript.Shell COM
    let ps_command = r#"
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
        $OutputEncoding = [System.Text.Encoding]::UTF8;
        $sh = New-Object -ComObject WScript.Shell;
        $paths = @();
        if ($env:ProgramData) {
            $paths += Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs";
        } else {
            $paths += "C:\ProgramData\Microsoft\Windows\Start Menu\Programs";
        }
        if ($env:APPDATA) {
            $paths += Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs";
        }
        
        $results = Get-ChildItem -Path $paths -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $lnk = $sh.CreateShortcut($_.FullName);
                $target = $lnk.TargetPath;
                [PSCustomObject]@{
                    name = $_.BaseName;
                    path = $_.FullName;
                    target = if ([string]::IsNullOrEmpty($target)) { $_.FullName } else { $target }
                }
            } catch {}
        };
        if ($results) {
            $results | ConvertTo-Json -Compress
        } else {
            "[]"
        }
    "#;

    // Run powershell completely hidden without console flashing
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_command]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = run_command_with_timeout(cmd, std::time::Duration::from_secs(10));

    if let Ok(out) = output {
        let json_str = String::from_utf8_lossy(&out.stdout);
        let trimmed = json_str.trim();
        
        if !trimmed.is_empty() && trimmed != "[]" {
            // PowerShell might output a single object or an array. We handle both by attempting to parse as array first
            let raw_items: Vec<RawAppItem> = if trimmed.starts_with('[') {
                serde_json::from_str(trimmed).unwrap_or_default()
            } else {
                serde_json::from_str::<RawAppItem>(trimmed)
                    .map(|item| vec![item])
                    .unwrap_or_default()
            };

            let cache_dir = match app_handle.path().app_cache_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    eprintln!("[FromZero] Error: Failed to resolve cache directory: {e}");
                    return apps;
                }
            };
            let _ = fs::create_dir_all(&cache_dir);

            for item in raw_items {
                let name_lower = item.name.to_lowercase();
                
                // Skip uninstallers, help files, or empty entries
                if name_lower.contains("uninstall") 
                    || name_lower.contains("卸载") 
                    || name_lower.contains("help") 
                    || name_lower.contains("帮助") 
                    || item.name.trim().is_empty() 
                {
                    continue;
                }

                // Prevent duplicates pointing to the same target executable
                if seen_targets.contains(&item.target) {
                    continue;
                }
                seen_targets.insert(item.target.clone());

                // Generate safe cached icon path
                let icon_name = format!("{:x}.png", get_path_hash(&item.path));
                let mut icon_path = cache_dir.clone();
                icon_path.push("icons");
                let _ = fs::create_dir_all(&icon_path);
                icon_path.push(icon_name);
                let icon_path_str = icon_path.to_string_lossy().into_owned();

                let (initials, full) = get_pinyin(&item.name);

                apps.push(AppItem {
                    name: item.name,
                    path: item.path,
                    target: item.target,
                    pinyin_initials: initials,
                    pinyin_full: full,
                    icon_path: icon_path_str,
                });
            }
        }
    }

    apps
}

fn get_path_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[derive(Serialize, Deserialize)]
struct IconExtractionItem {
    target: String,
    icon_path: String,
    path: String,
}

pub fn trigger_icon_extraction(app_handle: AppHandle, apps: Vec<AppItem>) {
    thread::spawn(move || {
        let mut items_to_extract = Vec::new();
        for app in apps {
            let icon_path = Path::new(&app.icon_path);
            if icon_path.exists() {
                continue; // Already cached
            }

            let target_path = &app.target;
            let path = Path::new(target_path);
            if !path.is_file() {
                continue; // Only extract icons from files (skip folders to avoid PowerShell exceptions)
            }

            items_to_extract.push(IconExtractionItem {
                target: app.target.clone(),
                icon_path: app.icon_path.clone(),
                path: app.path.clone(),
            });
        }

        if items_to_extract.is_empty() {
            return;
        }

        let cache_dir = match app_handle.path().app_cache_dir() {
            Ok(dir) => dir,
            Err(e) => {
                eprintln!("[FromZero] Failed to resolve cache directory for icon extraction: {}", e);
                return;
            }
        };

        // Create temporary JSON file in cache folder to handle unlimited item counts safely without CLI args limits.
        // We use system time and thread ID to generate a unique filename, preventing race conditions from concurrent scans.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let thread_id = format!("{:?}", thread::current().id());
        let sanitized_thread_id: String = thread_id.chars().filter(|c| c.is_alphanumeric()).collect();
        let temp_json_path = cache_dir.join(format!("icon_targets_{}_{}.json", now, sanitized_thread_id));
        
        if let Ok(json_content) = serde_json::to_string(&items_to_extract) {
            if fs::write(&temp_json_path, json_content).is_ok() {
                #[cfg(target_os = "windows")]
                use std::os::windows::process::CommandExt;

                let mut cmd = std::process::Command::new("powershell");
                cmd.args([
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-WindowStyle", "Hidden",
                    "-Command",
                    "Add-Type -AssemblyName System.Drawing; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $items = Get-Content $env:TEMP_JSON_PATH -Raw -Encoding UTF8 | ConvertFrom-Json; foreach ($item in $items) { try { if ([System.IO.File]::Exists($item.target)) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($item.target); $bmp = $icon.ToBitmap(); $bmp.Save($item.icon_path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $icon.Dispose(); Write-Output $item.path; } } catch {} }"
                ]);
                cmd.env("TEMP_JSON_PATH", &temp_json_path);

                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

                if let Ok(output) = run_command_with_timeout(cmd, std::time::Duration::from_secs(15)) {
                    let out_str = String::from_utf8_lossy(&output.stdout);
                    for line in out_str.lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            let _ = app_handle.emit("icon-ready", trimmed.to_string());
                            // Pacing: Sleep 15ms between events to prevent choking the frontend JS thread with a massive sudden flood
                            std::thread::sleep(std::time::Duration::from_millis(15));
                        }
                    }
                }
            }
            // Clean up temporary JSON file
            let _ = fs::remove_file(&temp_json_path);
        }
    });
}

fn run_command_with_timeout(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::sync::mpsc;
    use std::thread;

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd.spawn()?;
    let child_id = child.id();
    let (tx, rx) = mpsc::channel();

    // Spawn waiter thread to wait for process exit and read its output
    thread::spawn(move || {
        let res = child.wait_with_output();
        let _ = tx.send(res);
    });

    // Wait for the channel with the specified timeout
    match rx.recv_timeout(timeout) {
        Ok(res) => res,
        Err(_) => {
            // Kill the process if it timed out or if the channel disconnected
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let mut kill_cmd = std::process::Command::new("taskkill");
                kill_cmd.args(["/F", "/PID", &child_id.to_string()]);
                kill_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                let _ = kill_cmd.status();
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Command timed out or channel disconnected",
            ))
        }
    }
}
```

---

## 8. src/index.html (HTML Layout & Liquid Glass SVG Filters)
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FromZero Launcher</title>
    <link rel="stylesheet" href="styles.css" />
    <script type="module" src="/main.js?v=1"></script>
  </head>

  <body>
    <!-- ============================================================
         TRUE LIQUID GLASS SVG FILTER SYSTEM
         Implements Apple-style liquid glass refraction using:
         1. feTurbulence → organic fractal noise map
         2. feGaussianBlur → smooths noise into broad glass-like warps
         3. feDisplacementMap → refracts backdrop through noise map
         4. feSpecularLighting → creates realistic light catch on glass surface
         5. feComposite → blends specular highlights with refracted image
         ============================================================ -->
    <svg class="svg-filters" style="position: absolute; width: 0; height: 0; pointer-events: none;" aria-hidden="true">
      <defs>
        <!-- Primary liquid glass refraction + specular highlight filter -->
        <filter id="liquid-glass" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
          <!-- Step 1: Generate organic fractal noise for glass surface imperfections -->
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="3" seed="8" result="noise" />
          
          <!-- Step 2: Smooth the noise to create broad, gentle glass surface undulations -->
          <feGaussianBlur in="noise" stdDeviation="6" result="smoothNoise" />
          
          <!-- Step 3: Displace the source through the smoothed noise → liquid refraction effect -->
          <feDisplacementMap in="SourceGraphic" in2="smoothNoise" scale="18" xChannelSelector="R" yChannelSelector="G" result="refracted" />
          
          <!-- Step 4: Apply gaussian blur for frosted glass depth -->
          <feGaussianBlur in="refracted" stdDeviation="12" result="blurredRefracted" />
          
          <!-- Step 5: Specular lighting on the noise creates light-catching glass surface highlights -->
          <feSpecularLighting in="smoothNoise" surfaceScale="2" specularConstant="0.6" specularExponent="25" lighting-color="#ffffff" result="specular">
            <fePointLight x="200" y="80" z="220" />
          </feSpecularLighting>
          
          <!-- Step 6: Clip specular to source alpha -->
          <feComposite in="specular" in2="SourceGraphic" operator="in" result="clippedSpecular" />
          
          <!-- Step 7: Blend the specular highlights over the blurred refracted backdrop -->
          <feBlend in="blurredRefracted" in2="clippedSpecular" mode="screen" />
        </filter>

        <!-- Lighter version for inner elements (search bar, cards) -->
        <filter id="liquid-glass-light" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.015 0.02" numOctaves="2" seed="12" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="4" result="smoothNoise" />
          <feDisplacementMap in="SourceGraphic" in2="smoothNoise" scale="8" xChannelSelector="R" yChannelSelector="G" result="refracted" />
          <feGaussianBlur in="refracted" stdDeviation="8" result="blurred" />
          <feSpecularLighting in="smoothNoise" surfaceScale="1.5" specularConstant="0.4" specularExponent="30" lighting-color="#ffffff" result="specular">
            <fePointLight x="150" y="60" z="180" />
          </feSpecularLighting>
          <feComposite in="specular" in2="SourceGraphic" operator="in" result="clippedSpecular" />
          <feBlend in="blurred" in2="clippedSpecular" mode="screen" />
        </filter>
      </defs>
    </svg>

    <div class="launcher-container" id="launcher-container">
      <!-- Subtle ambient color layer (static, no animation) -->
      <div class="liquid-bg">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
        <div class="orb orb-4"></div>
      </div>

      <!-- TRUE Liquid Glass Layer — applies SVG refraction filter as backdrop-filter -->
      <div class="glass-blur-layer"></div>

      <!-- Specular highlight that follows cursor for light-catching effect -->
      <div class="specular-highlight"></div>

      <!-- 搜索输入区域 -->
      <header class="search-bar">
        <span class="search-icon" id="search-indicator">🔍</span>
        <div class="search-input-wrapper">
          <input
            type="text"
            id="search-input"
            class="search-input"
            placeholder="搜索应用、系统命令... 或输入 'g 搜索词'，'b 搜索词'"
            autocomplete="off"
            spellcheck="false"
            autofocus
          />
        </div>
        <button class="settings-btn" id="settings-toggle" title="设置 (Ctrl+,)">
          ⚙️
        </button>
      </header>

      <!-- 搜索结果/快捷展示区域 -->
      <main class="results-area" id="results-area">
        <!-- 默认空状态显示最近使用 -->
        <div class="welcome-screen" id="welcome-screen">
          <h2 class="welcome-title">常用应用</h2>
          <div class="recent-grid" id="recent-grid">
            <!-- 由 JS 动态渲染 -->
          </div>
        </div>

        <!-- 结果列表，由 JS 动态渲染 -->
        <div id="results-list" style="display: none;"></div>
      </main>

      <!-- 底部状态指示栏 -->
      <footer class="footer">
        <div class="footer-status" id="footer-status">已加载 0 个应用</div>
        <div class="footer-shortcuts">
          <span><span class="key-badge">↑↓</span> 选择</span>
          <span><span class="key-badge">Enter</span> 打开</span>
          <span><span class="key-badge">Esc</span> 隐藏</span>
        </div>
      </footer>

      <!-- 设置悬浮面板 -->
      <div class="modal-overlay" id="settings-overlay">
        <div class="settings-modal">
          <div class="modal-header">
            <h3 class="modal-title">FromZero Launcher 设置</h3>
            <button class="modal-close" id="settings-close">✕</button>
          </div>

          <!-- 自定义快捷键录制 -->
          <div class="settings-group">
            <label class="settings-label">全局唤起快捷键</label>
            <div class="shortcut-recorder">
              <span class="shortcut-text" id="shortcut-display">Alt+Space</span>
              <button class="record-btn" id="record-btn">录制组合键</button>
            </div>
          </div>

          <!-- 主题切换 -->
          <div class="settings-group">
            <label class="settings-label">视觉主题</label>
            <select class="settings-select" id="theme-select">
              <option value="dark">极简暗黑 (Dark)</option>
              <option value="light">清透高雅 (Light)</option>
            </select>
          </div>

          <!-- 开机自启动 -->
          <div class="settings-group" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
            <label class="settings-label" style="margin-bottom: 0; text-transform: uppercase; letter-spacing: 0.5px;">开机自启动</label>
            <label class="switch">
              <input type="checkbox" id="autostart-toggle" />
              <span class="slider"></span>
            </label>
          </div>

          <!-- 网页搜索配置 -->
          <div class="settings-group">
            <label class="settings-label">搜索引擎前缀</label>
            <input
              type="text"
              class="settings-input"
              style="font-family: var(--font-mono); font-size: 12px; margin-bottom: 6px;"
              value="g : Google | b : 百度 | bi : Bing | gh : GitHub"
              disabled
            />
          </div>

          <div class="modal-actions">
            <button class="btn btn-secondary" id="settings-cancel">取消</button>
            <button class="btn btn-primary" id="settings-save">保存配置</button>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
```

---

## 9. src/styles.css (Vanilla CSS Liquid Glass Theme & Specular Highlight)
```css
/* ============================================================
   FromZero Launcher — True Frosted Glass Design
   ============================================================
   Uses system fonts only — zero network, lower memory.
   Background opacity is INTENTIONALLY very low (≤25%) so that
   the native Acrylic / CSS backdrop-filter blur is clearly
   visible through the surface.
   ============================================================ */

:root {
  /* ── Glass Surface Colors ──
   * TRUE LIQUID GLASS: bg opacity must be very low so SVG
   * refraction filter can show through. */
  --glass-bg: rgba(13, 15, 28, 0.25);
  --glass-surface: rgba(255, 255, 255, 0.06);
  --glass-hover: rgba(255, 255, 255, 0.10);
  --glass-selected: rgba(108, 143, 255, 0.20);
  --glass-card: rgba(255, 255, 255, 0.04);
  --glass-card-hover: rgba(255, 255, 255, 0.08);
  --glass-input: rgba(0, 0, 0, 0.12);

  /* ── Accent ── */
  --accent: #6C8FFF;
  --accent-dim: rgba(108, 143, 255, 0.8);
  --accent-glow: rgba(108, 143, 255, 0.35);
  --accent-gradient: linear-gradient(135deg, #6C8FFF, #A78BFA);

  /* ── Text ── */
  --text-primary: rgba(255, 255, 255, 0.96);
  --text-secondary: rgba(255, 255, 255, 0.80);
  --text-dim: rgba(255, 255, 255, 0.52);

  /* ── Borders ── */
  --border: rgba(255, 255, 255, 0.08);
  --border-light: rgba(255, 255, 255, 0.14);
  --border-focus: rgba(108, 143, 255, 0.50);

  /* ── Shadows ── */
  --shadow-window: 0 8px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0 20px rgba(255, 255, 255, 0.02);
  --shadow-card: 0 1px 4px rgba(0, 0, 0, 0.12);

  /* ── Typography ── */
  --font-sans: 'Segoe UI Variable Display', 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif;
  --font-mono: 'Cascadia Code', 'Cascadia Mono', Consolas, monospace;

  /* ── Motion ── */
  --ease-smooth: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* ── Light Theme ── */
[data-theme="light"] {
  --glass-bg: rgba(255, 255, 255, 0.20);
  --glass-surface: rgba(255, 255, 255, 0.50);
  --glass-hover: rgba(0, 0, 0, 0.05);
  --glass-selected: rgba(74, 114, 255, 0.15);
  --glass-card: rgba(255, 255, 255, 0.35);
  --glass-card-hover: rgba(255, 255, 255, 0.50);
  --glass-input: rgba(0, 0, 0, 0.04);
  --accent: #4A72FF;
  --accent-glow: rgba(74, 114, 255, 0.20);
  --text-primary: rgba(0, 0, 0, 0.90);
  --text-secondary: rgba(0, 0, 0, 0.72);
  --text-dim: rgba(0, 0, 0, 0.45);
  --border: rgba(0, 0, 0, 0.06);
  --border-light: rgba(0, 0, 0, 0.10);
  --shadow-window: 0 8px 32px rgba(0, 0, 0, 0.12);
}

/* ── Reset ── */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  -webkit-user-select: none;
  user-select: none;
}

body {
  font-family: var(--font-sans);
  background: transparent;
  color: var(--text-primary);
  overflow: hidden;
  height: 100vh;
  width: 100vw;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8px;
  -webkit-font-smoothing: antialiased;
}

/* ============================================================
   LIQUID GLASS — AMBIENT COLOR LAYER
   Subtle static colored orbs provide depth and warmth.
   NO animation, NO motion — purely ambient.
   ============================================================ */
.liquid-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
  
  /* Apply the liquid glass SVG refraction filter to the ambient color layer.
     This creates organic glass-like distortion on the colored orbs.
     Using regular filter (not backdrop-filter) since Chromium doesn't
     support backdrop-filter: url() for SVG filter references. */
  filter: url(#liquid-glass);
  -webkit-filter: url(#liquid-glass);
}

.orb {
  position: absolute;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.18;
  /* completely static — zero animation */
}

.orb-1 {
  background: radial-gradient(circle, rgba(99, 102, 241, 0.6) 0%, transparent 70%);
  left: -100px;
  top: -100px;
}

.orb-2 {
  background: radial-gradient(circle, rgba(244, 63, 94, 0.5) 0%, transparent 70%);
  right: -100px;
  bottom: -100px;
}

.orb-3 {
  background: radial-gradient(circle, rgba(20, 184, 166, 0.35) 0%, transparent 70%);
  right: -60px;
  top: -60px;
}

.orb-4 {
  background: radial-gradient(circle, rgba(139, 92, 246, 0.45) 0%, transparent 70%);
  left: -60px;
  bottom: -60px;
}

[data-theme="light"] .orb { opacity: 0.12; }
[data-theme="light"] .orb-1 { background: radial-gradient(circle, rgba(165, 180, 252, 0.4) 0%, transparent 70%); }
[data-theme="light"] .orb-2 { background: radial-gradient(circle, rgba(251, 113, 133, 0.3) 0%, transparent 70%); }
[data-theme="light"] .orb-3 { background: radial-gradient(circle, rgba(153, 246, 228, 0.3) 0%, transparent 70%); }
[data-theme="light"] .orb-4 { background: radial-gradient(circle, rgba(196, 181, 253, 0.3) 0%, transparent 70%); }

/* ============================================================
   MAIN GLASS CONTAINER — TRUE LIQUID GLASS
   ============================================================
   Uses SVG filter (backdrop-filter: url(#liquid-glass)) for:
   - Real refraction through fractal noise displacement
   - Specular lighting highlights on glass surface
   - Deep frosted blur with organic warping
   NO grey borders. Nearly invisible container edge.
   ============================================================ */
.launcher-container {
  width: 620px;
  height: 434px;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  background: transparent;

  /* Ultra-subtle glass edge — nearly invisible */
  border: 1px solid rgba(255, 255, 255, 0.12);

  /* Beveled glass depth via inset shadows */
  box-shadow:
    0 8px 40px rgba(0, 0, 0, 0.25),
    0 0 0 0.5px rgba(255, 255, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.30),
    inset 0 -1px 0 rgba(0, 0, 0, 0.15);

  animation: glassIn 0.28s var(--ease-smooth);
}

/* ── FROSTED GLASS LAYER ──
   Standard CSS backdrop-filter blur for frosted glass effect.
   The SVG liquid refraction is on .liquid-bg below; this layer
   adds the frosted/milky quality and slight saturation boost. */
.glass-blur-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  
  /* Semi-transparent tint */
  background: var(--glass-bg);
  
  /* Standard frosted glass blur */
  backdrop-filter: blur(24px) saturate(180%) brightness(105%);
  -webkit-backdrop-filter: blur(24px) saturate(180%) brightness(105%);
}

/* Cursor-following specular highlight for light-catching effect */
.specular-highlight {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  border-radius: inherit;
  
  background: radial-gradient(
    circle 200px at var(--mx, -999px) var(--my, -999px),
    rgba(255, 255, 255, 0.12) 0%,
    rgba(255, 255, 255, 0) 75%
  );
  mix-blend-mode: overlay;
  transition: opacity 0.5s ease;
}

/* Subtle sweeping light across glass surface */
.launcher-container::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(255,255,255,0) 30%,
    rgba(255,255,255,0.04) 50%,
    rgba(255,255,255,0) 70%
  );
  background-size: 200% 200%;
  animation: glassReflection 20s infinite linear;
  pointer-events: none;
  z-index: 3;
  border-radius: inherit;
}

/* Disable expensive SVG filter and reflection animations when blurred/hidden to guarantee 0% idle GPU/CPU usage */
.launcher-container.blurred .liquid-bg {
  filter: none !important;
  -webkit-filter: none !important;
}

.launcher-container.blurred::after {
  animation: none !important;
}

[data-theme="light"] .launcher-container {
  border: 1px solid rgba(255, 255, 255, 0.25);
  box-shadow:
    0 8px 40px rgba(0, 0, 0, 0.10),
    0 0 0 0.5px rgba(255, 255, 255, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.50),
    inset 0 -1px 0 rgba(0, 0, 0, 0.04);
}

[data-theme="light"] .glass-blur-layer {
  backdrop-filter: blur(24px) saturate(160%) brightness(102%);
  -webkit-backdrop-filter: blur(24px) saturate(160%) brightness(102%);
}

[data-theme="light"] .specular-highlight {
  background: radial-gradient(
    circle 200px at var(--mx, -999px) var(--my, -999px),
    rgba(255, 255, 255, 0.08) 0%,
    rgba(255, 255, 255, 0) 75%
  );
}

@keyframes glassReflection {
  0% { background-position: -200% -200%; }
  100% { background-position: 200% 200%; }
}

@keyframes glassIn {
  0% {
    transform: scale(0.95) translateY(10px);
    opacity: 0;
  }
  100% {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}

/* ============================================================
   SEARCH BAR
   ============================================================ */
.search-bar {
  display: flex;
  align-items: center;
  margin: 16px 16px 8px;
  padding: 12px 18px;
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 24px;
  gap: 12px;
  position: relative;
  z-index: 5;
  
  /* Frosted glass inner element blur */
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  
  box-shadow: 
    0 4px 12px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.20);
    
  transition: all 0.28s var(--ease-smooth);
}

.search-bar:focus-within {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(108, 143, 255, 0.40);
  box-shadow: 
    0 4px 20px rgba(108, 143, 255, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.30);
}

[data-theme="light"] .search-bar {
  background: rgba(255, 255, 255, 0.40);
  border: 1px solid rgba(255, 255, 255, 0.30);
  box-shadow: 
    0 4px 12px rgba(0, 0, 0, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.50);
}

[data-theme="light"] .search-bar:focus-within {
  background: rgba(255, 255, 255, 0.55);
  border-color: rgba(74, 114, 255, 0.40);
  box-shadow: 
    0 4px 20px rgba(74, 114, 255, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.60);
}

.search-icon {
  font-size: 18px;
  color: var(--text-secondary);
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  transition: transform 0.3s var(--ease-smooth), filter 0.3s;
}

.search-bar:focus-within .search-icon {
  filter: drop-shadow(0 0 8px var(--accent-glow));
  transform: scale(1.08);
}

.search-input-wrapper {
  flex: 1;
}

.search-input {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 400;
  color: var(--text-primary);
  caret-color: var(--accent);
  letter-spacing: 0.01em;
}

.search-input::placeholder {
  color: var(--text-dim);
  font-weight: 300;
}

.settings-btn {
  background: transparent;
  border: none;
  outline: none;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 14px;
  flex-shrink: 0;
  transition: all 0.25s var(--ease-smooth);
}

.settings-btn:hover {
  background: var(--glass-hover);
  color: var(--text-secondary);
  transform: rotate(30deg) scale(1.1);
}

/* ============================================================
   RESULTS AREA
   ============================================================ */
.results-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 16px 12px; /* Perfect floating margins */
  z-index: 5;
  position: relative;
}

.results-area::-webkit-scrollbar { width: 4px; }
.results-area::-webkit-scrollbar-track { background: transparent; }
.results-area::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.10);
  border-radius: 10px;
}
.results-area::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.20);
}

/* ── Welcome / Recent ── */
.welcome-screen {
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 14px;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.08),
    0 4px 16px rgba(0, 0, 0, 0.08);
}

[data-theme="light"] .welcome-screen {
  background: rgba(255, 255, 255, 0.25);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.40),
    0 4px 16px rgba(0, 0, 0, 0.04);
}

.welcome-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text-dim);
  margin-bottom: 12px;
  padding-left: 4px;
  text-shadow: 
    0.4px 0 0.2px rgba(255, 60, 60, 0.12), 
    -0.4px 0 0.2px rgba(60, 120, 255, 0.12);
}

/* ── Frosted Glass Cards ── */
.recent-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.recent-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 6px 10px;
  text-align: center;
  cursor: pointer;
  position: relative;
  overflow: hidden;

  /* Glass card effect with white tint */
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 10px;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.12);

  transition: all 0.22s var(--ease-smooth);
}

[data-theme="light"] .recent-card {
  background: rgba(255, 255, 255, 0.30);
  border-color: rgba(255, 255, 255, 0.20);
}

.recent-card:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.18);
  transform: translateY(-2px);
  box-shadow: 
    0 6px 20px rgba(108, 143, 255, 0.15), 
    inset 0 1px 1px rgba(255, 255, 255, 0.20);
}

[data-theme="light"] .recent-card:hover {
  background: rgba(255, 255, 255, 0.50);
  border-color: rgba(255, 255, 255, 0.25);
}

.recent-card:active {
  transform: translateY(0) scale(0.97);
}

.recent-icon {
  width: 30px;
  height: 30px;
  margin-bottom: 8px;
  object-fit: contain;
}

.recent-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  line-height: 1.3;
}

/* ============================================================
   RESULT LIST ITEMS
   ============================================================ */
/* Results list parent window overlay wrapper */
#results-list {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 14px;
  padding: 8px;
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.08),
    0 4px 16px rgba(0, 0, 0, 0.08);
}

[data-theme="light"] #results-list {
  background: rgba(255, 255, 255, 0.25);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: 
    inset 0 1px 1px rgba(255, 255, 255, 0.40),
    0 4px 16px rgba(0, 0, 0, 0.04);
}

.result-item {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 4px;
  border: 1px solid rgba(255, 255, 255, 0.04);
  position: relative;
  transition: all 0.18s var(--ease-smooth);
  animation: itemSlide 0.2s var(--ease-smooth) both;
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

[data-theme="light"] .result-item {
  background: rgba(255, 255, 255, 0.20);
  border-color: rgba(0, 0, 0, 0.03);
}

[data-theme="light"] .result-item:hover {
  background: rgba(255, 255, 255, 0.35);
}

.result-item.selected {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(108, 143, 255, 0.35);
  box-shadow: 
    0 4px 16px rgba(108, 143, 255, 0.15),
    inset 0 1px 1px rgba(255, 255, 255, 0.20);
}

[data-theme="light"] .result-item.selected {
  background: rgba(74, 114, 255, 0.12);
  border-color: rgba(74, 114, 255, 0.25);
}

.result-item:nth-child(1) { animation-delay: 0ms; }
.result-item:nth-child(2) { animation-delay: 25ms; }
.result-item:nth-child(3) { animation-delay: 50ms; }
.result-item:nth-child(4) { animation-delay: 75ms; }
.result-item:nth-child(5) { animation-delay: 100ms; }
.result-item:nth-child(6) { animation-delay: 125ms; }
.result-item:nth-child(7) { animation-delay: 150ms; }
.result-item:nth-child(8) { animation-delay: 175ms; }

@keyframes itemSlide {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Accent indicator on selected item */
.result-item.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  background: var(--accent-gradient);
  border-radius: 0 3px 3px 0;
  animation: barGrow 0.2s var(--ease-spring);
}

@keyframes barGrow {
  from { height: 0; opacity: 0; }
  to { height: 16px; opacity: 1; }
}

.result-icon-wrapper {
  margin-right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
}

.result-icon {
  width: 26px;
  height: 26px;
  object-fit: contain;
  border-radius: 4px;
}

.result-icon.emoji {
  font-size: 20px;
  width: auto;
  height: auto;
  line-height: 1;
}

.result-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}

.result-title {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 
    0.4px 0 0.2px rgba(255, 60, 60, 0.15), 
    -0.4px 0 0.2px rgba(60, 120, 255, 0.15);
}

.result-subtitle {
  font-size: 10.5px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--glass-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
  margin-left: 8px;
}

.result-action {
  font-size: 11px;
  color: var(--accent-dim);
  font-weight: 600;
  margin-left: 10px;
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.2s;
}

.result-item.selected .result-action {
  opacity: 1;
  transform: translateX(0);
}

/* ============================================================
   FOOTER
   ============================================================ */
.footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 18px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  z-index: 5;
  position: relative;
}

[data-theme="light"] .footer {
  background: rgba(255, 255, 255, 0.05);
  border-top: 1px solid rgba(255, 255, 255, 0.10);
}

.footer-shortcuts {
  display: flex;
  gap: 10px;
}

.key-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--glass-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text-secondary);
}

/* ============================================================
   SETTINGS MODAL (frosted glass overlay)
   ============================================================ */
.modal-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.30);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  display: none;
  justify-content: center;
  align-items: center;
  z-index: 100;
  border-radius: inherit;
}

.modal-overlay.active {
  display: flex;
  animation: fadeIn 0.18s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.settings-modal {
  width: 430px;
  background: rgba(28, 28, 36, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-top: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 14px;
  box-shadow: 
    0 24px 64px rgba(0, 0, 0, 0.50),
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    inset 0 -1px 0 rgba(255, 255, 255, 0.08);
  padding: 22px;
  display: flex;
  flex-direction: column;
  animation: modalIn 0.25s var(--ease-spring);
}

[data-theme="light"] .settings-modal {
  background: rgba(250, 250, 254, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.40);
  border-top: 1px solid rgba(255, 255, 255, 0.65);
  box-shadow: 
    0 24px 64px rgba(0, 0, 0, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.60),
    inset 0 -1px 0 rgba(0, 0, 0, 0.04);
}

@keyframes modalIn {
  from { transform: scale(0.92) translateY(16px); opacity: 0; }
  to { transform: scale(1) translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
}

.modal-close {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 16px;
  padding: 4px;
  border-radius: 6px;
  transition: all 0.2s;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary);
  background: var(--glass-hover);
}

.settings-group { margin-bottom: 14px; }

.settings-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  display: block;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.settings-input {
  width: 100%;
  background: var(--glass-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}

.settings-input:focus { border-color: var(--border-focus); }

.shortcut-recorder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--glass-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
}

.shortcut-text {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
}

.record-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.record-btn:hover { opacity: 0.85; }

.record-btn.recording {
  background: #f43f5e;
  animation: recordPulse 1s infinite alternate;
}

@keyframes recordPulse {
  from { opacity: 1; box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.4); }
  to { opacity: 0.75; box-shadow: 0 0 0 6px rgba(244, 63, 94, 0); }
}

.settings-select {
  width: 100%;
  background: var(--glass-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--text-primary);
  outline: none;
  font-family: var(--font-sans);
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.btn {
  border: none;
  padding: 8px 16px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: all 0.2s;
}

.btn-secondary {
  background: var(--glass-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover { background: var(--glass-hover); }

.btn-primary {
  background: var(--accent-gradient);
  color: white;
}

.btn-primary:hover {
  opacity: 0.88;
  transform: translateY(-1px);
  box-shadow: 0 0 16px var(--accent-glow);
}

/* ============================================================
   PREMIUM FLUENT SWITCH TOGGLE
   ============================================================ */
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 255, 255, 0.12);
  transition: 0.28s var(--ease-smooth);
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

[data-theme="light"] .slider {
  background-color: rgba(0, 0, 0, 0.08);
  border-color: rgba(0, 0, 0, 0.05);
}

.slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background-color: #ffffff;
  transition: 0.28s var(--ease-smooth);
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

[data-theme="light"] .slider:before {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

input:checked + .slider {
  background-color: var(--accent);
  border-color: rgba(255, 255, 255, 0.15);
}

[data-theme="light"] input:checked + .slider {
  border-color: rgba(0, 0, 0, 0.08);
}

input:checked + .slider:before {
  transform: translate3d(20px, 0, 0);
}
```

---

## 10. src/main.js (JS Frontend Orchestration & Idle Loop Blocker)
```javascript
// === FromZero Launcher — Main Frontend Logic ===

// App state variables
let appItems = [];
let filteredItems = [];
let selectedIndex = 0;
let settings = { shortcut: "Alt+Space", theme: "dark", web_engines: {}, recent_apps: [], autostart: false };

// Search debounce and query race condition tracking
let lastSearchId = 0;
let searchDebounceTimeout = null;

// Focus management: timestamp of last show (for debounce)
let lastShowTime = 0;

// IME Composition state tracking
let isComposing = false;

// DOM Elements
const searchInput = document.getElementById("search-input");
const searchIndicator = document.getElementById("search-indicator");
const resultsArea = document.getElementById("results-area");
const welcomeScreen = document.getElementById("welcome-screen");
const recentGrid = document.getElementById("recent-grid");
const resultsList = document.getElementById("results-list");
const footerStatus = document.getElementById("footer-status");

// Settings Modal DOM Elements
const settingsToggle = document.getElementById("settings-toggle");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave = document.getElementById("settings-save");
const shortcutDisplay = document.getElementById("shortcut-display");
const recordBtn = document.getElementById("record-btn");
const themeSelect = document.getElementById("theme-select");
const autostartToggle = document.getElementById("autostart-toggle");

// System commands helper list
const SYSTEM_COMMANDS = [
  { key: "lock", name: "锁定屏幕 (Lock Screen)", desc: "锁定当前的 Windows 会话", badge: "系统" },
  { key: "sleep", name: "休眠系统 (Sleep)", desc: "使计算机进入低功耗睡眠状态", badge: "系统" },
  { key: "shutdown", name: "关闭计算机 (Shutdown)", desc: "关闭电源并退出所有应用", badge: "警告" },
  { key: "restart", name: "重启计算机 (Restart)", desc: "重新启动操作系统", badge: "系统" }
];

// =============================================
// Tauri Core APIs Wrapper with Safety Guards
// =============================================
let invoke = null;
let appWindow = null;
let isMock = false;

// Animation loop state
let springAnimationId = null;
let startSprings = null;
let stopSprings = null;

function ensureTauri() {
  if (window.__TAURI__) {
    if (isMock || !invoke || !appWindow) {
      invoke = window.__TAURI__.core.invoke;
      appWindow = window.__TAURI__.window.getCurrentWindow();
      isMock = false;
    }
  } else if (!invoke || !appWindow) {
    console.warn("[FromZero] __TAURI__ not found, setting up fallback mocks");
    isMock = true;
    invoke = async (cmd, args) => {
      console.log(`[Mock Invoke] ${cmd}`, args);
      if (cmd === "get_settings") {
        return { shortcut: "Alt+Space", theme: "dark", web_engines: { g: "https://google.com/search?q={}" }, recent_apps: [], autostart: false };
      }
      if (cmd === "scan_apps") return [];
      if (cmd === "search_apps") return [];
      return {};
    };
    appWindow = {
      hide: async () => console.log("[Mock AppWindow] hide"),
      show: async () => console.log("[Mock AppWindow] show"),
      setFocus: async () => console.log("[Mock AppWindow] setFocus"),
      listen: (event, callback) => {
        console.log(`[Mock AppWindow] listen for ${event}`);
        return () => {};
      }
    };
  }
}

ensureTauri();

// =============================================
// Window Focus/Blur Management (JS-side with debounce)
// =============================================

window.addEventListener("focus", () => {
  lastShowTime = Date.now();
  if (startSprings) startSprings();
  const container = document.getElementById("launcher-container");
  if (container) container.classList.remove("blurred");
  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
    }
  }, 50);
});

window.addEventListener("blur", () => {
  if (stopSprings) stopSprings();
  const container = document.getElementById("launcher-container");
  if (container) container.classList.add("blurred");
  
  const timeSinceShow = Date.now() - lastShowTime;
  if (timeSinceShow < 300) {
    return;
  }
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    return;
  }
  setTimeout(async () => {
    if (!document.hasFocus()) {
      try {
        ensureTauri();
        await appWindow.hide();
      } catch (e) {
        console.warn("[FromZero] Failed to hide window:", e);
      }
    }
  }, 120);
});

// =============================================
// Initialize application
// =============================================
window.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("[FromZero] Initializing...");
    lastShowTime = Date.now();
    ensureTauri();

    try {
      const loaded = await invoke("get_settings");
      settings = { ...settings, ...loaded };
      settings.recent_apps = settings.recent_apps || [];
      settings.web_engines = settings.web_engines || {};
    } catch (e) {
      console.error("[FromZero] Failed to load settings, using default:", e);
    }

    applyTheme(settings.theme);
    if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Alt+Space";
    if (themeSelect) themeSelect.value = settings.theme || "dark";

    if (footerStatus) footerStatus.textContent = "正在扫描开始菜单...";
    try {
      appItems = await invoke("scan_apps");
      if (footerStatus) footerStatus.textContent = `已成功加载 ${appItems.length} 个应用`;
      console.log(`[FromZero] Loaded ${appItems.length} apps`);
    } catch (scanError) {
      console.error("[FromZero] Scan error:", scanError);
      if (footerStatus) footerStatus.textContent = "应用扫描失败，请检查日志";
    }

    renderRecentApps();

    if (searchInput) searchInput.focus();

    if (searchInput) {
      searchInput.addEventListener("compositionstart", () => {
        isComposing = true;
      });
      searchInput.addEventListener("compositionend", () => {
        isComposing = false;
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          searchDebounceTimeout = null;
          handleSearch();
        }, 100);
      });
      searchInput.addEventListener("input", () => {
        if (isComposing) return;
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          searchDebounceTimeout = null;
          handleSearch();
        }, 100);
      });
    }

    window.addEventListener("keydown", handleGlobalKeys);

    if (settingsToggle) settingsToggle.addEventListener("click", openSettings);
    if (settingsClose) settingsClose.addEventListener("click", closeSettings);
    if (settingsCancel) settingsCancel.addEventListener("click", closeSettings);
    if (settingsSave) settingsSave.addEventListener("click", saveSettingsConfig);

    if (recordBtn) recordBtn.addEventListener("click", toggleRecordingShortcut);

    // =============================================
    // Specular Highlight — cursor-following light spot (Liquid Glass)
    // NO refractive drift / NO wave effect
    // =============================================
    const container = document.getElementById("launcher-container");
    if (container) {
      // Spring state for specular highlight only
      let targetMouseX = 0;
      let targetMouseY = 0;
      let isHovered = false;

      // Specular Highlight Spring (snappy light reflection)
      let shX = -999, shY = -999;
      let shVx = 0, shVy = 0;
      const shStiffness = 0.12;
      const shDamping = 0.16;
      let isSpringRunning = false;

      function updateSprings() {
        if (!document.getElementById("launcher-container")) {
          springAnimationId = null;
          isSpringRunning = false;
          return;
        }

        let targetShX = -999;
        let targetShY = -999;

        if (isHovered) {
          targetShX = targetMouseX;
          targetShY = targetMouseY;
        }

        let needsUpdate = false;

        // Update Specular Highlight Spring only
        if (targetShX === -999) {
          if (shX !== -999) {
            shX = -999;
            shY = -999;
            shVx = 0;
            shVy = 0;
            needsUpdate = true; // One final frame to write offscreen variables
          }
        } else {
          if (shX === -999) { shX = targetShX; shY = targetShY; }
          const dx = targetShX - shX;
          const dy = targetShY - shY;
          
          // Only animate if the spring has not settled
          if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(shVx) > 0.05 || Math.abs(shVy) > 0.05) {
            const ax = dx * shStiffness;
            const ay = dy * shStiffness;
            shVx = (shVx + ax) * (1 - shDamping);
            shVy = (shVy + ay) * (1 - shDamping);
            shX += shVx;
            shY += shVy;
            needsUpdate = true;
          } else {
            // Settle exactly to target coordinates
            shX = targetShX;
            shY = targetShY;
            shVx = 0;
            shVy = 0;
          }
        }

        // Render CSS coordinates for specular highlight
        if (shX === -999) {
          container.style.setProperty("--mx", `-999px`);
          container.style.setProperty("--my", `-999px`);
        } else {
          container.style.setProperty("--mx", `${shX}px`);
          container.style.setProperty("--my", `${shY}px`);
        }

        if (needsUpdate) {
          springAnimationId = requestAnimationFrame(updateSprings);
        } else {
          springAnimationId = null;
          isSpringRunning = false;
        }
      }

      startSprings = () => {
        if (!springAnimationId) {
          isSpringRunning = true;
          springAnimationId = requestAnimationFrame(updateSprings);
        }
      };

      stopSprings = () => {
        if (springAnimationId) {
          cancelAnimationFrame(springAnimationId);
          springAnimationId = null;
        }
      };

      // Start the animation loop
      startSprings();

      container.addEventListener("mouseenter", () => {
        isHovered = true;
      });

      container.addEventListener("mousemove", (e) => {
        const rect = container.getBoundingClientRect();
        targetMouseX = e.clientX - rect.left;
        targetMouseY = e.clientY - rect.top;
        isHovered = true;
        if (!isSpringRunning) {
          startSprings();
        }
      });

      container.addEventListener("mouseleave", () => {
        isHovered = false;
      });
    }

    if (window.__TAURI__) {
      appWindow.listen("tauri://focus", () => {
        lastShowTime = Date.now();
        if (searchInput) searchInput.focus();
        if (startSprings) startSprings();
        const container = document.getElementById("launcher-container");
        if (container) container.classList.remove("blurred");
      });

      appWindow.listen("tauri://blur", () => {
        if (stopSprings) stopSprings();
        const container = document.getElementById("launcher-container");
        if (container) container.classList.add("blurred");
      });

      if (window.__TAURI__.event?.listen) {
        window.__TAURI__.event.listen("icon-ready", (event) => {
          const appPath = event.payload;
          const recentCard = Array.from(document.querySelectorAll(".recent-card"))
            .find(card => card.getAttribute("data-app-path") === appPath);
          const app = appItems.find(a => a.path === appPath);
          if (recentCard && app) {
            const existingIcon = recentCard.querySelector(".recent-icon");
            if (existingIcon) {
              const newIcon = createIconElement(app.icon_path, "recent-icon");
              recentCard.replaceChild(newIcon, existingIcon);
            }
          }
          const resultIcons = document.querySelectorAll(".result-icon");
          resultIcons.forEach((el) => {
            if (el.getAttribute("data-app-path") === appPath) {
              const app = appItems.find(a => a.path === appPath);
              if (app && app.icon_path) {
                const newIcon = createIconElement(app.icon_path, "result-icon");
                newIcon.setAttribute("data-app-path", appPath);
                newIcon.setAttribute("data-icon-path", app.icon_path);
                if (el.parentElement) {
                  el.parentElement.replaceChild(newIcon, el);
                }
              }
            }
          });
        });
      }
    }
    console.log("[FromZero] ✓ Frontend initialization complete");
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus) footerStatus.textContent = "初始化失败，请重试";
  }
});

function renderRecentApps() {
  if (!recentGrid) return;
  recentGrid.innerHTML = "";
  const recentApps = (settings.recent_apps || [])
    .map(path => appItems.find(app => app.path === path))
    .filter(Boolean)
    .slice(0, 8);
  const displayApps = recentApps.length > 0 ? recentApps : appItems.slice(0, 8);
  if (displayApps.length === 0) {
    recentGrid.innerHTML = `<div style="grid-column: span 4; color: var(--text-dim); text-align: center; padding: 20px;">无可用应用</div>`;
    return;
  }
  displayApps.forEach(app => {
    const card = document.createElement("div");
    card.className = "recent-card";
    card.title = app.target;
    card.setAttribute("data-app-path", app.path);
    const iconEl = createIconElement(app.icon_path, "recent-icon");
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = app.name;
    card.appendChild(iconEl);
    card.appendChild(name);
    card.addEventListener("click", () => executeItemAction({ type: "app", data: app }));
    recentGrid.appendChild(card);
  });
}

function createIconElement(iconPath, cssClass) {
  if (!iconPath || iconPath === "⚡" || iconPath === "📂" || iconPath === "🌐") {
    const span = document.createElement("span");
    span.className = (cssClass || "") + " emoji";
    span.textContent = iconPath || "📱";
    span.style.fontSize = cssClass === "recent-icon" ? "26px" : "20px";
    if (cssClass === "recent-icon") span.style.marginBottom = "8px";
    return span;
  }
  const img = document.createElement("img");
  img.className = cssClass || "";
  img.loading = "lazy";
  const replaceWithFallbackEmoji = (element, className) => {
    const fallback = document.createElement("span");
    fallback.className = (className || "") + " emoji";
    fallback.textContent = "📦";
    fallback.style.fontSize = className === "recent-icon" ? "26px" : "20px";
    if (className === "recent-icon") fallback.style.marginBottom = "8px";
    if (element.hasAttribute("data-app-path")) fallback.setAttribute("data-app-path", element.getAttribute("data-app-path"));
    if (element.hasAttribute("data-icon-path")) fallback.setAttribute("data-icon-path", element.getAttribute("data-icon-path"));
    if (element.parentElement) element.parentElement.replaceChild(fallback, element);
  };
  img.onerror = () => {
    replaceWithFallbackEmoji(img, cssClass);
  };
  try {
    ensureTauri();
    if (window.__TAURI__?.core?.convertFileSrc) {
      img.src = window.__TAURI__.core.convertFileSrc(iconPath);
    } else {
      img.src = `https://asset.localhost/${encodeURIComponent(iconPath)}`;
    }
  } catch (e) {
    console.warn("[FromZero] Icon URL error:", e);
    setTimeout(() => replaceWithFallbackEmoji(img, cssClass), 0);
  }
  return img;
}

async function handleSearch() {
  if (!searchInput) return;
  const query = searchInput.value;
  selectedIndex = 0;
  const currentSearchId = ++lastSearchId;
  if (query.trim() === "") {
    if (welcomeScreen) welcomeScreen.style.display = "block";
    if (resultsList) resultsList.style.display = "none";
    filteredItems = [];
    if (searchIndicator) searchIndicator.textContent = "🔍";
    return;
  }
  if (welcomeScreen) welcomeScreen.style.display = "none";
  if (resultsList) resultsList.style.display = "block";
  if (query.startsWith(">")) {
    if (searchIndicator) searchIndicator.textContent = "⚡";
    const subQuery = query.slice(1).trim().toLowerCase();
    filteredItems = SYSTEM_COMMANDS.filter(cmd => cmd.key.includes(subQuery) || cmd.name.toLowerCase().includes(subQuery)).map(cmd => ({
      type: "sys",
      title: cmd.name,
      subtitle: cmd.desc,
      icon: "⚡",
      badge: cmd.badge,
      data: cmd.key
    }));
    renderResults();
  } else if (query.startsWith("/") || query.startsWith("\\\\") || /^[a-zA-Z]:\\/.test(query)) {
    if (searchIndicator) searchIndicator.textContent = "📂";
    filteredItems = [{
      type: "folder",
      title: `快速打开文件夹: "${query}"`,
      subtitle: "使用 Windows 资源管理器呼出",
      icon: "📂",
      badge: "路径",
      data: query
    }];
    renderResults();
  } else {
    const match = query.match(/^([a-zA-Z]+)\s+(.+)$/);
    if (match && settings.web_engines[match[1].toLowerCase()]) {
      const prefix = match[1].toLowerCase();
      const searchWord = match[2];
      const engineUrl = settings.web_engines[prefix];
      const targetUrl = engineUrl.replace("{}", encodeURIComponent(searchWord));
      const knownEngines = { g: "Google", b: "百度", bi: "Bing", gh: "GitHub" };
      const engineName = knownEngines[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1));
      if (searchIndicator) searchIndicator.textContent = "🌐";
      filteredItems = [{
        type: "web",
        title: `在 ${engineName} 搜索: "${searchWord}"`,
        subtitle: targetUrl,
        icon: "🌐",
        badge: "网页",
        data: targetUrl
      }];
      renderResults();
    } else {
      if (searchIndicator) searchIndicator.textContent = "🔍";
      try {
        ensureTauri();
        const results = await invoke("search_apps", { query });
        if (currentSearchId !== lastSearchId) return;
        filteredItems = results.slice(0, 7).map(app => ({
          type: "app",
          title: app.name,
          subtitle: app.target,
          icon: app.icon_path,
          badge: "应用",
          data: app
        }));
        if (filteredItems.length < 7) {
          const defaultBaidu = `https://baidu.com/s?wd=${encodeURIComponent(query)}`;
          filteredItems.push({
            type: "web",
            title: `在 百度 搜索: "${query}"`,
            subtitle: defaultBaidu,
            icon: "🌐",
            badge: "搜索",
            data: defaultBaidu
          });
        }
      } catch (e) {
        console.error("[FromZero] Search error:", e);
        if (currentSearchId === lastSearchId) filteredItems = [];
      }
      renderResults();
    }
  }
}

function renderResults() {
  if (!resultsList) return;
  resultsList.innerHTML = "";
  if (filteredItems.length === 0) {
    resultsList.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-dim); font-size: 13px;">无搜索匹配项</div>`;
    return;
  }
  filteredItems.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `result-item ${index === selectedIndex ? "selected" : ""}`;
    const iconWrapper = document.createElement("div");
    iconWrapper.className = "result-icon-wrapper";
    if (item.icon === "⚡" || item.icon === "📂" || item.icon === "🌐") {
      const emojiSpan = document.createElement("span");
      emojiSpan.className = "result-icon emoji";
      emojiSpan.textContent = item.icon;
      iconWrapper.appendChild(emojiSpan);
    } else {
      const iconEl = createIconElement(item.icon, "result-icon");
      if (item.type === "app" && item.data) {
        iconEl.setAttribute("data-app-path", item.data.path);
        iconEl.setAttribute("data-icon-path", item.data.icon_path);
      }
      iconWrapper.appendChild(iconEl);
    }
    const info = document.createElement("div");
    info.className = "result-info";
    const title = document.createElement("div");
    title.className = "result-title";
    title.textContent = item.title;
    const subtitle = document.createElement("div");
    subtitle.className = "result-subtitle";
    subtitle.textContent = item.subtitle;
    info.appendChild(title);
    info.appendChild(subtitle);
    const badge = document.createElement("span");
    badge.className = "result-badge";
    badge.textContent = item.badge;
    const action = document.createElement("span");
    action.className = "result-action";
    action.textContent = "↵ 打开";
    el.appendChild(iconWrapper);
    el.appendChild(info);
    el.appendChild(badge);
    el.appendChild(action);
    el.addEventListener("click", () => { selectedIndex = index; executeItemAction(item); });
    resultsList.appendChild(el);
  });
  const selectedEl = resultsList.children[selectedIndex];
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

function updateSelectionVisual() {
  if (!resultsList) return;
  const items = resultsList.children;
  for (let i = 0; i < items.length; i++) {
    if (items[i].classList && items[i].classList.contains("result-item")) {
      if (i === selectedIndex) {
        items[i].classList.add("selected");
        items[i].scrollIntoView({ block: "nearest" });
      } else {
        items[i].classList.remove("selected");
      }
    }
  }
}

async function executeItemAction(item) {
  try {
    ensureTauri();
    if (item.type === "app") {
      const app = item.data;
      await invoke("launch_app", { path: app.path });
      try {
        const updatedSettings = await invoke("bump_recent_app", { path: app.path });
        settings = { ...settings, ...updatedSettings };
        renderRecentApps();
      } catch (bumpError) {
        console.error("[FromZero] Failed thread-safe recent app bump:", bumpError);
      }
    } else if (item.type === "sys") {
      if (item.data === "shutdown" || item.data === "restart") {
        if (!item.confirmed) {
          item.confirmed = true;
          item.title = `⚠️ 确认${item.data === "shutdown" ? "关闭计算机" : "重新启动"}？(再次按回车/点击以确认)`;
          renderResults();
          return;
        }
      }
      await invoke("execute_sys_command", { command: item.data });
    } else if (item.type === "folder") {
      await invoke("open_folder", { path: item.data });
    } else if (item.type === "web") {
      await invoke("open_search", { url: item.data });
    }
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide after action failed:", e);
    }
    if (searchInput) searchInput.value = "";
    handleSearch();
  } catch (error) {
    console.error("[FromZero] Action error:", error);
    if (footerStatus) footerStatus.textContent = `执行失败: ${error}`;
  }
}

async function handleGlobalKeys(e) {
  if (isRecording) {
    e.preventDefault();
    recordShortcut(e);
    return;
  }
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    if (e.key === "Escape") closeSettings();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (filteredItems.length > 0) {
      if (selectedIndex < filteredItems.length - 1) {
        selectedIndex++;
        updateSelectionVisual();
      }
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (filteredItems.length > 0) {
      if (selectedIndex > 0) {
        selectedIndex--;
        updateSelectionVisual();
      }
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchDebounceTimeout && selectedIndex === 0) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
      executeItemAction(filteredItems[selectedIndex]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    ensureTauri();
    appWindow.hide().catch(() => {});
  } else if (e.ctrlKey && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    openSettings();
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function openSettings() {
  if (settingsOverlay) settingsOverlay.classList.add("active");
  if (themeSelect) themeSelect.value = settings.theme || "dark";
  if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Alt+Space";
  if (autostartToggle) autostartToggle.checked = settings.autostart || false;
}

closeSettings = () => {
  if (settingsOverlay) settingsOverlay.classList.remove("active");
  isRecording = false;
  if (recordBtn) {
    recordBtn.textContent = "录制组合键";
    recordBtn.className = "record-btn";
  }
  if (searchInput) searchInput.focus();
}

async function saveSettingsConfig() {
  try {
    ensureTauri();
    if (themeSelect) settings.theme = themeSelect.value;
    if (shortcutDisplay) settings.shortcut = shortcutDisplay.textContent;
    if (autostartToggle) settings.autostart = autostartToggle.checked;
    applyTheme(settings.theme);
    await invoke("update_settings", { settings });
    closeSettings();
    if (searchInput) searchInput.focus();
  } catch (error) {
    console.error("[FromZero] Save settings error:", error);
    if (footerStatus) footerStatus.textContent = `保存设置失败: ${error}`;
  }
}

let isRecording = false;
function toggleRecordingShortcut() {
  isRecording = !isRecording;
  if (isRecording) {
    if (recordBtn) {
      recordBtn.textContent = "请按下按键...";
      recordBtn.classList.add("recording");
    }
  } else {
    if (recordBtn) {
      recordBtn.textContent = "录制组合键";
      recordBtn.classList.remove("recording");
    }
  }
}

document.addEventListener("mousedown", (e) => {
  if (isRecording && recordBtn && e.target !== recordBtn) {
    toggleRecordingShortcut();
  }
});

function recordShortcut(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  const ignoreKeys = ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock"];
  const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);
  if (!hasModifier && !isFunctionKey) return;
  if (!ignoreKeys.includes(e.key)) {
    let keyName = e.key;
    if (keyName === " ") keyName = "Space";
    else if (keyName === "ArrowUp") keyName = "Up";
    else if (keyName === "ArrowDown") keyName = "Down";
    else if (keyName === "ArrowLeft") keyName = "Left";
    else if (keyName === "ArrowRight") keyName = "Right";
    else if (keyName === "Escape") keyName = "Esc";
    else if (keyName.length === 1) keyName = keyName.toUpperCase();
    parts.push(keyName);
  }
  if (parts.length > 0 && !ignoreKeys.includes(e.key)) {
    if (shortcutDisplay) shortcutDisplay.textContent = parts.join("+");
    toggleRecordingShortcut();
  }
}
```
