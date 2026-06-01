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
    let mut seen_names = HashSet::new();

    // PowerShell script to recursively query start menu and resolve all shortcut links safely using WScript.Shell COM
    let ps_command = r#"
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

            let cache_dir = app_handle.path().app_cache_dir().unwrap_or_default();
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

                // Prevent duplicates with same name (keep first occurrence)
                if seen_names.contains(&item.name) {
                    continue;
                }
                seen_names.insert(item.name.clone());

                // Generate safe cached icon path
                let icon_name = format!("{:x}.png", md5_hash(&item.path));
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

fn md5_hash(input: &str) -> u128 {
    let mut hash: u128 = 0;
    for byte in input.bytes() {
        hash = hash.wrapping_add(byte as u128);
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

pub fn trigger_icon_extraction(app_handle: AppHandle, apps: Vec<AppItem>) {
    thread::spawn(move || {
        for app in apps {
            let icon_path = Path::new(&app.icon_path);
            if icon_path.exists() {
                continue; // Already cached
            }

            let target_path = &app.target;
            if !Path::new(target_path).exists() {
                continue;
            }

            // Extract using PowerShell Draw Icon API
            let ps_script = format!(
                r#"Add-Type -AssemblyName System.Drawing; [System.Drawing.Icon]::ExtractAssociatedIcon('{}').ToBitmap().Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)"#,
                target_path.replace('\'', "''"),
                app.icon_path.replace('\'', "''")
            );

            // Execute completely hidden in the background without console flashing
            #[cfg(target_os = "windows")]
            use std::os::windows::process::CommandExt;

            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps_script]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

            let status = cmd.status();

            if let Ok(s) = status {
                if s.success() {
                    let _ = app_handle.emit("icon-ready", app.path.clone());
                }
            }
        }
    });
}
