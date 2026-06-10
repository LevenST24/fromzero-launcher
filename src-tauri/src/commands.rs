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
        if let Err(e) = settings::apply_autostart_setting(&app_handle, settings.autostart) {
            eprintln!("[FromZero] ✗ Failed to apply autostart setting: {}", e);
            return Err(format!("Failed to apply autostart setting: {}", e));
        }
    }
    
    // Only re-register the global hotkey if it actually changed
    // Register first, so if it fails, settings are not saved to disk
    if old_settings.shortcut != settings.shortcut {
        register_shortcut_internal(&app_handle, &settings.shortcut)?;
    }
    
    settings::save_settings(&app_handle, &settings)?;
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
pub async fn scan_apps(app_handle: AppHandle, state: State<'_, AppState>) -> Result<Vec<AppItem>, String> {
    eprintln!("[FromZero] scan_apps command invoked");
    let app_handle_clone = app_handle.clone();
    let apps = tokio::task::spawn_blocking(move || {
        indexer::scan_start_menu(&app_handle_clone)
    }).await.map_err(|e| format!("App scan thread failed: {}", e))?;
    
    eprintln!("[FromZero] scan_apps backend returned {} apps", apps.len());
    
    // Update memory cache
    match state.apps.lock() {
        Ok(mut cache) => {
            *cache = apps.clone();
        }
        Err(e) => {
            eprintln!("[FromZero] ✗ Apps cache mutex poisoned, recovering: {}", e);
            let mut cache = e.into_inner();
            *cache = apps.clone();
        }
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
    let path = clean_path_str(path);
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("应用文件路径不存在: {}", path));
    }
    
    // Security verification: Whitelist execution to only allow files in scanned apps cache
    let is_whitelisted = match state.apps.lock() {
        Ok(apps) => apps.iter().any(|app| app.path == path),
        Err(e) => {
            eprintln!("[FromZero] ✗ Apps cache mutex poisoned during launch_app: {}", e);
            return Err("Internal error: application cache unavailable. Please restart.".to_string());
        }
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

    // Unregister all existing shortcuts first
    if let Err(e) = app_handle.global_shortcut().unregister_all() {
        eprintln!("[FromZero] ✗ Failed to unregister existing shortcuts: {}", e);
    }

    // Register the new shortcut with toggle visibility handler
    match app_handle.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
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
        }
    }) {
        Ok(()) => {
            eprintln!("[FromZero] ✓ Shortcut '{}' registered successfully", shortcut_str);
            Ok(())
        }
        Err(e) => {
            // Registration failed — try to restore the default shortcut as fallback
            eprintln!("[FromZero] ✗ Failed to register shortcut '{}': {}", shortcut_str, e);
            if let Ok(default_shortcut) = Shortcut::from_str("Ctrl+Space") {
                let _ = app_handle.global_shortcut().on_shortcut(default_shortcut, move |app, _shortcut, event| {
                    if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
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
                    }
                });
                eprintln!("[FromZero] ↻ Restored default Ctrl+Space as fallback");
            }
            Err(format!("快捷键 '{}' 注册失败: {}", shortcut_str, e))
        }
    }
}

#[tauri::command]
pub fn debug_log(_msg: String) {
    #[cfg(debug_assertions)]
    println!("[Frontend-Debug] {}", _msg);
}

/// Toggle DWM Acrylic blur on/off based on glassBlur value.
/// glassBlur = 0 → transparent (DWMSBT_NONE), glassBlur > 0 → blurred (DWMSBT_TRANSIENTWINDOW).
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_blur(app: AppHandle, value: i32) -> Result<(), String> {
    use std::ffi::c_void;
    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;
    const DWMSBT_NONE: u32 = 1;
    const DWMSBT_TRANSIENTWINDOW: u32 = 3;

    let window = app.get_webview_window("main").ok_or("Window not found")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let raw_hwnd = hwnd.0 as *mut c_void;
    let backdrop_type = if value > 0 { DWMSBT_TRANSIENTWINDOW } else { DWMSBT_NONE };
    crate::dwm::set_dwm_attribute(raw_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, backdrop_type)?;
    eprintln!("[FromZero] DWM Acrylic {}", if value > 0 { "enabled" } else { "disabled" });
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn set_blur(_app: AppHandle, _value: i32) -> Result<(), String> {
    Ok(())
}

// =============================================
// File Explorer Commands
// =============================================

#[derive(serde::Serialize, Clone, Debug)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: String,
    pub modified: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct FilePreview {
    pub file_type: String,
    pub content: String,
    pub size: u64,
    pub modified: u64,
}

fn clean_path_str(path: String) -> String {
    if path.starts_with(r"\\?\") {
        path[4..].to_string()
    } else {
        path
    }
}

fn is_hidden_or_system(entry: &std::fs::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_string();
    if IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
        return true;
    }
    if name.starts_with('$') {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(metadata) = entry.metadata() {
            let attrs = metadata.file_attributes();
            // FILE_ATTRIBUTE_HIDDEN = 0x2
            // FILE_ATTRIBUTE_SYSTEM = 0x4
            if (attrs & 0x2) != 0 || (attrs & 0x4) != 0 {
                return true;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if name.starts_with('.') {
            return true;
        }
    }
    false
}

fn metadata_to_file_item(entry: &std::fs::DirEntry) -> Option<FileItem> {
    let metadata = entry.metadata().ok()?;
    // Skip symbolic links and junctions to prevent infinite recursion
    if metadata.file_type().is_symlink() {
        return None;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    let path = clean_path_str(entry.path().to_string_lossy().to_string());
    let is_dir = metadata.is_dir();
    let size = if is_dir { 0 } else { metadata.len() };
    let extension = if is_dir {
        String::new()
    } else {
        entry.path().extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    let modified = metadata.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(FileItem { name, path, is_dir, size, extension, modified })
}

/// Directories to skip during recursive file search
const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache",
    "AppData", "$Recycle.Bin", "System Volume Information",
    ".vs", ".idea", "target", "dist", "build", ".next",
];

#[tauri::command]
pub async fn list_directory(path: String, search_term: String) -> Result<Vec<FileItem>, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = std::path::PathBuf::from(&path);
        // Canonicalize to resolve .. and symlinks for security
        let dir_path = dir_path.canonicalize()
            .map_err(|e| format!("路径解析失败: {}", e))?;
        if !dir_path.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        if !dir_path.is_dir() {
            return Err(format!("不是目录: {}", path));
        }

        let mut items: Vec<FileItem> = Vec::new();

        // Add ".." parent directory entry if it exists
        if let Some(parent) = dir_path.parent() {
            let parent_clean = clean_path_str(parent.to_string_lossy().to_string());
            let current_clean = clean_path_str(dir_path.to_string_lossy().to_string());
            if !parent_clean.is_empty() && parent_clean != current_clean {
                items.push(FileItem {
                    name: "..".to_string(),
                    path: parent_clean,
                    is_dir: true,
                    size: 0,
                    extension: String::new(),
                    modified: 0,
                });
            }
        }
        let entries = std::fs::read_dir(&dir_path)
            .map_err(|e| format!("无法读取目录 {}: {}", path, e))?;

        let search_lower = search_term.to_lowercase();
        for entry in entries.flatten() {
            if is_hidden_or_system(&entry) {
                continue;
            }
            if let Some(item) = metadata_to_file_item(&entry) {
                if search_lower.is_empty() || item.name.to_lowercase().contains(&search_lower) {
                    items.push(item);
                }
            }
        }

        // Sort: directories first, then alphabetically
        items.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        // Limit to 50 results to prevent UI flooding
        items.truncate(50);
        Ok(items)
    }).await.map_err(|e| format!("Directory listing thread failed: {}", e))?
}

#[tauri::command]
pub async fn search_files(query: String, is_inline: Option<bool>) -> Result<Vec<FileItem>, String> {
    let is_inline = is_inline.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        let query_lower = query.to_lowercase().trim().to_string();
        if query_lower.is_empty() {
            return Ok(Vec::new());
        }

        let user_profile = std::env::var("USERPROFILE")
            .unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        
        let mut search_roots = vec![
            format!("{}\\Desktop", user_profile),
            format!("{}\\Documents", user_profile),
            format!("{}\\Downloads", user_profile),
            format!("{}\\Pictures", user_profile),
        ];

        // Detect other local drives on Windows to support search on E:\, D:\, etc.
        // Skip scanning other drives if this is an inline search (performance optimization)
        #[cfg(target_os = "windows")]
        if !is_inline {
            let system_drive = std::env::var("SystemDrive")
                .unwrap_or_else(|_| "C:".to_string())
                .to_uppercase();
            let mask = unsafe { winapi::um::fileapi::GetLogicalDrives() };
            for i in 0..26 {
                if (mask & (1 << i)) != 0 {
                    let letter = (b'A' + i) as char;
                    let drive_prefix = format!("{}:", letter);
                    // Skip A: and B: (floppy drives), and skip the system drive C: (as we scan specific user folders on C:)
                    if letter != 'A' && letter != 'B' && drive_prefix != system_drive {
                        search_roots.push(format!("{}:\\", letter));
                    }
                }
            }
        }

        let mut results: Vec<FileItem> = Vec::new();
        let max_results = 30;
        let max_depth = 3;

        for root in &search_roots {
            let root_path = std::path::PathBuf::from(root);
            if root_path.exists() && root_path.is_dir() {
                search_recursive(&root_path, &query_lower, &mut results, max_results, max_depth, 0);
            }
            if results.len() >= max_results {
                break;
            }
        }

        // Sort: directories first, then by name
        results.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(results)
    }).await.map_err(|e| format!("Search thread failed: {}", e))?
}

fn search_recursive(
    dir: &std::path::Path,
    query: &str,
    results: &mut Vec<FileItem>,
    max_results: usize,
    max_depth: usize,
    current_depth: usize,
) {
    if current_depth > max_depth || results.len() >= max_results {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if results.len() >= max_results {
            return;
        }

        if is_hidden_or_system(&entry) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Skip symbolic links and junctions
        if metadata.file_type().is_symlink() {
            continue;
        }
        // On Windows, check for reparse points (junctions)
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                continue;
            }
        }

        let name = entry.file_name().to_string_lossy().to_string();

        if metadata.is_dir() {
            // Skip ignored directories
            if IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                continue;
            }
            // Check if dir name matches
            if name.to_lowercase().contains(query) {
                if let Some(item) = metadata_to_file_item(&entry) {
                    results.push(item);
                }
            }
            // Recurse into subdirectory
            search_recursive(&entry.path(), query, results, max_results, max_depth, current_depth + 1);
        } else {
            // Check if file name matches
            if name.to_lowercase().contains(query) {
                if let Some(item) = metadata_to_file_item(&entry) {
                    results.push(item);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn get_file_preview(path: String) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || {
        let file_path = std::path::PathBuf::from(&path);
        let file_path = file_path.canonicalize()
            .map_err(|e| format!("路径解析失败: {}", e))?;
        if !file_path.exists() {
            return Err(format!("文件不存在: {}", path));
        }

        let metadata = std::fs::metadata(&file_path)
            .map_err(|e| format!("无法读取元数据: {}", e))?;
        let size = metadata.len();
        let modified = metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if metadata.is_dir() {
            // For folders: list first 10 items
            let mut items = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&file_path) {
                for entry in entries.flatten().take(10) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);
                    items.push(format!("{} {}", if is_dir { "📁" } else { "📄" }, name));
                }
            }
            return Ok(FilePreview {
                file_type: "folder".to_string(),
                content: items.join("\n"),
                size: 0,
                modified,
            });
        }

        let ext = file_path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let image_exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
        let audio_exts = ["mp3", "wav", "ogg", "flac", "aac", "m4a"];
        let text_exts = [
            "txt", "md", "json", "js", "ts", "rs", "css", "html", "py", "sh", "bat",
            "toml", "yaml", "yml", "ini", "log", "conf", "cfg", "xml", "csv",
            "c", "cpp", "h", "hpp", "java", "go", "rb", "php", "sql", "r",
        ];

        if image_exts.contains(&ext.as_str()) {
            // Image preview: encode as Base64 (max 10MB)
            if size > 10 * 1024 * 1024 {
                return Ok(FilePreview {
                    file_type: "image".to_string(),
                    content: String::new(),
                    size,
                    modified,
                });
            }
            let bytes = std::fs::read(&file_path)
                .map_err(|e| format!("无法读取文件: {}", e))?;
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "ico" => "image/x-icon",
                "svg" => "image/svg+xml",
                _ => "application/octet-stream",
            };
            Ok(FilePreview {
                file_type: "image".to_string(),
                content: format!("data:{};base64,{}", mime, encoded),
                size,
                modified,
            })
        } else if ext == "pdf" {
            // PDF preview: encode as Base64 (max 30MB)
            if size > 30 * 1024 * 1024 {
                return Ok(FilePreview {
                    file_type: "pdf".to_string(),
                    content: String::new(),
                    size,
                    modified,
                });
            }
            let bytes = std::fs::read(&file_path)
                .map_err(|e| format!("无法读取文件: {}", e))?;
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(FilePreview {
                file_type: "pdf".to_string(),
                content: format!("data:application/pdf;base64,{}", encoded),
                size,
                modified,
            })
        } else if audio_exts.contains(&ext.as_str()) {
            // Audio preview: encode as Base64 (max 50MB)
            if size > 50 * 1024 * 1024 {
                return Ok(FilePreview {
                    file_type: "audio".to_string(),
                    content: String::new(),
                    size,
                    modified,
                });
            }
            let bytes = std::fs::read(&file_path)
                .map_err(|e| format!("无法读取文件: {}", e))?;
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mime = match ext.as_str() {
                "mp3" => "audio/mpeg",
                "wav" => "audio/wav",
                "ogg" => "audio/ogg",
                "flac" => "audio/flac",
                "aac" => "audio/aac",
                "m4a" => "audio/mp4",
                _ => "audio/ogg",
            };
            Ok(FilePreview {
                file_type: "audio".to_string(),
                content: format!("data:{};base64,{}", mime, encoded),
                size,
                modified,
            })
        } else if text_exts.contains(&ext.as_str()) {
            // Text preview: read at most 64KB to prevent OOM
            use std::io::Read;
            let file = std::fs::File::open(&file_path)
                .map_err(|e| format!("无法打开文件: {}", e))?;
            let mut handle = file.take(64 * 1024);
            let mut buffer = Vec::new();
            handle.read_to_end(&mut buffer)
                .map_err(|e| format!("无法读取文件: {}", e))?;
            let text = String::from_utf8_lossy(&buffer);
            let preview: String = text.lines().take(30).collect::<Vec<_>>().join("\n");
            Ok(FilePreview {
                file_type: "text".to_string(),
                content: preview,
                size,
                modified,
            })
        } else {
            // Binary/unknown: metadata only
            Ok(FilePreview {
                file_type: "binary".to_string(),
                content: String::new(),
                size,
                modified,
            })
        }
    }).await.map_err(|e| format!("Preview thread failed: {}", e))?
}

#[tauri::command]
pub async fn open_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let apps = match state.apps.lock() {
        Ok(apps) => apps.clone(),
        Err(e) => {
            eprintln!("[FromZero] ✗ Apps cache mutex poisoned during open_file: {}", e);
            return Err("Internal error: application cache unavailable. Please restart.".to_string());
        }
    };
    tokio::task::spawn_blocking(move || {
        let file_path = std::path::PathBuf::from(&path);
        let file_path = file_path.canonicalize()
            .map_err(|e| format!("路径解析失败: {}", e))?;
        let path_clean = clean_path_str(file_path.to_string_lossy().to_string());
        if !file_path.exists() {
            return Err(format!("文件不存在: {}", path_clean));
        }

        // Security: block direct execution of script/executable files
        let ext = file_path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let dangerous_exts = ["exe", "bat", "cmd", "ps1", "vbs", "wsf", "msi", "scr", "com", "pif"];
        if dangerous_exts.contains(&ext.as_str()) {
            // Allow only if the file is in the scanned apps whitelist (either as shortcut or target executable)
            let is_whitelisted = apps.iter().any(|app| {
                let clean_p = if let Ok(p_path) = std::path::PathBuf::from(&app.path).canonicalize() {
                    clean_path_str(p_path.to_string_lossy().to_string())
                } else {
                    clean_path_str(app.path.clone())
                };

                let clean_t = if let Ok(t_path) = std::path::PathBuf::from(&app.target).canonicalize() {
                    clean_path_str(t_path.to_string_lossy().to_string())
                } else {
                    clean_path_str(app.target.clone())
                };

                clean_p.eq_ignore_ascii_case(&path_clean) || clean_t.eq_ignore_ascii_case(&path_clean)
            });
            if !is_whitelisted {
                return Err(format!("安全限制: 不允许直接执行 .{} 文件。请通过应用搜索启动。", ext));
            }
        }

        open::that(&path_clean).map_err(|e| format!("无法打开文件: {}", e))
    }).await.map_err(|e| format!("Open thread failed: {}", e))?
}

#[tauri::command]
pub fn start_bg_capture(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    crate::capture::start(pos.x, pos.y, size.width, size.height)
}

#[tauri::command]
pub fn stop_bg_capture() {
    crate::capture::stop();
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
