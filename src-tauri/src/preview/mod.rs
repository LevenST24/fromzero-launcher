//! Unified file preview pipeline.
//!
//! Flow: path → resolve → classify(ext) → strategy → FilePreview
//! Strategies never dump multi-MB binaries over IPC; media uses the asset protocol.

mod archive;
mod office;

use std::io::Read;
use std::path::{Path, PathBuf};

/// IPC payload for the frontend preview panel.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FilePreview {
    /// Renderer key: image | pdf | audio | video | text | office | archive | folder | binary
    pub file_type: String,
    /// Text/listing body, or "asset" when the webview should load via convertFileSrc.
    pub content: String,
    pub size: u64,
    pub modified: u64,
}

/// How the frontend should render this preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewKind {
    Image,
    Pdf,
    Audio,
    Video,
    Text,
    OfficePptx,
    OfficeDocx,
    OfficeXlsx,
    Archive7z,
    ArchiveZip,
    ArchiveTar,
    ArchiveGzip,
    Binary,
}

const ASSET: &str = "asset";
/// Marker: frontend must load via blob from `read_preview_bytes` (not asset iframe).
/// WebView2/Edge blocks embedding PDF from asset.localhost in sandboxed/cross-origin frames.
const BLOB: &str = "blob";

const MAX_IMAGE: u64 = 25 * 1024 * 1024;
const MAX_PDF: u64 = 40 * 1024 * 1024;
const MAX_AUDIO: u64 = 80 * 1024 * 1024;
const MAX_VIDEO: u64 = 100 * 1024 * 1024;
const TEXT_BYTES: u64 = 48 * 1024;
const TEXT_LINES: usize = 40;
const FOLDER_ITEMS: usize = 20;

fn ok(file_type: &str, content: String, size: u64, modified: u64) -> FilePreview {
    FilePreview {
        file_type: file_type.to_string(),
        content,
        size,
        modified,
    }
}

fn asset_or_too_large(size: u64, max: u64) -> String {
    if size > max {
        String::new()
    } else {
        ASSET.to_string()
    }
}

/// Extension → kind registry. Add new formats here only.
fn classify(ext: &str) -> PreviewKind {
    match ext {
        // Media (asset protocol)
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" => PreviewKind::Image,
        "pdf" => PreviewKind::Pdf,
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" | "wma" | "opus" => PreviewKind::Audio,
        "mp4" | "webm" | "ogv" | "mov" | "mkv" | "avi" => PreviewKind::Video,

        // Office Open XML (text extract)
        "pptx" | "pptm" => PreviewKind::OfficePptx,
        "docx" | "docm" => PreviewKind::OfficeDocx,
        "xlsx" | "xlsm" => PreviewKind::OfficeXlsx,

        // Archives (entry list)
        "7z" => PreviewKind::Archive7z,
        "zip" | "jar" | "apk" | "epub" | "whl" | "nupkg" | "vsix" => PreviewKind::ArchiveZip,
        "tar" => PreviewKind::ArchiveTar,
        "gz" | "tgz" => PreviewKind::ArchiveGzip,

        // Plain / source text
        "txt" | "md" | "markdown" | "json" | "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs"
        | "rs" | "css" | "scss" | "less" | "html" | "htm" | "vue" | "svelte" | "py" | "sh"
        | "bash" | "zsh" | "bat" | "cmd" | "ps1" | "toml" | "yaml" | "yml" | "ini" | "log"
        | "conf" | "cfg" | "xml" | "csv" | "tsv" | "c" | "cpp" | "cc" | "h" | "hpp" | "java"
        | "kt" | "go" | "rb" | "php" | "sql" | "r" | "swift" | "gitignore" | "env"
        | "dockerfile" | "makefile" => PreviewKind::Text,

        _ => PreviewKind::Binary,
    }
}

fn kind_label(kind: PreviewKind) -> &'static str {
    match kind {
        PreviewKind::Image => "image",
        PreviewKind::Pdf => "pdf",
        PreviewKind::Audio => "audio",
        PreviewKind::Video => "video",
        PreviewKind::Text => "text",
        PreviewKind::OfficePptx | PreviewKind::OfficeDocx | PreviewKind::OfficeXlsx => "office",
        PreviewKind::Archive7z
        | PreviewKind::ArchiveZip
        | PreviewKind::ArchiveTar
        | PreviewKind::ArchiveGzip => "archive",
        PreviewKind::Binary => "binary",
    }
}

/// Build a folder listing preview.
fn preview_folder(path: &Path, modified: u64, is_hidden: &dyn Fn(&std::fs::DirEntry) -> bool) -> FilePreview {
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if items.len() >= FOLDER_ITEMS {
                break;
            }
            if is_hidden(&entry) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            items.push(format!("{} {}", if is_dir { "📁" } else { "📄" }, name));
        }
    }
    ok("folder", items.join("\n"), 0, modified)
}

fn preview_text_file(path: &Path, size: u64, modified: u64) -> FilePreview {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return ok(
                "binary",
                format!("无法打开文件: {}", e),
                size,
                modified,
            );
        }
    };
    let mut handle = file.take(TEXT_BYTES);
    let mut buffer = Vec::new();
    if handle.read_to_end(&mut buffer).is_err() {
        return ok("binary", String::new(), size, modified);
    }
    if buffer.iter().take(512).any(|&b| b == 0) {
        return ok("binary", String::new(), size, modified);
    }
    let text = String::from_utf8_lossy(&buffer);
    let lines: Vec<&str> = text.lines().take(TEXT_LINES).collect();
    let truncated =
        text.lines().nth(TEXT_LINES).is_some() || (size as usize) > buffer.len();
    let mut body = lines.join("\n");
    if truncated {
        body.push_str("\n…");
    }
    ok("text", body, size, modified)
}

fn extract_or_err(
    label: &str,
    result: Result<String, String>,
    size: u64,
    modified: u64,
) -> FilePreview {
    match result {
        Ok(content) => ok(label, content, size, modified),
        Err(e) => ok(label, format!("预览失败: {}", e), size, modified),
    }
}

/// Classify and render a single path. Caller must already enforce path safety.
pub fn build_preview(
    path: &Path,
    is_hidden: &dyn Fn(&std::fs::DirEntry) -> bool,
) -> Result<FilePreview, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if metadata.is_dir() {
        return Ok(preview_folder(path, modified, is_hidden));
    }

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = classify(&ext);
    let label = kind_label(kind);

    let preview = match kind {
        PreviewKind::Image => ok(label, asset_or_too_large(size, MAX_IMAGE), size, modified),
        // PDF: blob path (Edge blocks asset:// iframe PDF viewer)
        PreviewKind::Pdf => ok(
            label,
            if size > MAX_PDF {
                String::new()
            } else {
                BLOB.to_string()
            },
            size,
            modified,
        ),
        PreviewKind::Audio => ok(label, asset_or_too_large(size, MAX_AUDIO), size, modified),
        PreviewKind::Video => ok(label, asset_or_too_large(size, MAX_VIDEO), size, modified),
        PreviewKind::Text => preview_text_file(path, size, modified),
        PreviewKind::OfficePptx => {
            extract_or_err(label, office::preview_pptx(path), size, modified)
        }
        PreviewKind::OfficeDocx => {
            extract_or_err(label, office::preview_docx(path), size, modified)
        }
        PreviewKind::OfficeXlsx => {
            extract_or_err(label, office::preview_xlsx(path), size, modified)
        }
        PreviewKind::Archive7z => extract_or_err(label, archive::preview_7z(path), size, modified),
        PreviewKind::ArchiveZip => {
            extract_or_err(label, archive::preview_zip(path), size, modified)
        }
        PreviewKind::ArchiveTar => {
            extract_or_err(label, archive::preview_tar(path), size, modified)
        }
        PreviewKind::ArchiveGzip => {
            ok(label, archive::preview_gzip_hint(path, size), size, modified)
        }
        PreviewKind::Binary => ok(label, String::new(), size, modified),
    };

    Ok(preview)
}

/// Resolve + safety gate used by the Tauri command.
pub fn resolve_preview_path(
    raw: &str,
    is_safe: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !is_safe(&path) {
        return Err("安全限制: 不允许访问网络或共享(UNC)路径。".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("路径解析失败: {}", e))?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", raw));
    }
    Ok(path)
}

/// Load bytes for blob-based preview (currently PDF only).
/// Hard size cap matches MAX_PDF; extension whitelist prevents arbitrary reads abuse.
pub fn read_preview_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // Only formats that must use blob: (WebView2 cannot embed these via asset iframe)
    let allowed = matches!(ext.as_str(), "pdf");
    if !allowed {
        return Err(format!("不支持的预览字节类型: .{}", ext));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_PDF {
        return Err(format!(
            "文件过大（{} MB），无法内嵌预览",
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read(path).map_err(|e| format!("无法读取文件: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_common_exts() {
        assert_eq!(classify("png"), PreviewKind::Image);
        assert_eq!(classify("pdf"), PreviewKind::Pdf);
        assert_eq!(classify("pptx"), PreviewKind::OfficePptx);
        assert_eq!(classify("7z"), PreviewKind::Archive7z);
        assert_eq!(classify("zip"), PreviewKind::ArchiveZip);
        assert_eq!(classify("rs"), PreviewKind::Text);
        assert_eq!(classify("exe"), PreviewKind::Binary);
    }
}
