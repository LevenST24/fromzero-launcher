// === FromZero Launcher — Main Frontend Logic ===

// Safe extraction of Tauri APIs with fallback mocks for non-Tauri browser environments/test runner
let invoke, getCurrentWindow, listen, convertFileSrc;

if (window.__TAURI__) {
  invoke = window.__TAURI__.core.invoke;
  getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  const currentWin = getCurrentWindow();
  listen = window.__TAURI__.event
    ? window.__TAURI__.event.listen.bind(window.__TAURI__.event)
    : currentWin.listen.bind(currentWin);
  convertFileSrc = window.__TAURI__.core.convertFileSrc;
  
  // Safe cleanup: delete the global window.__TAURI__ object to protect against XSS command injections
  delete window.__TAURI__;
} else {
  // Setup standard fallback mocks for local web development & test runner compatibility
  console.warn("[FromZero] window.__TAURI__ not found, using development mocks");
  invoke = async (cmd, args) => {
    console.log(`[Mock Invoke] ${cmd}`, args);
    if (cmd === "get_settings") {
      return { shortcut: "Ctrl+Space", theme: "dark", web_engines: { g: "https://google.com/search?q={}" }, recent_apps: [], autostart: false };
    }
    if (cmd === "scan_apps") return [];
    if (cmd === "search_apps") return [];
    return {};
  };
  getCurrentWindow = () => ({
    hide: async () => console.log("[Mock Window] hide"),
    show: async () => console.log("[Mock Window] show"),
    setFocus: async () => console.log("[Mock Window] setFocus"),
    listen: (event, callback) => {
      console.log(`[Mock Window] listen for ${event}`);
      return () => {};
    }
  });
  listen = (event, callback) => getCurrentWindow().listen(event, callback);
  convertFileSrc = (path) => `https://asset.localhost/${encodeURIComponent(path)}`;
}

// App state variables
let appItems = [];
let filteredItems = [];
let selectedIndex = 0;
let settings = {};

// Liquid Glass customizable parameters
let glassSettings = {
  glassBlur: 8,
  borderOpacity: 0.60
};
let backupGlassSettings = null;

// Search debounce and query race condition tracking
let lastSearchId = 0;
let searchDebounceTimeout = null;
let setBlurTimeout = null;

// Focus management: timestamp of last show (for debounce)
let lastShowTime = 0;

// IME Composition state tracking
let isComposing = false;

// File explorer state
let currentDirPath = null;
let previewDebounceTimeout = null;

// Recorded hotkey state
let currentShortcut = "Ctrl+Space";

// Mouse tracking to ignore hover selection during scroll
let lastMouseX = 0;
let lastMouseY = 0;
let pumping = false;

// DOM Elements
const searchInput = document.getElementById("search-input");
const searchIndicator = document.getElementById("search-indicator");
const resultsArea = document.getElementById("results-area");
const welcomeScreen = document.getElementById("welcome-screen");
const recentGrid = document.getElementById("recent-grid");
const resultsList = document.getElementById("results-list");
const footerStatus = document.getElementById("footer-status");

// Settings Modal DOM Elements
const settingsToggle = document.getElementById("settings-toggle");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave = document.getElementById("settings-save");
const shortcutDisplay = document.getElementById("shortcut-display");
const recordBtn = document.getElementById("record-btn");
const themeSelect = document.getElementById("theme-select");
const autostartToggle = document.getElementById("autostart-toggle");
const tabBtnGeneral = document.getElementById("tab-btn-general");
const tabBtnGlass = document.getElementById("tab-btn-glass");
const panelGeneral = document.getElementById("panel-general");
const panelGlass = document.getElementById("panel-glass");

const appWindow = getCurrentWindow();

// System commands helper list
const SYSTEM_COMMANDS = [
  { key: "lock", name: "锁定屏幕 (Lock Screen)", desc: "锁定当前的 Windows 会话", badge: "系统" },
  { key: "sleep", name: "休眠系统 (Sleep)", desc: "使计算机进入低功耗睡眠状态", badge: "系统" },
  { key: "shutdown", name: "关闭计算机 (Shutdown)", desc: "关闭电源并退出所有应用", badge: "警告" },
  { key: "restart", name: "重启计算机 (Restart)", desc: "重新启动操作系统", badge: "系统" }
];

const APP_VERSION = "v0.2.2-preview";

// =============================================
// Window Focus/Blur Management (JS-side with debounce)
// =============================================

window.addEventListener("focus", async () => {
  lastShowTime = Date.now();
  const container = document.getElementById("launcher-container");
  if (container) container.classList.remove("blurred");

  // Start background capture and frame pumping
  try {
    await invoke("start_bg_capture");
    pumping = true;
    pumpFrames();
    // Disable DWM Acrylic when live capture is active to avoid double-blur overlay
    try { await invoke("set_blur", { value: 0 }); } catch (_) {}
  } catch (e) {
    console.warn("[FromZero] Live glass capture unavailable, fallback to Acrylic:", e);
    pumping = false;
    try { await invoke("set_blur", { value: glassSettings.glassBlur }); } catch (_) {}
  }

  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }, 50);
});

window.addEventListener("blur", () => {
  const container = document.getElementById("launcher-container");
  if (container) container.classList.add("blurred");

  // Stop background capture immediately on blur to save GPU/CPU resources
  pumping = false;
  try { invoke("stop_bg_capture"); } catch (_) {}

  // Restore DWM Acrylic for a smooth show/fade transition next time
  try { invoke("set_blur", { value: glassSettings.glassBlur }); } catch (_) {}

  const timeSinceShow = Date.now() - lastShowTime;
  if (timeSinceShow < 300) {
    return;
  }
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    return;
  }
  setTimeout(async () => {
    if (!document.hasFocus()) {
      try {
        await appWindow.hide();
      } catch (e) {
        console.warn("[FromZero] Failed to hide window:", e);
      }
    }
  }, 120);
});

// =============================================
// Helper: generate engine display name from prefix
// =============================================
function getEngineName(prefix) {
  const knownNames = { g: "Google", b: "百度", bi: "Bing", gh: "GitHub" };
  if (knownNames[prefix]) return knownNames[prefix];
  // Fallback: capitalize first letter of prefix
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

// =============================================
// Helper: clear DOM element children safely (no innerHTML)
// =============================================
function clearChildren(el) {
  const mediaElements = el.querySelectorAll("[data-blob-url]");
  mediaElements.forEach(item => {
    if (item.dataset.blobUrl) {
      try {
        URL.revokeObjectURL(item.dataset.blobUrl);
      } catch (err) {
        console.warn("Failed to revoke blob URL:", err);
      }
    }
  });
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}



// Helper: Apply visual configurations to DOM/CSS and SVG filter scales in real time
function applyVisualSettings(config) {
  const container = document.getElementById("launcher-container");
  if (!container) return;

  // Border opacities (static angle, no cursor tracking)
  const b1 = (config.borderOpacity * 0.3).toFixed(3);
  const b2 = (config.borderOpacity * 0.2).toFixed(3);
  container.style.setProperty("--border1-opacity", b1);
  container.style.setProperty("--border2-opacity", b2);

  // === Glass tint layer: opacity controlled by glassBlur slider ===
  // Higher glassBlur = more opaque tint = more frosted look (covers DWM Acrylic blur more).
  // Lower glassBlur = more transparent tint = DWM Acrylic blur more visible.
  const glassBlurLayer = document.querySelector('.glass-blur-layer');
  if (glassBlurLayer) {
    const isDark = !document.documentElement.hasAttribute('data-theme') ||
                   document.documentElement.getAttribute('data-theme') === 'dark';
    // glassBlur 0→0.01 (nearly invisible), 1→0.018, 8→0.074, 30→0.25
    // Low multiplier ensures smooth transition from transparent(0) to slightly frosted(1)
    const tintOpacity = Math.max(0.01, config.glassBlur * 0.008 + 0.01).toFixed(3);
    if (isDark) {
      glassBlurLayer.style.backgroundColor = `rgba(18, 18, 24, ${tintOpacity})`;
    } else {
      glassBlurLayer.style.backgroundColor = `rgba(240, 240, 245, ${tintOpacity})`;
    }
  }

  // Toggle DWM Acrylic: glassBlur=0 → transparent, glassBlur>0 → blurred desktop
  // Debounced to avoid flooding the Rust backend during slider drag
  if (!pumping) {
    clearTimeout(setBlurTimeout);
    setBlurTimeout = setTimeout(() => {
      try { invoke("set_blur", { value: config.glassBlur }); } catch (e) {}
    }, 60);
  }
}

// Helper: Initialize sliders listeners
function initSliderListeners() {
  const sliders = [
    { id: "slider-glass-blur", valId: "val-glass-blur", key: "glassBlur", isFloat: false },
    { id: "slider-border-opacity", valId: "val-border-opacity", key: "borderOpacity", isFloat: true }
  ];

  sliders.forEach(s => {
    const el = document.getElementById(s.id);
    const valEl = document.getElementById(s.valId);
    if (el) {
      el.addEventListener("input", () => {
        const val = s.isFloat ? parseFloat(el.value) : parseInt(el.value);
        if (valEl) {
          valEl.textContent = s.isFloat ? val.toFixed(2) : val;
        }

        // Apply sliders state immediately for live feedback
        const currentConfig = readSlidersState();
        applyVisualSettings(currentConfig);
      });
    }
  });
}

// Helper: Read sliders values
function readSlidersState() {
  return {
    glassBlur: parseInt(document.getElementById("slider-glass-blur").value),
    borderOpacity: parseFloat(document.getElementById("slider-border-opacity").value)
  };
}

// Helper: Sync sliders elements to configurations
function syncSlidersToConfig(config) {
  const mappings = [
    { id: "slider-glass-blur", valId: "val-glass-blur", val: config.glassBlur, isFloat: false },
    { id: "slider-border-opacity", valId: "val-border-opacity", val: config.borderOpacity, isFloat: true }
  ];

  mappings.forEach(m => {
    const el = document.getElementById(m.id);
    const valEl = document.getElementById(m.valId);
    if (el) {
      el.value = m.val;
      if (valEl) {
        valEl.textContent = m.isFloat ? m.val.toFixed(2) : m.val;
      }
    }
  });
}

// =============================================
// Real-time Background Refraction Helpers
// =============================================
const WIN_W = 640;
const WIN_H = 450;
const PAD_X = 40;
const PAD_Y = 40;
const CORNER = 8;
const BAND = 28;

function buildDisplacementMap() {
  const w = WIN_W + PAD_X * 2; // 720
  const h = WIN_H + PAD_Y * 2; // 530
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cx = w / 2;
  const cy = h / 2;
  const hw = WIN_W / 2 - CORNER;
  const hh = WIN_H / 2 - CORNER;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = Math.max(Math.abs(x - cx) - hw, 0);
      const qy = Math.max(Math.abs(y - cy) - hh, 0);
      const q_len = Math.hypot(qx, qy);
      let nx = 0;
      let ny = 0;
      if (q_len > 0) {
        const dist = q_len - CORNER; // SDF to round-rect boundary (<0 is inside)
        if (dist > -BAND && dist < 0) {
          const gx = (qx / q_len) * Math.sign(x - cx);
          const gy = (qy / q_len) * Math.sign(y - cy);
          const t = 1 + dist / BAND; // 0 (inner boundary) -> 1 (outer boundary)
          const k = t * t;           // Quadratic transition
          nx = gx * k;
          ny = gy * k;
        }
      }
      const i = (y * w + x) * 4;
      d[i]     = Math.round(128 + nx * 127); // R channel: X displacement
      d[i + 1] = Math.round(128 + ny * 127); // G channel: Y displacement
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const dispMap = document.getElementById("disp-map");
  if (dispMap) {
    dispMap.setAttribute("href", cv.toDataURL());
  }
}

async function pumpFrames() {
  if (!pumping) return;
  const bgCanvas = document.getElementById("bg-canvas");
  if (!bgCanvas) return;
  const bgCtx = bgCanvas.getContext("2d");
  if (!bgCtx) return;

  const startTime = Date.now();

  try {
    const res = await fetch("http://bgframe.localhost/frame", { cache: "no-store" });
    if (res.status === 200) {
      const w = +res.headers.get("X-Frame-Width");
      const h = +res.headers.get("X-Frame-Height");
      const buf = await res.arrayBuffer();
      if (buf.byteLength === w * h * 4) {
        if (bgCanvas.width !== w || bgCanvas.height !== h) {
          bgCanvas.width = w;
          bgCanvas.height = h;
        }
        bgCtx.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
      }
    }
  } catch (_) {}

  const elapsed = Date.now() - startTime;
  // Dynamic delay targeting 60 FPS (16.6ms) for ultra-low latency frame syncing
  const delay = Math.max(0, 16 - elapsed);
  setTimeout(() => {
    if (pumping) {
      requestAnimationFrame(pumpFrames);
    }
  }, delay);
}

// =============================================
// Initialize application
// =============================================
window.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("[FromZero] Initializing...");
    buildDisplacementMap();
    lastShowTime = Date.now();

    try {
      settings = await invoke("get_settings");
      settings.recent_apps = settings.recent_apps || [];
      settings.web_engines = settings.web_engines || {};
    } catch (e) {
      console.error("[FromZero] Failed to load settings, using empty defaults:", e);
      settings = {};
    }

    // Load Liquid Glass parameters from unified settings
    if (settings.glass_settings) {
      glassSettings.glassBlur = settings.glass_settings.glass_blur ?? glassSettings.glassBlur;
      glassSettings.borderOpacity = settings.glass_settings.border_opacity ?? glassSettings.borderOpacity;
    }
    applyVisualSettings(glassSettings);
    // Set initial DWM Acrylic state based on glassBlur slider
    try {
      await invoke("set_blur", { value: glassSettings.glassBlur });
    } catch (e) {
      console.warn("[FromZero] set_blur init failed:", e);
    }

    applyTheme(settings.theme);
    if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Ctrl+Space";
    if (themeSelect) themeSelect.value = settings.theme || "dark";
    if (autostartToggle) autostartToggle.checked = settings.autostart || false;

    if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 正在扫描开始菜单...`;
    try {
      appItems = await invoke("scan_apps");
      if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 已成功加载 ${appItems.length} 个应用`;
      console.log(`[FromZero] Loaded ${appItems.length} apps`);
    } catch (scanError) {
      console.error("[FromZero] Scan error:", scanError);
      if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 应用扫描失败，请检查日志`;
    }

    renderRecentApps();

    if (searchInput) searchInput.focus();

    if (searchInput) {
      searchInput.addEventListener("compositionstart", () => {
        isComposing = true;
      });
      searchInput.addEventListener("compositionend", () => {
        isComposing = false;
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          searchDebounceTimeout = null;
          handleSearch();
        }, 100);
      });
      searchInput.addEventListener("input", () => {
        if (isComposing) return;
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          searchDebounceTimeout = null;
          handleSearch();
        }, 100);
      });
    }

    window.addEventListener("keydown", handleGlobalKeys);

    if (settingsToggle) settingsToggle.addEventListener("click", openSettings);
    if (settingsClose) settingsClose.addEventListener("click", closeSettings);
    if (settingsCancel) settingsCancel.addEventListener("click", closeSettings);
    if (settingsSave) settingsSave.addEventListener("click", saveSettingsConfig);

    if (tabBtnGeneral) tabBtnGeneral.addEventListener("click", () => switchTab("general"));
    if (tabBtnGlass) tabBtnGlass.addEventListener("click", () => switchTab("glass"));

    if (recordBtn) recordBtn.addEventListener("click", toggleRecordingShortcut);

    // Register visual sliders change events
    initSliderListeners();

    // =============================================
    // Tauri window event listeners
    // =============================================
    listen("icon-ready", (event) => {
      const appPath = event.payload;
      const recentCard = Array.from(document.querySelectorAll(".recent-card"))
        .find(card => card.getAttribute("data-app-path") === appPath);
      const app = appItems.find(a => a.path === appPath);
      if (recentCard && app) {
        const existingIcon = recentCard.querySelector(".recent-icon");
        if (existingIcon) {
          const newIcon = createIconElement(app.icon_path, "recent-icon");
          recentCard.replaceChild(newIcon, existingIcon);
        }
      }
      const resultIcons = document.querySelectorAll(".result-icon");
      resultIcons.forEach((el) => {
        if (el.getAttribute("data-app-path") === appPath) {
          const app = appItems.find(a => a.path === appPath);
          if (app && app.icon_path) {
            const newIcon = createIconElement(app.icon_path, "result-icon");
            newIcon.setAttribute("data-app-path", appPath);
            newIcon.setAttribute("data-icon-path", app.icon_path);
            if (el.parentElement) {
              el.parentElement.replaceChild(newIcon, el);
            }
          }
        }
      });
    });

    console.log("[FromZero] ✓ Frontend initialization complete");
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 初始化失败，请重试`;
  }
});

function renderRecentApps() {
  if (!recentGrid) return;
  clearChildren(recentGrid);
  const recentApps = (settings.recent_apps || [])
    .map(path => appItems.find(app => app.path === path))
    .filter(Boolean)
    .slice(0, 8);
  const displayApps = recentApps.length > 0 ? recentApps : appItems.slice(0, 8);
  if (displayApps.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "recent-empty";
    emptyDiv.textContent = "无可用应用";
    recentGrid.appendChild(emptyDiv);
    return;
  }
  displayApps.forEach(app => {
    const card = document.createElement("div");
    card.className = "recent-card";
    card.title = app.target;
    card.setAttribute("data-app-path", app.path);
    const iconEl = createIconElement(app.icon_path, "recent-icon");
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = app.name;
    card.appendChild(iconEl);
    card.appendChild(name);
    card.addEventListener("click", () => executeItemAction({ type: "app", data: app }));
    recentGrid.appendChild(card);
  });
}

function createIconElement(iconPath, cssClass) {
  if (!iconPath || /^[\u{2190}-\u{21FF}\u{1F300}-\u{1FAF8}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚡📂🌐📁🖼️📝💻📦📄🎵🎬]/u.test(iconPath)) {
    const span = document.createElement("span");
    span.className = (cssClass || "") + " emoji";
    span.textContent = iconPath || "📱";
    span.style.fontSize = cssClass === "recent-icon" ? "26px" : "20px";
    if (cssClass === "recent-icon") span.style.marginBottom = "8px";
    return span;
  }
  const img = document.createElement("img");
  img.className = cssClass || "";
  img.loading = "lazy";
  const replaceWithFallbackEmoji = (element, className) => {
    const fallback = document.createElement("span");
    fallback.className = (className || "") + " emoji";
    fallback.textContent = "📦";
    fallback.style.fontSize = className === "recent-icon" ? "26px" : "20px";
    if (className === "recent-icon") fallback.style.marginBottom = "8px";
    if (element.hasAttribute("data-app-path")) fallback.setAttribute("data-app-path", element.getAttribute("data-app-path"));
    if (element.hasAttribute("data-icon-path")) fallback.setAttribute("data-icon-path", element.getAttribute("data-icon-path"));
    if (element.parentElement) element.parentElement.replaceChild(fallback, element);
  };
  img.onerror = () => {
    replaceWithFallbackEmoji(img, cssClass);
  };
  try {
    img.src = convertFileSrc(iconPath);
  } catch (e) {
    console.warn("[FromZero] Icon URL error:", e);
    setTimeout(() => replaceWithFallbackEmoji(img, cssClass), 0);
  }
  return img;
}

async function handleSearch() {
  if (!searchInput) return;
  const query = searchInput.value;
  selectedIndex = 0;
  filteredItems = [];
  currentDirPath = null;
  hidePreview();
  const currentSearchId = ++lastSearchId;
  if (query.trim() === "") {
    if (welcomeScreen) welcomeScreen.style.display = "block";
    if (resultsList) resultsList.style.display = "none";
    filteredItems = [];
    if (searchIndicator) searchIndicator.textContent = "🔍";
    return;
  }
  if (welcomeScreen) welcomeScreen.style.display = "none";
  if (resultsList) resultsList.style.display = "block";
  if (query.startsWith(">")) {
    if (searchIndicator) searchIndicator.textContent = "⚡";
    const subQuery = query.slice(1).trim().toLowerCase();
    filteredItems = SYSTEM_COMMANDS.filter(cmd => cmd.key.includes(subQuery) || cmd.name.toLowerCase().includes(subQuery)).map(cmd => ({
      type: "sys",
      title: cmd.name,
      subtitle: cmd.desc,
      icon: "⚡",
      badge: cmd.badge,
      data: cmd.key
    }));
    renderResults();
  // File search mode: "f keyword" or "find keyword"
  } else if (/^(?:f|find)\s+/i.test(query)) {
    const fileSearchMatch = query.match(/^(?:f|find)\s+(.+)$/i);
    if (fileSearchMatch) {
      const fileQuery = fileSearchMatch[1].trim();
      if (searchIndicator) searchIndicator.textContent = "🔍";
      try {
        const files = await invoke("search_files", { query: fileQuery, isInline: false });
        if (currentSearchId !== lastSearchId) return;
        filteredItems = files.slice(0, 20).map(f => ({
          type: f.is_dir ? "dir" : "file",
          title: f.name,
          subtitle: f.path,
          icon: getFileIcon(f),
          badge: f.is_dir ? "文件夹" : f.extension.toUpperCase() || "文件",
          data: f
        }));
      } catch (e) {
        console.error("[FromZero] File search error:", e);
        filteredItems = [];
      }
      renderResults();
      if (filteredItems.length > 0) triggerPreview(filteredItems[0]);
      else hidePreview();
      return;
    }
  } else if (query.startsWith("\\\\") || query.startsWith("//") || /^[a-zA-Z]:[\\\/]/.test(query) || /^[a-zA-Z]:$/.test(query)) {
    if (searchIndicator) searchIndicator.textContent = "📂";
    // Directory navigation mode
    let dirPath = query.replace(/\//g, "\\");
    // Add trailing backslash if just a drive letter like C:
    if (/^[a-zA-Z]:$/.test(dirPath)) dirPath += "\\";
    let parentDir = dirPath;
    let searchInDir = "";
    // If the path doesn't end with \ and last segment doesn't exist as a directory,
    // treat the last segment as a search filter within the parent directory
    if (!dirPath.endsWith("\\")) {
      const lastSep = dirPath.lastIndexOf("\\");
      if (lastSep > 0) {
        const possibleParent = dirPath.substring(0, lastSep + 1);
        const possibleFilter = dirPath.substring(lastSep + 1);
        parentDir = possibleParent;
        searchInDir = possibleFilter;
      }
    }
    try {
      const files = await invoke("list_directory", { path: parentDir, searchTerm: searchInDir });
      if (currentSearchId !== lastSearchId) return;
      currentDirPath = parentDir;
      filteredItems = files.map(f => ({
        type: f.is_dir ? "dir" : "file",
        title: f.name === ".." ? ".. (返回上级目录)" : f.name,
        subtitle: f.path,
        icon: getFileIcon(f),
        badge: f.is_dir ? (f.name === ".." ? "返回" : "文件夹") : (f.extension ? f.extension.toUpperCase() : "文件"),
        data: f
      }));
    } catch (e) {
      console.error("[FromZero] Directory listing error:", e);
      filteredItems = [{
        type: "folder",
        title: `打开文件夹: "${dirPath}"`,
        subtitle: e.toString(),
        icon: "📂",
        badge: "错误",
        data: dirPath
      }];
    }
    renderResults();
    if (filteredItems.length > 0 && (filteredItems[0].type === "file" || filteredItems[0].type === "dir")) {
      triggerPreview(filteredItems[0]);
    } else {
      hidePreview();
    }
    return;
  } else {
    const match = query.match(/^([a-zA-Z]+)\s+(.+)$/);
    if (match && settings.web_engines[match[1].toLowerCase()]) {
      const prefix = match[1].toLowerCase();
      const searchWord = match[2];
      const engineUrl = settings.web_engines[prefix];
      const targetUrl = engineUrl.replace("{}", encodeURIComponent(searchWord));
      const engineName = getEngineName(prefix);
      if (searchIndicator) searchIndicator.textContent = "🌐";
      filteredItems = [{
        type: "web",
        title: `在 ${engineName} 搜索: "${searchWord}"`,
        subtitle: targetUrl,
        icon: "🌐",
        badge: "网页",
        data: targetUrl
      }];
      renderResults();
    } else {
      if (searchIndicator) searchIndicator.textContent = "🔍";
      try {
        const [appResults, fileResults] = await Promise.all([
          invoke("search_apps", { query }),
          invoke("search_files", { query, isInline: true }).catch(err => {
            console.warn("[FromZero] Inline file search error:", err);
            return [];
          })
        ]);
        if (currentSearchId !== lastSearchId) return;

        // Map apps
        const appItemsList = appResults.slice(0, 7).map(app => ({
          type: "app",
          title: app.name,
          subtitle: app.target,
          icon: app.icon_path,
          badge: "应用",
          data: app
        }));

        // Map files
        const fileItemsList = fileResults.slice(0, 15).map(f => ({
          type: f.is_dir ? "dir" : "file",
          title: f.name,
          subtitle: f.path,
          icon: getFileIcon(f),
          badge: f.is_dir ? (f.name === ".." ? "返回" : "文件夹") : (f.extension ? f.extension.toUpperCase() : "文件"),
          data: f
        }));

        filteredItems = [...appItemsList, ...fileItemsList];

        if (filteredItems.length < 7) {
          const defaultBaidu = `https://baidu.com/s?wd=${encodeURIComponent(query)}`;
          filteredItems.push({
            type: "web",
            title: `在 百度 搜索: "${query}"`,
            subtitle: defaultBaidu,
            icon: "🌐",
            badge: "搜索",
            data: defaultBaidu
          });
        }
      } catch (e) {
        console.error("[FromZero] Search error:", e);
        if (currentSearchId === lastSearchId) filteredItems = [];
      }
      renderResults();
      
      if (filteredItems.length > 0 && (filteredItems[0].type === "file" || filteredItems[0].type === "dir")) {
        triggerPreview(filteredItems[0]);
      } else {
        hidePreview();
      }
    }
  }
}

function renderResults() {
  if (!resultsList) return;
  clearChildren(resultsList);
  if (filteredItems.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "results-empty";
    emptyDiv.textContent = "无搜索匹配项";
    resultsList.appendChild(emptyDiv);
    return;
  }
  filteredItems.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `result-item ${index === selectedIndex ? "selected" : ""}`;
    el.style.animationDelay = `${Math.min(index * 15, 150)}ms`;
    const iconWrapper = document.createElement("div");
    iconWrapper.className = "result-icon-wrapper";
    if (item.icon === "⚡" || item.icon === "📂" || item.icon === "🌐") {
      const emojiSpan = document.createElement("span");
      emojiSpan.className = "result-icon emoji";
      emojiSpan.textContent = item.icon;
      iconWrapper.appendChild(emojiSpan);
    } else {
      const iconEl = createIconElement(item.icon, "result-icon");
      if (item.type === "app" && item.data) {
        iconEl.setAttribute("data-app-path", item.data.path);
        iconEl.setAttribute("data-icon-path", item.data.icon_path);
      }
      iconWrapper.appendChild(iconEl);
    }
    const info = document.createElement("div");
    info.className = "result-info";
    const title = document.createElement("div");
    title.className = "result-title";
    title.textContent = item.title;
    const subtitle = document.createElement("div");
    subtitle.className = "result-subtitle";
    subtitle.textContent = item.subtitle;
    info.appendChild(title);
    info.appendChild(subtitle);
    const badge = document.createElement("span");
    badge.className = "result-badge";
    badge.textContent = item.badge;
    const action = document.createElement("span");
    action.className = "result-action";
    action.textContent = "↵ 打开";
    el.appendChild(iconWrapper);
    el.appendChild(info);
    el.appendChild(badge);
    el.appendChild(action);
    el.addEventListener("click", () => {
      selectedIndex = index;
      updateSelectionVisual();
    });
    el.addEventListener("dblclick", () => {
      selectedIndex = index;
      updateSelectionVisual();
      executeItemAction(item);
    });
    el.addEventListener("mouseenter", (e) => {
      if (e.screenX === lastMouseX && e.screenY === lastMouseY) return;
      lastMouseX = e.screenX;
      lastMouseY = e.screenY;
      selectedIndex = index;
      updateSelectionVisual();
    });
    resultsList.appendChild(el);
  });
  const selectedEl = resultsList.children[selectedIndex];
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

function updateSelectionVisual() {
  if (!resultsList) return;
  const items = resultsList.children;
  for (let i = 0; i < items.length; i++) {
    if (items[i].classList && items[i].classList.contains("result-item")) {
      if (i === selectedIndex) {
        items[i].classList.add("selected");
        items[i].scrollIntoView({ block: "nearest" });
        if (filteredItems[selectedIndex] && (filteredItems[selectedIndex].type === "file" || filteredItems[selectedIndex].type === "dir")) {
          triggerPreview(filteredItems[selectedIndex]);
        } else {
          hidePreview();
        }
      } else {
        items[i].classList.remove("selected");
      }
    }
  }
}

async function executeItemAction(item) {
  try {
    if (item.type === "app") {
      const app = item.data;
      await invoke("launch_app", { path: app.path });
      try {
        const updatedSettings = await invoke("bump_recent_app", { path: app.path });
        settings = { ...settings, ...updatedSettings };
        renderRecentApps();
      } catch (bumpError) {
        console.error("[FromZero] Failed thread-safe recent app bump:", bumpError);
      }
    } else if (item.type === "sys") {
      if (item.data === "shutdown" || item.data === "restart") {
        if (!item.confirmed) {
          item.confirmed = true;
          item.title = `⚠️ 确认${item.data === "shutdown" ? "关闭计算机" : "重新启动"}？(再次按回车/点击以确认)`;
          renderResults();
          return;
        }
      }
      await invoke("execute_sys_command", { command: item.data });
    } else if (item.type === "dir") {
      // Always drill down into directories
      const newPath = item.data.path.endsWith("\\") ? item.data.path : item.data.path + "\\";
      if (searchInput) {
        searchInput.value = newPath;
        handleSearch();
      }
      return; // Don't hide the window
    } else if (item.type === "file") {
      await invoke("open_file", { path: item.data.path });
    } else if (item.type === "folder") {
      await invoke("open_folder", { path: item.data });
    } else if (item.type === "web") {
      await invoke("open_search", { url: item.data });
    }
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide after action failed:", e);
    }
    if (searchInput) searchInput.value = "";
    handleSearch();
  } catch (error) {
    console.error("[FromZero] Action error:", error);
    if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 执行失败: ${error}`;
  }
}

async function handleGlobalKeys(e) {
  // Shortcut recording is handled by a dedicated document-level keydown listener
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    if (e.key === "Escape") closeSettings();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (filteredItems.length > 0) {
      if (selectedIndex < filteredItems.length - 1) {
        selectedIndex++;
        updateSelectionVisual();
      }
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (filteredItems.length > 0) {
      if (selectedIndex > 0) {
        selectedIndex--;
        updateSelectionVisual();
      }
    }
  } else if (e.key === "Backspace" && currentDirPath && searchInput && searchInput.value === currentDirPath) {
    // Go up one directory level
    e.preventDefault();
    const parentPath = currentDirPath.replace(/\\[^\\]+\\$/, "\\");
    if (parentPath !== currentDirPath && parentPath.length >= 3) {
      searchInput.value = parentPath;
      handleSearch();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchDebounceTimeout && selectedIndex === 0) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (e.shiftKey && filteredItems[selectedIndex] && (filteredItems[selectedIndex].type === "file" || filteredItems[selectedIndex].type === "dir")) {
      // Open parent directory in Explorer
      const filePath = filteredItems[selectedIndex].data.path;
      const parentDir = filePath.substring(0, filePath.lastIndexOf("\\"));
      if (parentDir) {
        try { await invoke("open_folder", { path: parentDir }); } catch (err) { console.warn(err); }
      }
      return;
    }
    if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
      executeItemAction(filteredItems[selectedIndex]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide on escape failed:", e);
    }
  } else if (e.ctrlKey && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    openSettings();
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function switchTab(tab) {
  if (tab === "general") {
    if (tabBtnGeneral) tabBtnGeneral.classList.add("active");
    if (tabBtnGlass) tabBtnGlass.classList.remove("active");
    if (panelGeneral) panelGeneral.classList.add("active");
    if (panelGlass) panelGlass.classList.remove("active");
  } else if (tab === "glass") {
    if (tabBtnGeneral) tabBtnGeneral.classList.remove("active");
    if (tabBtnGlass) tabBtnGlass.classList.add("active");
    if (panelGeneral) panelGeneral.classList.remove("active");
    if (panelGlass) panelGlass.classList.add("active");
  }
}

function openSettings() {
  switchTab("general");
  if (settingsOverlay) settingsOverlay.classList.add("active");
  if (themeSelect) themeSelect.value = settings.theme || "dark";
  currentShortcut = settings.shortcut || "Ctrl+Space";
  if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
  if (autostartToggle) autostartToggle.checked = settings.autostart || false;

  // Back up settings in case of user cancel
  backupGlassSettings = { ...glassSettings };

  // Set sliders value to current config
  syncSlidersToConfig(glassSettings);
}

function closeSettings() {
  if (settingsOverlay) settingsOverlay.classList.remove("active");
  isRecording = false;
  if (recordBtn) {
    recordBtn.textContent = "录制组合键";
    recordBtn.className = "record-btn";
  }

  // Restore backed up visual parameters if canceled
  if (backupGlassSettings) {
    applyVisualSettings(backupGlassSettings);
    backupGlassSettings = null;
  }

  if (searchInput) searchInput.focus();
}

async function saveSettingsConfig() {
  if (themeSelect) settings.theme = themeSelect.value;
  settings.shortcut = currentShortcut;
  if (autostartToggle) settings.autostart = autostartToggle.checked;
  applyTheme(settings.theme);

  // Commit glass settings
  glassSettings = readSlidersState();

  // Glass settings are saved as part of the unified settings object
  settings.glass_settings = {
    glass_blur: glassSettings.glassBlur,
    border_opacity: glassSettings.borderOpacity
  };

  // Clean backup so closeSettings does not revert them
  backupGlassSettings = null;

  closeSettings();

  try {
    await invoke("update_settings", { settings });
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide after save failed:", e);
    }
  } catch (error) {
    console.error("[FromZero] Save settings error:", error);
    if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 保存设置失败: ${error}`;
  }
}

let isRecording = false;
function toggleRecordingShortcut() {
  isRecording = !isRecording;
  if (isRecording) {
    if (recordBtn) {
      recordBtn.textContent = "请按下按键...";
      recordBtn.classList.add("recording");
    }
    // Blur any focused element so keyboard events reach window/document reliably
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  } else {
    if (recordBtn) {
      recordBtn.textContent = "录制组合键";
      recordBtn.classList.remove("recording");
    }
  }
}

// Dedicated keydown listener for shortcut recording at document level
// (separate from handleGlobalKeys which is on window and may miss events
//  when focus is inside the modal overlay)
document.addEventListener("keydown", (e) => {
  if (!isRecording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    currentShortcut = settings.shortcut || "Ctrl+Space";
    if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
    toggleRecordingShortcut();
    return;
  }
  recordShortcut(e);
});

document.addEventListener("mousedown", (e) => {
  if (isRecording && recordBtn && e.target !== recordBtn) {
    toggleRecordingShortcut();
  }
});

function recordShortcut(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const ignoreKeys = ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock"];
  const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);

  // Global hotkeys require at least one modifier key (Ctrl/Alt/Shift/Win) or a function key (F1-F24).
  // Combinations like "X+Space" cannot be registered as OS-level global hotkeys.
  if (!hasModifier && !isFunctionKey) {
    if (shortcutDisplay) shortcutDisplay.textContent = "需要修饰键 (Ctrl/Alt/Shift) 或 F1-F24";
    return;
  }

  if (!ignoreKeys.includes(e.key)) {
    let keyName = e.key;
    if (keyName === " ") keyName = "Space";
    else if (keyName === "ArrowUp") keyName = "Up";
    else if (keyName === "ArrowDown") keyName = "Down";
    else if (keyName === "ArrowLeft") keyName = "Left";
    else if (keyName === "ArrowRight") keyName = "Right";
    else if (keyName === "Escape") keyName = "Esc";
    else if (keyName.length === 1) keyName = keyName.toUpperCase();
    parts.push(keyName);
  }

  if (parts.length > 0 && !ignoreKeys.includes(e.key)) {
    currentShortcut = parts.join("+");
    if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
    toggleRecordingShortcut();
  }
}

// =============================================
// File Explorer: Helper Functions
// =============================================

// Format file size to human-readable string
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

// Format Unix timestamp to locale date string
function formatDate(unixSec) {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

// Get file icon emoji based on extension
function getFileIcon(item) {
  if (item.name === "..") return "↩️";
  if (item.is_dir) return "📁";
  const ext = item.extension || "";
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
  const docExts = ["doc", "docx", "pdf", "ppt", "pptx", "xls", "xlsx"];
  const codeExts = ["js", "ts", "rs", "py", "c", "cpp", "java", "go", "rb", "php", "html", "css"];
  const archiveExts = ["zip", "rar", "7z", "tar", "gz"];
  if (imageExts.includes(ext)) return "🖼️";
  if (docExts.includes(ext)) return "📝";
  if (codeExts.includes(ext)) return "💻";
  if (archiveExts.includes(ext)) return "📦";
  if (ext === "txt" || ext === "md" || ext === "log") return "📄";
  if (ext === "mp3" || ext === "wav" || ext === "flac" || ext === "ogg") return "🎵";
  if (ext === "mp4" || ext === "avi" || ext === "mkv") return "🎬";
  return "📄";
}

// Show preview for selected file/folder
async function showPreview(item) {
  const previewPanel = document.getElementById("preview-panel");
  const previewHeader = document.getElementById("preview-header");
  const previewMeta = document.getElementById("preview-meta");
  const previewContent = document.getElementById("preview-content");
  if (!previewPanel || !previewHeader || !previewMeta || !previewContent) return;

  // Only show preview for file/directory items
  if (!item || (item.type !== "file" && item.type !== "dir")) {
    previewPanel.classList.remove("active");
    return;
  }

  const requestedPath = item.data.path;
  previewPanel.classList.add("active");
  previewHeader.textContent = item.data.name || "";
  previewMeta.textContent = "加载中...";
  clearChildren(previewContent);

  try {
    const preview = await invoke("get_file_preview", { path: requestedPath });
    if (!filteredItems[selectedIndex] || filteredItems[selectedIndex].data.path !== requestedPath) {
      return; // Stale request, ignore
    }
    // Update meta
    const metaParts = [];
    if (preview.size > 0) metaParts.push(formatFileSize(preview.size));
    if (preview.modified) metaParts.push(formatDate(preview.modified));
    previewMeta.textContent = metaParts.join(" · ") || "";

    // Render content
    clearChildren(previewContent);
    if (preview.file_type === "image" && preview.content) {
      const img = document.createElement("img");
      img.src = preview.content;
      img.alt = item.data.name;
      img.loading = "lazy";
      previewContent.appendChild(img);
    } else if (preview.file_type === "pdf" && preview.content) {
      try {
        const base64Data = preview.content.split(",")[1] || preview.content;
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        const blobUrl = URL.createObjectURL(blob);

        const iframe = document.createElement("iframe");
        iframe.src = blobUrl;
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "none";
        iframe.style.borderRadius = "8px";
        iframe.style.backgroundColor = "white";
        iframe.dataset.blobUrl = blobUrl;

        previewContent.appendChild(iframe);
      } catch (err) {
        console.error("PDF preview error:", err);
        const errDiv = document.createElement("div");
        errDiv.className = "preview-empty";
        errDiv.textContent = "PDF 预览失败";
        previewContent.appendChild(errDiv);
      }
    } else if (preview.file_type === "audio" && preview.content) {
      try {
        const base64Data = preview.content.split(",")[1] || preview.content;
        const mimeMatch = preview.content.match(/^data:([^;]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : "audio/ogg";

        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);

        const audio = document.createElement("audio");
        audio.src = blobUrl;
        audio.controls = true;
        audio.style.width = "100%";
        audio.style.marginTop = "20px";
        audio.style.borderRadius = "4px";
        audio.dataset.blobUrl = blobUrl;

        previewContent.appendChild(audio);
      } catch (err) {
        console.error("Audio preview error:", err);
        const errDiv = document.createElement("div");
        errDiv.className = "preview-empty";
        errDiv.textContent = "音频预览失败";
        previewContent.appendChild(errDiv);
      }
    } else if (preview.file_type === "text" && preview.content) {
      const pre = document.createElement("pre");
      pre.textContent = preview.content;
      previewContent.appendChild(pre);
    } else if (preview.file_type === "folder" && preview.content) {
      const ul = document.createElement("ul");
      ul.className = "folder-list";
      preview.content.split("\n").forEach(line => {
        if (line.trim()) {
          const li = document.createElement("li");
          li.textContent = line;
          ul.appendChild(li);
        }
      });
      previewContent.appendChild(ul);
    } else {
      const empty = document.createElement("div");
      empty.className = "preview-empty";
      if (preview.file_type === "image") {
        empty.textContent = "图片过大，无法预览";
      } else if (preview.file_type === "pdf") {
        empty.textContent = "PDF 过大，无法预览";
      } else if (preview.file_type === "audio") {
        empty.textContent = "音频过大，无法预览";
      } else {
        empty.textContent = "不可直接预览";
      }
      previewContent.appendChild(empty);
    }
  } catch (e) {
    previewMeta.textContent = "预览失败";
    clearChildren(previewContent);
    const errDiv = document.createElement("div");
    errDiv.className = "preview-empty";
    errDiv.textContent = "无法加载预览";
    previewContent.appendChild(errDiv);
  }
}

// Hide preview panel
function hidePreview() {
  const previewPanel = document.getElementById("preview-panel");
  if (previewPanel) previewPanel.classList.remove("active");
  const previewContent = document.getElementById("preview-content");
  if (previewContent) clearChildren(previewContent);
}

// Debounced preview update when selection changes
function triggerPreview(item) {
  clearTimeout(previewDebounceTimeout);
  previewDebounceTimeout = setTimeout(() => {
    showPreview(item);
  }, 50);
}