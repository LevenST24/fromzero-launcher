// === File Explorer: file icons & preview panel ===

import { invoke, convertFileSrc } from "./tauri.js";
import { clearChildren } from "./dom.js";
import { state } from "./state.js";

/** Invalidate in-flight preview IPC when selection races */
let previewRequestId = 0;
/** Small LRU-ish cache: path -> FilePreview (metadata + text only, no media bytes) */
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 48;
/** Skip re-fetch if same path is already showing */
let activePreviewPath = null;
let previewDebounceTimeout = null;

function formatFileSize(bytes) {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(unixSec) {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
]);
const DOC_EXTS = new Set([
  "doc",
  "docx",
  "pdf",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
]);
const CODE_EXTS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "rs",
  "py",
  "c",
  "cpp",
  "h",
  "java",
  "go",
  "rb",
  "php",
  "html",
  "css",
  "vue",
  "json",
  "toml",
  "yaml",
  "yml",
]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "flac",
  "ogg",
  "aac",
  "m4a",
  "wma",
  "opus",
]);
const VIDEO_EXTS = new Set(["mp4", "avi", "mkv", "webm", "mov", "ogv"]);

export function getFileIcon(item) {
  if (item.name === "..") return "↩️";
  if (item.is_dir) return "📁";
  const ext = (item.extension || "").toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "🖼️";
  if (ext === "pptx" || ext === "pptm" || ext === "ppt") return "📊";
  if (ext === "docx" || ext === "docm" || ext === "doc") return "📝";
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls") return "📈";
  if (DOC_EXTS.has(ext)) return "📝";
  if (CODE_EXTS.has(ext)) return "💻";
  if (ARCHIVE_EXTS.has(ext)) return "📦";
  if (ext === "txt" || ext === "md" || ext === "log") return "📄";
  if (AUDIO_EXTS.has(ext)) return "🎵";
  if (VIDEO_EXTS.has(ext)) return "🎬";
  return "📄";
}

function cachePreview(path, preview) {
  if (previewCache.has(path)) previewCache.delete(path);
  previewCache.set(path, preview);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
}

function appendPreviewEmpty(parent, message) {
  const empty = document.createElement("div");
  empty.className = "preview-empty";
  empty.textContent = message;
  parent.appendChild(empty);
}

function assetSrcForPath(filePath) {
  try {
    return convertFileSrc(filePath);
  } catch (e) {
    console.warn("[FromZero] convertFileSrc failed:", e);
    return null;
  }
}

/**
 * Frontend preview renderers keyed by backend `file_type`.
 * Asset media: content === "asset" → convertFileSrc(path).
 * Structured text: content is UTF-8 body (office / archive / text / folder lines).
 */
const PREVIEW_RENDERERS = {
  image(el, item, preview) {
    if (preview.content !== "asset") {
      appendPreviewEmpty(el, "图片过大，无法预览");
      return;
    }
    const src = assetSrcForPath(item.data.path);
    if (!src) return appendPreviewEmpty(el, "图片路径无效");
    const img = document.createElement("img");
    img.src = src;
    img.alt = item.data.name || "";
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => {
      clearChildren(el);
      appendPreviewEmpty(el, "图片加载失败");
    };
    el.appendChild(img);
  },
  // WebView2/Edge blocks navigating iframe to asset.localhost PDFs
  // ("此页面已被 Microsoft Edge 阻止"). Serve a blob: URL instead — no sandbox.
  async pdf(el, item, preview) {
    if (preview.content !== "blob" && preview.content !== "asset") {
      appendPreviewEmpty(el, "PDF 过大，无法内嵌预览（可双击用系统打开）");
      return;
    }
    const loading = document.createElement("div");
    loading.className = "preview-empty";
    loading.textContent = "正在加载 PDF…";
    el.appendChild(loading);

    const toBlobUrl = async () => {
      // 1) Prefer fetch via asset protocol (binary, no JSON IPC bloat)
      const assetUrl = assetSrcForPath(item.data.path);
      if (assetUrl) {
        try {
          const res = await fetch(assetUrl, { cache: "no-store" });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            return URL.createObjectURL(
              new Blob([buf], { type: "application/pdf" }),
            );
          }
        } catch (e) {
          console.warn("[FromZero] PDF asset fetch failed, trying IPC:", e);
        }
      }
      // 2) Fallback: Rust reads bytes (works even if fetch/CSP fails)
      const bytes = await invoke("read_preview_bytes", {
        path: item.data.path,
      });
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return URL.createObjectURL(new Blob([u8], { type: "application/pdf" }));
    };

    try {
      const blobUrl = await toBlobUrl();
      if (!el.isConnected) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (_) {}
        return;
      }
      clearChildren(el);
      const iframe = document.createElement("iframe");
      // Compact chrome inside the side panel
      iframe.src = `${blobUrl}#toolbar=0&navpanes=0&scrollbar=1`;
      iframe.title = item.data.name || "PDF";
      iframe.className = "preview-pdf";
      iframe.dataset.blobUrl = blobUrl;
      // Do NOT set sandbox — Edge PDF viewer needs full frame privileges
      el.appendChild(iframe);
    } catch (err) {
      console.error("[FromZero] PDF preview error:", err);
      if (!el.isConnected) return;
      clearChildren(el);
      appendPreviewEmpty(el, "PDF 加载失败，可双击用系统默认应用打开");
    }
  },
  audio(el, item, preview) {
    if (preview.content !== "asset") {
      appendPreviewEmpty(el, "音频过大，无法预览");
      return;
    }
    const src = assetSrcForPath(item.data.path);
    if (!src) return appendPreviewEmpty(el, "音频路径无效");
    const audio = document.createElement("audio");
    audio.src = src;
    audio.controls = true;
    audio.preload = "metadata";
    audio.setAttribute("controlsList", "nodownload");
    audio.className = "preview-audio";
    el.appendChild(audio);
  },
  video(el, item, preview) {
    if (preview.content !== "asset") {
      appendPreviewEmpty(el, "视频过大，无法预览");
      return;
    }
    const src = assetSrcForPath(item.data.path);
    if (!src) return appendPreviewEmpty(el, "视频路径无效");
    const video = document.createElement("video");
    video.src = src;
    video.controls = true;
    video.preload = "metadata";
    video.className = "preview-video";
    el.appendChild(video);
  },
  text(el, _item, preview) {
    if (!preview.content) return appendPreviewEmpty(el, "无文本内容");
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = preview.content;
    el.appendChild(pre);
  },
  office(el, _item, preview) {
    if (!preview.content) return appendPreviewEmpty(el, "无法提取文档内容");
    const pre = document.createElement("pre");
    pre.className = "preview-office";
    pre.textContent = preview.content;
    el.appendChild(pre);
  },
  archive(el, _item, preview) {
    if (!preview.content) return appendPreviewEmpty(el, "无法读取压缩包");
    const pre = document.createElement("pre");
    pre.className = "preview-archive";
    pre.textContent = preview.content;
    el.appendChild(pre);
  },
  folder(el, _item, preview) {
    const ul = document.createElement("ul");
    ul.className = "folder-list";
    if (preview.content) {
      preview.content.split("\n").forEach((line) => {
        if (!line.trim()) return;
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      });
    }
    if (!ul.childElementCount) return appendPreviewEmpty(el, "空文件夹");
    el.appendChild(ul);
  },
  binary(el) {
    appendPreviewEmpty(el, "不可直接预览");
  },
};

function renderPreviewBody(previewContent, item, preview) {
  clearChildren(previewContent);
  const renderer =
    PREVIEW_RENDERERS[preview.file_type] || PREVIEW_RENDERERS.binary;
  try {
    const maybePromise = renderer(previewContent, item, preview);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.catch((err) => {
        console.error("[FromZero] Preview renderer error:", err);
        if (previewContent.isConnected && !previewContent.childElementCount) {
          appendPreviewEmpty(previewContent, "预览渲染失败");
        }
      });
    }
  } catch (err) {
    console.error("[FromZero] Preview renderer threw:", err);
    appendPreviewEmpty(previewContent, "预览渲染失败");
  }
}

async function showPreview(item) {
  const previewPanel = document.getElementById("preview-panel");
  const previewHeader = document.getElementById("preview-header");
  const previewMeta = document.getElementById("preview-meta");
  const previewContent = document.getElementById("preview-content");
  if (!previewPanel || !previewHeader || !previewMeta || !previewContent)
    return;

  if (!item || (item.type !== "file" && item.type !== "dir")) {
    previewPanel.classList.remove("active");
    activePreviewPath = null;
    return;
  }

  const requestedPath = item.data.path;
  // Same path already rendered — skip redundant work
  if (activePreviewPath === requestedPath && previewPanel.classList.contains("active")) {
    return;
  }

  const requestId = ++previewRequestId;
  previewPanel.classList.add("active");
  previewHeader.textContent = item.data.name || "";

  const applyPreview = (preview) => {
    if (requestId !== previewRequestId) return;
    const selected = state.filteredItems[state.selectedIndex];
    if (!selected || !selected.data || selected.data.path !== requestedPath) {
      return;
    }
    const metaParts = [];
    if (preview.size > 0) metaParts.push(formatFileSize(preview.size));
    if (preview.modified) metaParts.push(formatDate(preview.modified));
    if (preview.file_type && preview.file_type !== "binary") {
      metaParts.push(preview.file_type.toUpperCase());
    }
    previewMeta.textContent = metaParts.join(" · ") || "";
    renderPreviewBody(previewContent, item, preview);
    activePreviewPath = requestedPath;
  };

  const cached = previewCache.get(requestedPath);
  if (cached) {
    // Move to end (recent)
    cachePreview(requestedPath, cached);
    applyPreview(cached);
    return;
  }

  previewMeta.textContent = "加载中...";
  clearChildren(previewContent);

  try {
    const preview = await invoke("get_file_preview", { path: requestedPath });
    if (requestId !== previewRequestId) return;
    cachePreview(requestedPath, preview);
    applyPreview(preview);
  } catch (e) {
    if (requestId !== previewRequestId) return;
    previewMeta.textContent = "预览失败";
    clearChildren(previewContent);
    appendPreviewEmpty(previewContent, "无法加载预览");
    activePreviewPath = null;
  }
}

export function hidePreview() {
  clearTimeout(previewDebounceTimeout);
  previewRequestId++; // cancel in-flight showPreview
  activePreviewPath = null;
  const previewPanel = document.getElementById("preview-panel");
  if (previewPanel) previewPanel.classList.remove("active");
  const previewContent = document.getElementById("preview-content");
  if (previewContent) clearChildren(previewContent);
}

export function triggerPreview(item) {
  clearTimeout(previewDebounceTimeout);
  // 80ms: enough to coalesce rapid hover without feeling laggy
  previewDebounceTimeout = setTimeout(() => {
    showPreview(item);
  }, 80);
}
