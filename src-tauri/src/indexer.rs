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
}
