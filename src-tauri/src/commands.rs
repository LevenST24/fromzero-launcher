use crate::indexer::{self, AppItem};
use crate::settings::{self, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
pub fn update_settings(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let _guard = state.settings_lock.lock().map_err(|e| e.to_string())?;

    // Compare old and new autostart setting to prevent writing registry on every launch
    let old_settings = settings::load_settings(&app_handle);
    if old_settings.autostart != settings.autostart {
        eprintln!(
            "[FromZero] Autostart setting changed: {} -> {}",
            old_settings.autostart, settings.autostart
        );
        let _ = settings::apply_autostart_setting(&app_handle, settings.autostart);
    }

    // Only re-register the global hotkey if it actually changed
    // Register first, so if it fails, settings are not saved to disk
    if old_settings.shortcut != settings.shortcut {
        if let Err(e) = register_shortcut_internal(&app_handle, &settings.shortcut) {
            // Registration failed and the old binding was already released inside
            // register_shortcut_internal. Roll back to the previous shortcut so the
            // actually-bound hotkey stays consistent with the (unchanged) saved
            // config, instead of leaving the app with no working hotkey.
            if let Err(re) = register_shortcut_internal(&app_handle, &old_settings.shortcut) {
                eprintln!(
                    "[FromZero] ✗ Failed to restore previous shortcut '{}': {}",
                    old_settings.shortcut, re
                );
            } else {
                eprintln!(
                    "[FromZero] ↻ Restored previous shortcut '{}' after failed change",
                    old_settings.shortcut
                );
            }
            return Err(e);
        }
    }

    // Compare and update capture FPS
    let mut settings = settings;
    settings.glass_settings.glass_fps = settings.glass_settings.glass_fps.clamp(15, 60);
    if old_settings.glass_settings.glass_fps != settings.glass_settings.glass_fps {
        let fps_clamped = settings.glass_settings.glass_fps as u32;
        crate::capture::CAPTURE_FPS.store(fps_clamped, std::sync::atomic::Ordering::Relaxed);
        if crate::capture::is_active() {
            let app_handle_clone = app_handle.clone();
            tokio::spawn(async move {
                if let Some(window) = app_handle_clone.get_webview_window("main") {
                    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let pad_phys = (40.0 * scale).round() as u32;
                        let _ = tokio::task::spawn_blocking(move || {
                            crate::capture::start(pos.x, pos.y, size.width, size.height, pad_phys)
                        })
                        .await;
                    }
                }
            });
        }
    }

    settings::save_settings(&app_handle, &settings)?;
    Ok(())
}

#[tauri::command]
pub fn bump_recent_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Settings, String> {
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
pub async fn scan_apps(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AppItem>, String> {
    eprintln!("[FromZero] scan_apps command invoked");

    // Check local JSON cache first to eliminate startup lag
    if let Some(apps) = indexer::load_apps_cache(&app_handle) {
        eprintln!(
            "[FromZero] scan_apps returning {} apps from local JSON cache",
            apps.len()
        );

        // Update memory cache
        if let Ok(mut cache) = state.apps.lock() {
            *cache = apps.clone();
        }

        // Extract icons in background for current apps
        indexer::trigger_icon_extraction(app_handle.clone(), apps.clone());

        // Spawn asynchronous background scan to refresh the list if anything changed
        let app_handle_bg = app_handle.clone();
        let apps_old = apps.clone();
        tokio::spawn(async move {
            let app_handle_bg_clone = app_handle_bg.clone();
            let apps_now =
                tokio::task::spawn_blocking(move || indexer::scan_start_menu(&app_handle_bg_clone))
                    .await;

            if let Ok(new_apps) = apps_now {
                let mut changed = false;
                if new_apps.len() != apps_old.len() {
                    changed = true;
                } else {
                    for (a, b) in new_apps.iter().zip(apps_old.iter()) {
                        if a.path != b.path || a.name != b.name || a.target != b.target {
                            changed = true;
                            break;
                        }
                    }
                }

                if changed {
                    eprintln!(
                        "[FromZero] Start menu changed in background. Updating cache with {} apps",
                        new_apps.len()
                    );
                    let _ = indexer::save_apps_cache(&app_handle_bg, &new_apps);
                    if let Some(bg_state) = app_handle_bg.try_state::<AppState>() {
                        if let Ok(mut cache) = bg_state.apps.lock() {
                            *cache = new_apps.clone();
                        }
                    }
                    // Emit event to notify frontend to refresh
                    let _ = app_handle_bg.emit("apps-updated", new_apps.clone());
                    // Extract icons for new apps
                    indexer::trigger_icon_extraction(app_handle_bg, new_apps);
                }
            }
        });

        return Ok(apps);
    }

    // Fallback: perform synchronous scan on first run
    eprintln!("[FromZero] No apps cache found, performing synchronous scan on first run");
    let app_handle_clone = app_handle.clone();
    let apps = tokio::task::spawn_blocking(move || indexer::scan_start_menu(&app_handle_clone))
        .await
        .map_err(|e| format!("App scan thread failed: {}", e))?;

    eprintln!(
        "[FromZero] scan_apps synchronous scan returned {} apps",
        apps.len()
    );

    // Save to memory cache
    if let Ok(mut cache) = state.apps.lock() {
        *cache = apps.clone();
    }

    // Save to JSON cache
    let _ = indexer::save_apps_cache(&app_handle, &apps);

    // Extract icons asynchronously
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
        // Pinyin fields are already lowercase ASCII (see indexer::get_pinyin).
        // Only the display name needs lowercasing for case-insensitive match.
        let name_lower = app.name.to_lowercase();
        let score = score_app(
            &query_lower,
            &name_lower,
            &app.pinyin_initials,
            &app.pinyin_full,
        );

        if score > 0 {
            scored_apps.push((score, name_lower, app.clone())); // Clone only matched items
        }
    }

    // Sort by score (descending), then by precomputed lowercase name (no re-alloc)
    scored_apps.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored_apps.into_iter().map(|(_, _, app)| app).collect()
}

#[tauri::command]
pub fn launch_app(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = clean_path_str(path);
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
    // Security restriction: reject network/share (UNC) paths, matching the
    // boundary enforced by list_directory/get_file_preview/open_file.
    if !is_safe_path(&path_buf) {
        return Err("安全限制: 不允许访问网络或共享(UNC)路径。".to_string());
    }
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
        return Err(
            "Security Error: Only http:// and https:// URL protocol schemas are allowed"
                .to_string(),
        );
    }
    open::that(trimmed).map_err(|e| format!("Failed to open search: {}", e))
}

#[tauri::command]
pub fn execute_sys_command(app: AppHandle, command: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    if !is_visible {
        return Err("安全限制: 窗口不可见时无法执行系统命令。".to_string());
    }

    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let rundll_path = format!("{}\\{}", sys_root, "System32\\rundll32.exe");
    let shutdown_path = format!("{}\\{}", sys_root, "System32\\shutdown.exe");

    match command.as_str() {
        "lock" => {
            std::process::Command::new(rundll_path)
                .args(["user32.dll,LockWorkStation"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "sleep" => {
            std::process::Command::new(rundll_path)
                .args(["powrprof.dll,SetSuspendState", "0,1,0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "shutdown" => {
            std::process::Command::new(shutdown_path)
                .args(["/s", "/t", "0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        "restart" => {
            std::process::Command::new(shutdown_path)
                .args(["/r", "/t", "0"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("Unknown system command".to_string()),
    }
    Ok(())
}

fn toggle_window_visibility(window: &tauri::WebviewWindow) {
    let is_visible = window.is_visible().unwrap_or(false);
    let is_focused = window.is_focused().unwrap_or(false);
    if is_visible && is_focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd) = window.hwnd() {
                use std::ffi::c_void;
                unsafe {
                    type SetForegroundWindowFn =
                        unsafe extern "system" fn(hwnd: *mut c_void) -> i32;
                    if let Ok(user32_name) = std::ffi::CString::new("user32.dll") {
                        let user32 = winapi::um::libloaderapi::LoadLibraryA(user32_name.as_ptr());
                        if !user32.is_null() {
                            if let Ok(func_name) = std::ffi::CString::new("SetForegroundWindow") {
                                let proc_addr = winapi::um::libloaderapi::GetProcAddress(
                                    user32,
                                    func_name.as_ptr(),
                                );
                                if !proc_addr.is_null() {
                                    let set_fg: SetForegroundWindowFn =
                                        std::mem::transmute(proc_addr);
                                    set_fg(hwnd.0);
                                }
                            }
                            winapi::um::libloaderapi::FreeLibrary(user32);
                        }
                    }
                }
            }
        }
    }
}

pub fn register_shortcut_internal(
    app_handle: &AppHandle,
    shortcut_str: &str,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    // Parse FIRST, before touching any existing registration, so an invalid
    // shortcut string leaves the currently-bound hotkey untouched.
    let shortcut = Shortcut::from_str(shortcut_str)
        .map_err(|e| format!("Invalid shortcut format '{}': {}", shortcut_str, e))?;

    // Only now that we have a valid shortcut do we release the old binding and
    // attempt to bind the new one. This keeps the function single-purpose:
    // it either ends with exactly the target shortcut bound (Ok), or it
    // reports an error to the caller, who owns the fallback/rollback policy.
    let _ = app_handle.global_shortcut().unregister_all();
    // Defensively unregister the target shortcut specifically: unregister_all()
    // does not always evict an identical combo from the underlying manager, which
    // otherwise surfaces as "HotKey already registered" when re-binding the same
    // key (e.g. switching back to a previously-used shortcut). Ignore the error
    // raised when it simply wasn't registered.
    let _ = app_handle.global_shortcut().unregister(shortcut);

    match app_handle
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if let tauri_plugin_global_shortcut::ShortcutState::Pressed = event.state {
                if let Some(window) = app.get_webview_window("main") {
                    toggle_window_visibility(&window);
                }
            }
        }) {
        Ok(()) => {
            eprintln!(
                "[FromZero] ✓ Shortcut '{}' registered successfully",
                shortcut_str
            );
            Ok(())
        }
        Err(e) => {
            eprintln!(
                "[FromZero] ✗ Failed to register shortcut '{}': {}",
                shortcut_str, e
            );
            Err(format!("快捷键 '{}' 注册失败: {}", shortcut_str, e))
        }
    }
}

#[tauri::command]
pub fn debug_log(_msg: String) {
    #[cfg(debug_assertions)]
    println!("[Frontend-Debug] {}", _msg);
}

/// Toggle DWM Acrylic blur on/off based on glassBlur value, and dynamically adjust native corner rounding.
/// glassBlur = 0 → transparent (DWMSBT_NONE), corner rounding = DWMWCP_DONOTROUND (letting WebGL shape corners).
/// glassBlur > 0 → blurred (DWMSBT_TRANSIENTWINDOW), corner rounding = DWMWCP_ROUND (letting DWM natively round windows to prevent sharp rect ghost corners).
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_blur(_app: AppHandle, _value: i32) -> Result<(), String> {
    // Completely disable flawed DWM Acrylic fallback to prevent system-level corner leaking & pixel artifacts.
    // WebGL-based Liquid Glass will handle all rounding and blur natively with pixel-perfect anti-aliasing.
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

// FilePreview lives in crate::preview — single source of truth for IPC shape.
pub use crate::preview::FilePreview;

fn is_safe_path(path: &std::path::Path) -> bool {
    if let Some(path_str) = path.to_str() {
        let normalized = path_str.replace('/', "\\");
        if normalized.starts_with(r"\\") {
            // Reject UNC network/share paths (\\server\share and \\?\UNC\...).
            if normalized.starts_with(r"\\?\UNC\") {
                return false;
            }
            // Reject the device namespace (\\.\PhysicalDrive0, \\.\PIPE\..., etc.).
            // These are not regular filesystem paths and must never be opened.
            if normalized.starts_with(r"\\.\") {
                return false;
            }
            // Allow only the \\?\ extended-length prefix for normal local paths;
            // anything else under \\ (i.e. a bare \\server\share) is rejected.
            if !normalized.starts_with(r"\\?\") {
                return false;
            }
            // \\?\UNC\ already handled above; a remaining \\?\ that still points at
            // a UNC share is caught there. Local \\?\C:\... paths are fine.
        }
    }
    true
}

fn clean_path_str(path: String) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\") {
        stripped.to_string()
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

fn file_item_from_meta(
    name: String,
    path: std::path::PathBuf,
    metadata: &std::fs::Metadata,
) -> FileItem {
    let is_dir = metadata.is_dir();
    let size = if is_dir { 0 } else { metadata.len() };
    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    FileItem {
        name,
        path: clean_path_str(path.to_string_lossy().to_string()),
        is_dir,
        size,
        extension,
        modified,
    }
}

fn metadata_to_file_item(entry: &std::fs::DirEntry) -> Option<FileItem> {
    let metadata = entry.metadata().ok()?;
    // Skip symbolic links and junctions to prevent infinite recursion
    if metadata.file_type().is_symlink() {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return None;
        }
    }
    let name = entry.file_name().to_string_lossy().to_string();
    Some(file_item_from_meta(name, entry.path(), &metadata))
}

/// Case-insensitive name key for sorting (allocates once per item).
fn name_sort_key(name: &str) -> String {
    name.to_lowercase()
}

/// Directories to skip during recursive file search
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".cache",
    "AppData",
    "$Recycle.Bin",
    "System Volume Information",
    ".vs",
    ".idea",
    "target",
    "dist",
    "build",
    ".next",
];

#[tauri::command]
pub async fn list_directory(path: String, search_term: String) -> Result<Vec<FileItem>, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = std::path::PathBuf::from(&path);
        if !is_safe_path(&dir_path) {
            return Err("安全限制: 不允许访问网络或共享(UNC)路径。".to_string());
        }
        // Canonicalize to resolve .. and symlinks for security
        let dir_path = dir_path
            .canonicalize()
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
        let entries =
            std::fs::read_dir(&dir_path).map_err(|e| format!("无法读取目录 {}: {}", path, e))?;

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

        // Sort: directories first, then alphabetically (lowercase keys precomputed once)
        items.sort_by_cached_key(|item| (!item.is_dir, name_sort_key(&item.name)));

        // Limit to 50 results to prevent UI flooding
        items.truncate(50);
        Ok(items)
    })
    .await
    .map_err(|e| format!("Directory listing thread failed: {}", e))?
}

#[tauri::command]
pub async fn search_files(query: String, is_inline: Option<bool>) -> Result<Vec<FileItem>, String> {
    let is_inline = is_inline.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        let query_lower = query.to_lowercase().trim().to_string();
        if query_lower.is_empty() {
            return Ok(Vec::new());
        }

        let user_profile =
            std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());

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
                search_recursive(
                    &root_path,
                    &query_lower,
                    &mut results,
                    max_results,
                    max_depth,
                    0,
                );
            }
            if results.len() >= max_results {
                break;
            }
        }

        // Sort: directories first, then by name (lowercase keys precomputed once)
        results.sort_by_cached_key(|item| (!item.is_dir, name_sort_key(&item.name)));

        Ok(results)
    })
    .await
    .map_err(|e| format!("Search thread failed: {}", e))?
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
        let name_lower = name.to_lowercase();
        let path = entry.path();

        if metadata.is_dir() {
            // Skip ignored directories
            if IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                continue;
            }
            // Reuse already-fetched metadata (avoid second stat via metadata_to_file_item)
            if name_lower.contains(query) {
                results.push(file_item_from_meta(name, path.clone(), &metadata));
            }
            search_recursive(
                &path,
                query,
                results,
                max_results,
                max_depth,
                current_depth + 1,
            );
        } else if name_lower.contains(query) {
            results.push(file_item_from_meta(name, path, &metadata));
        }
    }
}

#[tauri::command]
pub async fn get_file_preview(path: String) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || {
        let file_path = crate::preview::resolve_preview_path(&path, &is_safe_path)?;
        crate::preview::build_preview(&file_path, &is_hidden_or_system)
    })
    .await
    .map_err(|e| format!("Preview thread failed: {}", e))?
}

/// Read a small/medium file as raw bytes for WebView-safe preview (PDF blob).
/// Edge/WebView2 blocks embedding `asset.localhost` PDFs in iframes; the frontend
/// loads these bytes into a `blob:` URL instead.
#[tauri::command]
pub async fn read_preview_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        let file_path = crate::preview::resolve_preview_path(&path, &is_safe_path)?;
        crate::preview::read_preview_bytes(&file_path)
    })
    .await
    .map_err(|e| format!("Preview bytes thread failed: {}", e))?
}

#[tauri::command]
pub async fn open_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let apps = if let Ok(apps) = state.apps.lock() {
        apps.clone()
    } else {
        Vec::new()
    };
    tokio::task::spawn_blocking(move || {
        let file_path = std::path::PathBuf::from(&path);
        if !is_safe_path(&file_path) {
            return Err("安全限制: 不允许访问网络或共享(UNC)路径。".to_string());
        }
        let file_path = file_path
            .canonicalize()
            .map_err(|e| format!("路径解析失败: {}", e))?;
        let path_clean = clean_path_str(file_path.to_string_lossy().to_string());
        if !file_path.exists() {
            return Err(format!("文件不存在: {}", path_clean));
        }

        // Security: block direct execution of script/executable files
        let ext = file_path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let dangerous_exts = [
            "exe", "bat", "cmd", "ps1", "ps2", "psc1", "psc2", "vbs", "vbe", "wsf", "wsh", "ws",
            "msi", "msp", "mst", "scr", "com", "pif", "lnk", "url", "hta", "js", "jse", "msc",
            "cpl", "reg", "jar", "scf", "inf", "gadget", "appref-ms", "application", "vbscript",
        ];
        if dangerous_exts.contains(&ext.as_str()) {
            // Allow only if the file is in the scanned apps whitelist (either as shortcut or target executable)
            let is_whitelisted = apps.iter().any(|app| {
                let clean_p = if let Ok(p_path) = std::path::PathBuf::from(&app.path).canonicalize()
                {
                    clean_path_str(p_path.to_string_lossy().to_string())
                } else {
                    clean_path_str(app.path.clone())
                };

                let clean_t =
                    if let Ok(t_path) = std::path::PathBuf::from(&app.target).canonicalize() {
                        clean_path_str(t_path.to_string_lossy().to_string())
                    } else {
                        clean_path_str(app.target.clone())
                    };

                clean_p.eq_ignore_ascii_case(&path_clean)
                    || clean_t.eq_ignore_ascii_case(&path_clean)
            });
            if !is_whitelisted {
                return Err(format!(
                    "安全限制: 不允许直接执行 .{} 文件。请通过应用搜索启动。",
                    ext
                ));
            }
        }

        open::that(&path_clean).map_err(|e| format!("无法打开文件: {}", e))
    })
    .await
    .map_err(|e| format!("Open thread failed: {}", e))?
}

#[tauri::command]
pub async fn start_bg_capture(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    if !is_visible {
        return Err("安全限制: 窗口不可见时无法启动后台捕获。".to_string());
    }
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let pad_phys = (40.0 * scale).round() as u32; // 40 CSS px padding
    tokio::task::spawn_blocking(move || {
        crate::capture::start(pos.x, pos.y, size.width, size.height, pad_phys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_bg_capture() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        crate::capture::stop();
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_capture_fps(app: AppHandle, fps: u32) -> Result<(), String> {
    let fps_clamped = fps.clamp(15, 60);
    crate::capture::CAPTURE_FPS.store(fps_clamped, std::sync::atomic::Ordering::Relaxed);
    if crate::capture::is_active() {
        let window = app
            .get_webview_window("main")
            .ok_or("Main window not found")?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let pad_phys = (40.0 * scale).round() as u32;
        tokio::task::spawn_blocking(move || {
            crate::capture::start(pos.x, pos.y, size.width, size.height, pad_phys)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_is_safe_path_allows_normal() {
        assert!(is_safe_path(Path::new(r"C:\Users\me\file.txt")));
        assert!(is_safe_path(Path::new(r"D:\folder")));
        assert!(is_safe_path(Path::new(r"\\?\C:\very\long\path")));
    }

    #[test]
    fn test_is_safe_path_rejects_unc_share() {
        assert!(!is_safe_path(Path::new(r"\\server\share")));
        assert!(!is_safe_path(Path::new(r"\\?\UNC\server\share")));
        // Forward-slash UNC must be rejected too (normalized internally).
        assert!(!is_safe_path(Path::new(r"//server/share")));
    }

    #[test]
    fn test_is_safe_path_rejects_device_namespace() {
        assert!(!is_safe_path(Path::new(r"\\.\PhysicalDrive0")));
        assert!(!is_safe_path(Path::new(r"\\.\PIPE\foo")));
    }

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
