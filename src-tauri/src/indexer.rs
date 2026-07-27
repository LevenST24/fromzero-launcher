use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::thread;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

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
    #[serde(default)]
    arguments: String,
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
pub fn load_apps_cache(app_handle: &AppHandle) -> Option<Vec<AppItem>> {
    let cache_dir = app_handle.path().app_cache_dir().ok()?;
    let cache_path = cache_dir.join("apps_cache.json");
    if cache_path.exists() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(apps) = serde_json::from_str::<Vec<AppItem>>(&content) {
                return Some(apps);
            }
        }
    }
    None
}

pub fn save_apps_cache(app_handle: &AppHandle, apps: &[AppItem]) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let cache_path = cache_dir.join("apps_cache.json");
    let content = serde_json::to_string(apps).map_err(|e| e.to_string())?;
    fs::write(&cache_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn scan_start_menu(app_handle: &AppHandle) -> Vec<AppItem> {
    let mut apps = Vec::new();
    // Dedup by (target, arguments) so that PWA shortcuts pointing to the same
    // browser executable but with different --app-id arguments are kept separately.
    let mut seen_target_args = HashSet::new();

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
                    arguments = if ($lnk.Arguments) { $lnk.Arguments } else { '' }
                }
            } catch { Write-Warning "Failed to resolve shortcut: $($_.Exception.Message)" }
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

    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell_path = format!(
        "{}\\{}",
        sys_root, "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    let mut cmd = std::process::Command::new(powershell_path);
    cmd.args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        ps_command,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = run_command_with_timeout(cmd, std::time::Duration::from_secs(10));

    match &output {
        Ok(out) => {
            eprintln!(
                "[FromZero] PowerShell finished. Status: success={}. Stdout len: {}. Stderr len: {}.",
                out.status.success(),
                out.stdout.len(),
                out.stderr.len()
            );
            if !out.status.success() || !out.stderr.is_empty() {
                eprintln!(
                    "[FromZero] Stderr content: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }
        Err(e) => {
            eprintln!("[FromZero] Failed to run PowerShell start menu scan: {}", e);
        }
    }

    if let Ok(out) = output {
        let json_str = String::from_utf8_lossy(&out.stdout);
        let trimmed = json_str.trim();

        eprintln!(
            "[FromZero] PowerShell output trimmed length: {}",
            trimmed.len()
        );
        if trimmed.is_empty() || trimmed == "[]" {
            eprintln!("[FromZero] PowerShell output is empty or '[]'");
        }

        if !trimmed.is_empty() && trimmed != "[]" {
            // PowerShell might output a single object or an array. We handle both by attempting to parse as array first
            let raw_items: Vec<RawAppItem> = if trimmed.starts_with('[') {
                match serde_json::from_str(trimmed) {
                    Ok(items) => items,
                    Err(e) => {
                        eprintln!("[FromZero] Failed to parse start menu JSON array: {}. Raw JSON length: {}", e, trimmed.len());
                        Vec::new()
                    }
                }
            } else {
                match serde_json::from_str::<RawAppItem>(trimmed) {
                    Ok(item) => vec![item],
                    Err(e) => {
                        eprintln!("[FromZero] Failed to parse start menu JSON object: {}. Raw JSON length: {}", e, trimmed.len());
                        Vec::new()
                    }
                }
            };

            eprintln!(
                "[FromZero] Parsed {} raw items from start menu JSON",
                raw_items.len()
            );

            let cache_dir = match app_handle.path().app_cache_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    eprintln!("[FromZero] Error: Failed to resolve cache directory: {e}");
                    return apps;
                }
            };
            eprintln!("[FromZero] Cache directory: {}", cache_dir.display());
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

                // Dedup by (target, arguments) so PWA shortcuts with different
                // --app-id arguments are kept even when they share the same browser executable
                let dedup_key = format!(
                    "{}|{}",
                    item.target.to_lowercase(),
                    item.arguments.to_lowercase()
                );
                if seen_target_args.contains(&dedup_key) {
                    continue;
                }
                seen_target_args.insert(dedup_key);

                // Cached icon lives under <cache>/icons; ensure it exists once.
                let icons_dir = cache_dir.join("icons");
                let _ = fs::create_dir_all(&icons_dir);
                apps.push(make_app_item(item.name, item.path, item.target, &icons_dir));
            }
        }
    }

    eprintln!("[FromZero] scan_start_menu returning {} apps", apps.len());
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

/// Build an AppItem, deriving the cached icon path from `path` (its FNV hash)
/// and pinyin keys from `name`. Shared by every scan source. `icons_dir` must
/// already exist.
fn make_app_item(name: String, path: String, target: String, icons_dir: &Path) -> AppItem {
    let icon_path = icons_dir
        .join(format!("{:x}.png", get_path_hash(&path)))
        .to_string_lossy()
        .into_owned();
    let (initials, full) = get_pinyin(&name);
    AppItem {
        name,
        path,
        target,
        pinyin_initials: initials,
        pinyin_full: full,
        icon_path,
    }
}

// =============================================
// Automatic app discovery (portable apps / games on secondary drives)
// =============================================

/// Installer / maintenance executable names, matched on whole path segments
/// (the stem split on non-alphanumerics) so real titles that merely *contain*
/// these letters — "Terror", "Dispatch", "SettingSun" — are never dropped.
fn is_noise_exe(stem_lower: &str) -> bool {
    const EXACT: &[&str] = &[
        "setup", "install", "installer", "uninstall", "uninstaller", "update", "updater",
        "upgrade", "patch", "patcher", "repair", "cleanup", "config", "settings", "prefs",
        "redist", "vcredist", "prereq", "prereqs", "helper", "activate", "register", "report",
        "readme", "manual", "crashreporter", "crashhandler", "crashpad", "service", "daemon",
    ];
    const PREFIX: &[&str] = &["unins", "vcredist", "vc_redist", "dxsetup", "dxwebsetup"];
    stem_lower.split(|c: char| !c.is_alphanumeric()).any(|seg| {
        !seg.is_empty() && (EXACT.contains(&seg) || PREFIX.iter().any(|p| seg.starts_with(p)))
    })
}

/// Fixed Windows system / metadata folders that never hold user apps. This is
/// OS-level knowledge, not a third-party denylist — no product names here.
fn is_system_dir(name_lower: &str) -> bool {
    const SYS: &[&str] = &[
        "windows", "program files", "program files (x86)", "programdata", "$recycle.bin",
        "system volume information", "recovery", "perflogs", "msocache", "appdata",
        "$windows.~bt", "$windows.~ws", "node_modules", ".git", ".svn", "__pycache__",
    ];
    SYS.contains(&name_lower)
}

struct ExeCandidate {
    stem: String,
    size: u64,
    path: std::path::PathBuf,
}

fn entry_is_hidden(entry: &std::fs::DirEntry) -> bool {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if name.starts_with('.') || name.starts_with('$') {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(md) = entry.metadata() {
            // FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_REPARSE_POINT
            if md.file_attributes() & (0x2 | 0x4 | 0x400) != 0 {
                return true;
            }
        }
    }
    false
}

/// Generic container folder names that aren't the app's own title — when the
/// application unit sits in one of these, the name comes from its parent.
fn is_generic_container(name_lower: &str) -> bool {
    const GENERIC: &[&str] = &[
        "bin", "bin64", "bin32", "system", "system32", "system64", "x64", "x86", "win32", "win64",
        "game", "games", "app", "release", "data", "program",
    ];
    GENERIC.contains(&name_lower)
}

/// Display name for an application unit folder: the folder name, unless it is a
/// generic container (bin/x64/…), in which case climb to the nearest real title
/// folder — but never above the configured scan root.
fn app_name_for(dir: &Path, root: &Path) -> String {
    let mut cur = dir;
    loop {
        let name = cur
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if cur != root && is_generic_container(&name.to_lowercase()) {
            if let Some(parent) = cur.parent() {
                cur = parent;
                continue;
            }
        }
        return if name.is_empty() {
            dir.to_string_lossy().to_string()
        } else {
            name
        };
    }
}

/// Pick the main executable among several in one application folder using only
/// generic signals: launcher-style names, a name matching the folder, then the
/// largest binary (the primary program is almost always the biggest file).
fn pick_main_exe(group: &[&ExeCandidate], app_name: &str) -> usize {
    // Cross-language launcher naming conventions (EN / zh / ja) — generic, not
    // tied to any specific program.
    const LAUNCH_HINTS: &[&str] = &[
        "launch", "start", "play", "run", "game", "启动", "开始", "游戏", "起動", "ゲーム",
    ];
    let app_lower = app_name.to_lowercase();
    let mut best = 0usize;
    let mut best_score = i64::MIN;
    for (i, c) in group.iter().enumerate() {
        let stem_lower = c.stem.to_lowercase();
        let mut score: i64 = 0;
        if LAUNCH_HINTS.iter().any(|h| stem_lower.contains(h)) {
            score += 1_000_000;
        }
        if !app_lower.is_empty()
            && (stem_lower.contains(&app_lower) || app_lower.contains(&stem_lower))
        {
            score += 500_000;
        }
        // Size in MB (capped) as the tiebreak — main binaries dominate.
        score += (c.size / (1024 * 1024)).min(400_000) as i64;
        if score > best_score {
            best_score = score;
            best = i;
        }
    }
    best
}

/// Enumerate fixed (non-removable, non-network) drive roots, excluding the
/// system drive. Games / portable apps almost always live on secondary drives,
/// and skipping C: avoids trawling Windows / Program Files / Users.
#[cfg(target_os = "windows")]
fn auto_scan_roots() -> Vec<String> {
    let system_drive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .to_uppercase();
    let mask = unsafe { winapi::um::fileapi::GetLogicalDrives() };
    let mut roots = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let prefix = format!("{}:", letter);
        if prefix.eq_ignore_ascii_case(&system_drive) {
            continue;
        }
        let root = format!("{}:\\", letter);
        if let Ok(c) = std::ffi::CString::new(root.clone()) {
            // DRIVE_FIXED == 3
            let dtype = unsafe { winapi::um::fileapi::GetDriveTypeA(c.as_ptr()) };
            if dtype == 3 {
                roots.push(root);
            }
        }
    }
    roots
}

#[cfg(not(target_os = "windows"))]
fn auto_scan_roots() -> Vec<String> {
    Vec::new()
}

/// Mutable state shared across one full discovery scan: accumulated apps, a
/// path-dedup set, the icon cache dir, and a hard work budget (visited-entry
/// count + wall-clock deadline) so an exe-less tree — e.g. a huge media cache —
/// can never stall the background scan.
struct ScanState<'a> {
    icons_dir: &'a Path,
    apps: Vec<AppItem>,
    seen: HashSet<String>,
    budget: u32,
    deadline: std::time::Instant,
}

impl<'a> ScanState<'a> {
    fn new(icons_dir: &'a Path, seen: HashSet<String>) -> Self {
        Self {
            icons_dir,
            apps: Vec::new(),
            seen,
            // Safety valve only: high enough that a normal multi-drive scan
            // always finishes, low enough to bound a truly pathological tree
            // (millions of files). Must NOT truncate real drives — doing so
            // silently drops whatever sorts last (e.g. an "E:\yuzusoft" folder).
            budget: 3_000_000,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(120),
        }
    }

    fn out_of_budget(&self) -> bool {
        self.apps.len() >= 2000
            || self.budget == 0
            || std::time::Instant::now() >= self.deadline
    }

    /// Add one app entry, deduped by chosen exe path (case-insensitive).
    fn push_app(&mut self, name: String, exe_path: &Path) {
        let path_str = exe_path.to_string_lossy().to_string();
        if !self.seen.insert(path_str.to_lowercase()) {
            return;
        }
        self.apps
            .push(make_app_item(name, path_str.clone(), path_str, self.icons_dir));
    }

    /// Classify a directory: a folder that *directly* contains a launchable exe
    /// IS one application (emit one entry, stop descending); otherwise it is a
    /// container, so recurse into its sub-folders. Self-adapts to any nesting
    /// depth. System folders and installer/updater exes are skipped throughout.
    fn detect(&mut self, dir: &Path, depth: usize, root: &Path) {
        const MAX_DEPTH: usize = 6;
        if self.out_of_budget() {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        let mut direct_exes: Vec<ExeCandidate> = Vec::new();
        let mut subdirs: Vec<std::path::PathBuf> = Vec::new();

        for entry in entries.flatten() {
            if self.budget == 0 {
                return;
            }
            self.budget -= 1;
            if entry_is_hidden(&entry) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let dname = entry.file_name().to_string_lossy().to_lowercase();
                if !is_system_dir(&dname) {
                    subdirs.push(entry.path());
                }
            } else if file_type.is_file() {
                let path = entry.path();
                if !path
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
                {
                    continue;
                }
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if stem.is_empty() || is_noise_exe(&stem.to_lowercase()) {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                direct_exes.push(ExeCandidate { stem, size, path });
            }
        }

        if !direct_exes.is_empty() {
            let name = app_name_for(dir, root);
            let refs: Vec<&ExeCandidate> = direct_exes.iter().collect();
            let idx = pick_main_exe(&refs, &name);
            self.push_app(name, &direct_exes[idx].path);
            return;
        }

        if depth < MAX_DEPTH {
            for sub in subdirs {
                self.detect(&sub, depth + 1, root);
            }
        }
    }

    /// Auto-discover apps on secondary drives: every non-system top-level folder
    /// on each fixed drive is walked as its own library root.
    fn auto_scan(&mut self) {
        for root in auto_scan_roots() {
            if self.out_of_budget() {
                break;
            }
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry_is_hidden(&entry) {
                    continue;
                }
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let dname = entry.file_name().to_string_lossy().to_lowercase();
                if is_system_dir(&dname) {
                    continue;
                }
                let sub = entry.path();
                self.detect(&sub, 0, &sub);
            }
        }
    }

    /// Walk each user-configured library path — a supplement to the auto scan
    /// (e.g. a folder on the system drive, or a non-standard location).
    fn scan_dirs(&mut self, dirs: &[String]) {
        for root in dirs {
            let root = root.trim();
            if root.is_empty() {
                continue;
            }
            let root_path = Path::new(root);
            if !root_path.is_dir() {
                eprintln!("[FromZero] Custom app dir not found, skipping: {}", root);
                continue;
            }
            self.detect(root_path, 0, root_path);
        }
    }
}

/// Full app index: Start Menu shortcuts + auto-discovered apps on secondary
/// drives + user-configured supplemental directories. Deduped by exe path.
pub fn scan_all(app_handle: &AppHandle) -> Vec<AppItem> {
    let mut apps = scan_start_menu(app_handle);
    let Ok(cache_dir) = app_handle.path().app_cache_dir() else {
        return apps;
    };
    let icons_dir = cache_dir.join("icons");
    let _ = fs::create_dir_all(&icons_dir);

    // Seed dedup with Start Menu targets so a game already pinned there isn't
    // duplicated by the drive walk.
    let seen: HashSet<String> = apps.iter().map(|a| a.target.to_lowercase()).collect();
    let mut state = ScanState::new(&icons_dir, seen);

    state.auto_scan();

    let settings = crate::settings::load_settings(app_handle);
    if !settings.custom_app_dirs.is_empty() {
        state.scan_dirs(&settings.custom_app_dirs);
    }

    apps.extend(state.apps);
    eprintln!("[FromZero] scan_all total {} apps", apps.len());
    apps
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
                eprintln!(
                    "[FromZero] Failed to resolve cache directory for icon extraction: {}",
                    e
                );
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
        let sanitized_thread_id: String =
            thread_id.chars().filter(|c| c.is_alphanumeric()).collect();
        let temp_json_path =
            cache_dir.join(format!("icon_targets_{}_{}.json", now, sanitized_thread_id));

        if let Ok(json_content) = serde_json::to_string(&items_to_extract) {
            if fs::write(&temp_json_path, json_content).is_ok() {
                #[cfg(target_os = "windows")]
                use std::os::windows::process::CommandExt;

                let sys_root =
                    std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
                let powershell_path = format!(
                    "{}\\{}",
                    sys_root, "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                );
                let mut cmd = std::process::Command::new(powershell_path);
                cmd.args([
                    "-NoProfile",
                    "-WindowStyle", "Hidden",
                    "-Command",
                    r#"Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconExtractor {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint PrivateExtractIcons(string lpszFile, int nIconIndex, int cxIcon, int cyIcon, IntPtr[] phicon, uint[] piconid, uint nIcons, uint flags);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $items = Get-Content $env:TEMP_JSON_PATH -Raw -Encoding UTF8 | ConvertFrom-Json; foreach ($item in $items) { try { if ([System.IO.File]::Exists($item.target)) { $phicon = New-Object IntPtr[] 1; $piconid = New-Object uint32[] 1; $extracted = [IconExtractor]::PrivateExtractIcons($item.target, 0, 256, 256, $phicon, $piconid, 1, 0); if ($extracted -gt 0 -and $phicon[0] -ne [IntPtr]::Zero) { $icon = [System.Drawing.Icon]::FromHandle($phicon[0]); $bmp = $icon.ToBitmap(); $bmp.Save($item.icon_path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $icon.Dispose(); [void][IconExtractor]::DestroyIcon($phicon[0]); Write-Output $item.path; } else { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($item.target); $bmp = $icon.ToBitmap(); $bmp.Save($item.icon_path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $icon.Dispose(); Write-Output $item.path; } } } catch { Write-Warning "Icon extraction failed for $($item.target): $($_.Exception.Message)" } }"#
                ]);
                cmd.env("TEMP_JSON_PATH", &temp_json_path);

                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

                if let Ok(output) =
                    run_command_with_timeout(cmd, std::time::Duration::from_secs(15))
                {
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
                let sys_root =
                    std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
                let taskkill_path = format!("{}\\{}", sys_root, "System32\\taskkill.exe");
                let mut kill_cmd = std::process::Command::new(taskkill_path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_pinyin_chinese() {
        let (initials, full) = get_pinyin("微信");
        assert_eq!(initials, "wx");
        assert_eq!(full, "weixin");
    }

    #[test]
    fn test_get_pinyin_english() {
        let (initials, full) = get_pinyin("Chrome");
        assert_eq!(initials, "chrome");
        assert_eq!(full, "chrome");
    }

    #[test]
    fn test_get_pinyin_mixed() {
        let (initials, full) = get_pinyin("微信WeChat");
        assert_eq!(initials, "wxwechat");
        assert_eq!(full, "weixinwechat");
    }

    #[test]
    fn test_get_pinyin_empty() {
        let (initials, full) = get_pinyin("");
        assert_eq!(initials, "");
        assert_eq!(full, "");
    }

    #[test]
    fn test_get_path_hash_deterministic() {
        let hash1 = get_path_hash("C:\\Program Files\\App\\app.exe");
        let hash2 = get_path_hash("C:\\Program Files\\App\\app.exe");
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_get_path_hash_different_inputs() {
        let hash1 = get_path_hash("C:\\App1\\app.exe");
        let hash2 = get_path_hash("C:\\App2\\app.exe");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_get_path_hash_empty() {
        let hash = get_path_hash("");
        // FNV offset basis
        assert_eq!(hash, 0xcbf29ce484222325);
    }

    #[test]
    fn test_is_noise_exe_filters_aux_tools() {
        assert!(is_noise_exe("unins000"));
        assert!(is_noise_exe("setup"));
        assert!(is_noise_exe("vcredist_x64"));
        assert!(is_noise_exe("dxwebsetup"));
        assert!(is_noise_exe("crashreporter"));
        assert!(is_noise_exe("config"));
        assert!(is_noise_exe("game_uninstall"));
    }

    #[test]
    fn test_is_noise_exe_keeps_real_programs() {
        assert!(!is_noise_exe("siglusengine"));
        assert!(!is_noise_exe("photoshop"));
        assert!(!is_noise_exe("maingame"));
        assert!(!is_noise_exe("launcher"));
        // Segment matching must NOT drop titles that merely contain a token.
        assert!(!is_noise_exe("terror")); // contains "error"
        assert!(!is_noise_exe("dispatch")); // contains "patch"
        assert!(!is_noise_exe("reinstall")); // contains "install"
        assert!(!is_noise_exe("settingsun")); // contains "setting"
    }

    #[test]
    fn test_is_system_dir() {
        assert!(is_system_dir("windows"));
        assert!(is_system_dir("program files"));
        assert!(is_system_dir("$recycle.bin"));
        // Not a denylist of products — normal app/game folders pass through.
        assert!(!is_system_dir("9-nine"));
        assert!(!is_system_dir("steam"));
        assert!(!is_system_dir("photoshop"));
    }

    #[test]
    fn test_app_name_for() {
        let root = Path::new(r"E:\yuzusoft");
        // Real title folder used verbatim (publisher/game layout).
        assert_eq!(
            app_name_for(Path::new(r"E:\yuzusoft\RIDDLE JOKER"), root),
            "RIDDLE JOKER"
        );
        // Generic container -> use the parent (game) folder name.
        assert_eq!(
            app_name_for(Path::new(r"E:\yuzusoft\SomeGame\bin"), root),
            "SomeGame"
        );
        // Nested generic containers -> climb until a real title folder.
        assert_eq!(
            app_name_for(Path::new(r"E:\yuzusoft\SomeGame\game\bin"), root),
            "SomeGame"
        );
        // The scan root itself keeps its own name (never climbs above root).
        assert_eq!(app_name_for(root, root), "yuzusoft");
    }

    #[test]
    fn test_pick_main_exe_generic_signals() {
        let mk = |stem: &str, size: u64| ExeCandidate {
            stem: stem.to_string(),
            size,
            path: std::path::PathBuf::from(format!(r"E:\lib\g\{}.exe", stem)),
        };
        // Launcher-style name wins even against a larger engine binary.
        let a = vec![mk("nine_kokoiro", 50 * 1024 * 1024), mk("启动游戏", 1024)];
        let ar: Vec<&ExeCandidate> = a.iter().collect();
        assert_eq!(pick_main_exe(&ar, "9-nine"), 1);

        // No hint and no name match -> largest binary wins.
        let b = vec![mk("tool", 1024), mk("bigapp", 90 * 1024 * 1024)];
        let br: Vec<&ExeCandidate> = b.iter().collect();
        assert_eq!(pick_main_exe(&br, "SomeApp"), 1);

        // Name matching the app folder wins over a bigger unrelated binary.
        let c = vec![mk("helper2", 80 * 1024 * 1024), mk("PhotoShop", 5 * 1024 * 1024)];
        let cr: Vec<&ExeCandidate> = c.iter().collect();
        assert_eq!(pick_main_exe(&cr, "PhotoShop"), 1);
    }
}
