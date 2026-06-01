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
        $paths = @("C:\ProgramData\Microsoft\Windows\Start Menu\Programs");
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

    let output = cmd.output();

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

        // Create temporary JSON file in cache folder to handle unlimited item counts safely without CLI args limits
        let cache_dir = app_handle.path().app_cache_dir().unwrap_or_default();
        let temp_json_path = cache_dir.join("icon_targets.json");
        
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

                if let Ok(output) = cmd.output() {
                    let out_str = String::from_utf8_lossy(&output.stdout);
                    for line in out_str.lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            let _ = app_handle.emit("icon-ready", trimmed.to_string());
                        }
                    }
                }
            }
            // Clean up temporary JSON file
            let _ = fs::remove_file(&temp_json_path);
        }
    });
}
