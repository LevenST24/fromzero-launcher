//! List archive contents for the preview panel (no full extract).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// Read is used by File::read_exact in preview_tar

const MAX_ARCHIVE_SIZE: u64 = 200 * 1024 * 1024;
const MAX_ENTRIES_LIST: usize = 40;

fn format_size(bytes: u64) -> String {
    if bytes == 0 {
        return "—".to_string();
    }
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut i = 0;
    while size >= 1024.0 && i < UNITS.len() - 1 {
        size /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[i])
    } else {
        format!("{:.1} {}", size, UNITS[i])
    }
}

fn format_listing(
    kind_label: &str,
    total: usize,
    entries: &[(bool, String, u64)],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("📦 {} · 共 {} 项\n\n", kind_label, total));
    for (is_dir, name, size) in entries {
        let icon = if *is_dir { "📁" } else { "📄" };
        if *is_dir {
            out.push_str(&format!("{} {}\n", icon, name));
        } else {
            out.push_str(&format!("{} {}  ({})\n", icon, name, format_size(*size)));
        }
    }
    if total > entries.len() {
        out.push_str(&format!("\n… 另有 {} 项未显示", total - entries.len()));
    }
    out.trim_end().to_string()
}

/// ZIP / JAR / APK / EPUB / (etc.) listing via the `zip` crate.
pub fn preview_zip(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_ARCHIVE_SIZE {
        return Err("压缩包过大，无法预览".to_string());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("无法读取 ZIP: {}", e))?;

    let total = archive.len();
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    for i in 0..total {
        if entries.len() >= MAX_ENTRIES_LIST {
            break;
        }
        let Ok(f) = archive.by_index(i) else {
            continue;
        };
        let name = f.name().replace('\\', "/");
        // Skip pure directory markers that are empty trailing slash only when already counted
        let is_dir = f.is_dir() || name.ends_with('/');
        let size = f.size();
        let display = name.trim_end_matches('/').to_string();
        if display.is_empty() {
            continue;
        }
        entries.push((is_dir, display, size));
    }

    // Prefer directories first, then by name
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));

    Ok(format_listing("ZIP 压缩包", total, &entries))
}

/// 7z archive listing via sevenz-rust2 (header only, no file extract).
pub fn preview_7z(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_ARCHIVE_SIZE {
        return Err("压缩包过大，无法预览".to_string());
    }

    use sevenz_rust2::{ArchiveReader, Password};

    let reader = ArchiveReader::open(path, Password::empty())
        .map_err(|e| format!("无法读取 7z: {}（若已加密需先用 7-Zip 打开）", e))?;

    let files = &reader.archive().files;
    let total = files.len();
    let mut entries: Vec<(bool, String, u64)> = files
        .iter()
        .map(|e| {
            let name = e.name.replace('\\', "/");
            let is_dir = e.is_directory || name.ends_with('/');
            let display = name.trim_end_matches('/').to_string();
            (is_dir, display, e.size)
        })
        .filter(|(_, name, _)| !name.is_empty())
        .collect();

    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let shown: Vec<_> = entries.into_iter().take(MAX_ENTRIES_LIST).collect();

    Ok(format_listing("7z 压缩包", total, &shown))
}

/// Gzip single-file: show compressed size + tip (no multi-member listing).
pub fn preview_gzip_hint(path: &Path, size: u64) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive.gz".to_string());
    format!(
        "📦 GZIP 压缩文件\n\n📄 {}\n大小: {}\n\n（单文件压缩，无内部目录列表）",
        name,
        format_size(size)
    )
}

/// Best-effort TAR listing (uncompressed .tar only).
pub fn preview_tar(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_ARCHIVE_SIZE {
        return Err("压缩包过大，无法预览".to_string());
    }

    // Minimal USTAR tar listing without extra crate:
    // 512-byte headers, name at 0..100, size octal at 124..136, typeflag at 156.
    let mut file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    let mut total = 0usize;
    let mut header = [0u8; 512];

    loop {
        if file.read_exact(&mut header).is_err() {
            break;
        }
        // End of archive: two zero blocks
        if header.iter().all(|&b| b == 0) {
            break;
        }
        // Basic checksum sanity (optional soft check)
        let name_raw = &header[0..100];
        let name_end = name_raw.iter().position(|&b| b == 0).unwrap_or(100);
        let name = String::from_utf8_lossy(&name_raw[..name_end])
            .trim()
            .replace('\\', "/");
        if name.is_empty() {
            break;
        }
        let size_raw = &header[124..136];
        let size_str = String::from_utf8_lossy(size_raw)
            .trim_matches(|c: char| c == '\0' || c.is_whitespace())
            .to_string();
        let size = u64::from_str_radix(size_str.trim_end_matches('\0').trim(), 8).unwrap_or(0);
        let typeflag = header[156];
        let is_dir = typeflag == b'5' || name.ends_with('/');

        total += 1;
        if entries.len() < MAX_ENTRIES_LIST {
            entries.push((is_dir, name.trim_end_matches('/').to_string(), size));
        }

        // Skip file data (rounded up to 512)
        let skip = ((size + 511) / 512) * 512;
        if skip > 0 {
            file.seek(SeekFrom::Current(skip as i64))
                .map_err(|e| format!("读取 tar 失败: {}", e))?;
        }
    }

    if total == 0 {
        return Err("无法解析 TAR（可能是损坏或非标准格式）".to_string());
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    Ok(format_listing("TAR 归档", total, &entries))
}
