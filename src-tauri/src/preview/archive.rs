//! List archive contents for the preview panel (no full extract).
//!
//! ZIP/7z only need the central directory / header — multi‑GB packs are fine.
//! We never decompress member payloads for preview.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// How many member paths to show in the panel (not a size limit on the archive).
const MAX_ENTRIES_LIST: usize = 60;
/// TAR must walk headers sequentially; stop after this many headers so huge
/// tarballs don't freeze the UI (we still show "at least N items").
const MAX_TAR_SCAN: usize = 500;

fn format_size(bytes: u64) -> String {
    if bytes == 0 {
        return "—".to_string();
    }
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
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
    archive_bytes: u64,
    total: usize,
    total_is_exact: bool,
    entries: &[(bool, String, u64)],
) -> String {
    let mut out = String::new();
    let count_label = if total_is_exact {
        format!("共 {} 项", total)
    } else {
        format!("至少 {} 项", total)
    };
    out.push_str(&format!(
        "📦 {} · {} · 包体积 {}\n\n",
        kind_label,
        count_label,
        format_size(archive_bytes)
    ));
    for (is_dir, name, size) in entries {
        let icon = if *is_dir { "📁" } else { "📄" };
        if *is_dir {
            out.push_str(&format!("{} {}\n", icon, name));
        } else {
            out.push_str(&format!("{} {}  ({})\n", icon, name, format_size(*size)));
        }
    }
    if total > entries.len() || !total_is_exact {
        let more = total.saturating_sub(entries.len());
        if more > 0 {
            out.push_str(&format!("\n… 另有 {} 项未显示", more));
        } else if !total_is_exact {
            out.push_str("\n… 条目过多，仅展示部分");
        }
    }
    out.trim_end().to_string()
}

/// ZIP / JAR / APK / EPUB / (etc.) listing via the `zip` crate.
pub fn preview_zip(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    let archive_bytes = meta.len();
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    // ZipArchive reads the end-of-central-directory; it does not load all payloads.
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("无法读取 ZIP: {}", e))?;

    let total = archive.len();
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    // Prefer a stable sample: first MAX_ENTRIES_LIST entries by index, then sort for display
    let take_n = total.min(MAX_ENTRIES_LIST);
    for i in 0..take_n {
        let Ok(f) = archive.by_index(i) else {
            continue;
        };
        let name = f.name().replace('\\', "/");
        let is_dir = f.is_dir() || name.ends_with('/');
        let size = f.size();
        let display = name.trim_end_matches('/').to_string();
        if display.is_empty() {
            continue;
        }
        entries.push((is_dir, display, size));
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));

    Ok(format_listing(
        "ZIP 压缩包",
        archive_bytes,
        total,
        true,
        &entries,
    ))
}

/// 7z archive listing via sevenz-rust2 (header/metadata only, no member extract).
pub fn preview_7z(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    let archive_bytes = meta.len();

    use sevenz_rust2::{ArchiveReader, Password};

    // Opens and parses the 7z header; solid multi‑GB archives are OK for listing.
    let reader = ArchiveReader::open(path, Password::empty()).map_err(|e| {
        let msg = e.to_string();
        if msg.to_lowercase().contains("password") || msg.to_lowercase().contains("encrypt") {
            format!("无法读取 7z（可能已加密）: {}", msg)
        } else {
            format!("无法读取 7z: {}", msg)
        }
    })?;

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

    Ok(format_listing(
        "7z 压缩包",
        archive_bytes,
        total,
        true,
        &shown,
    ))
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
/// Sequential scan; capped at MAX_TAR_SCAN headers so multi‑GB tars stay responsive.
pub fn preview_tar(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    let archive_bytes = meta.len();

    // Minimal USTAR tar listing without extra crate:
    // 512-byte headers, name at 0..100, size octal at 124..136, typeflag at 156.
    let mut file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    let mut total = 0usize;
    let mut truncated_scan = false;
    let mut header = [0u8; 512];

    loop {
        if total >= MAX_TAR_SCAN {
            truncated_scan = true;
            break;
        }
        if file.read_exact(&mut header).is_err() {
            break;
        }
        // End of archive: zero block
        if header.iter().all(|&b| b == 0) {
            break;
        }
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
    Ok(format_listing(
        "TAR 归档",
        archive_bytes,
        total,
        !truncated_scan,
        &entries,
    ))
}
