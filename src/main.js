// === FromZero Launcher — Main Frontend Logic ===
// Safety guard: wait for __TAURI__ to be ready
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

// App state variables
let appItems = [];
let filteredItems = [];
let selectedIndex = 0;
let settings = { shortcut: "Alt+Space", theme: "dark", web_engines: {}, recent_apps: [] };

// Search debounce and query race condition tracking
let lastSearchId = 0;
let searchDebounceTimeout = null;

// Focus management: timestamp of last show (for debounce)
let lastShowTime = 0;

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

// System commands helper list
const SYSTEM_COMMANDS = [
  { key: "lock", name: "锁定屏幕 (Lock Screen)", desc: "锁定当前的 Windows 会话", badge: "系统" },
  { key: "sleep", name: "休眠系统 (Sleep)", desc: "使计算机进入低功耗睡眠状态", badge: "系统" },
  { key: "shutdown", name: "关闭计算机 (Shutdown)", desc: "关闭电源并退出所有应用", badge: "警告" },
  { key: "restart", name: "重启计算机 (Restart)", desc: "重新启动操作系统", badge: "系统" }
];

// =============================================
// Window Focus/Blur Management (JS-side with debounce)
// =============================================

// When the window gains focus: record timestamp, auto-focus search input
window.addEventListener("focus", () => {
  lastShowTime = Date.now();
  // Auto-focus the search input when window becomes visible
  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
    }
  }, 50);
});

// When the window loses focus: hide after a short debounce
// This prevents the "instant hide" race condition that occurs when
// the window is shown but hasn't fully received focus yet.
window.addEventListener("blur", () => {
  const timeSinceShow = Date.now() - lastShowTime;
  // Only auto-hide if window has been visible for at least 300ms
  // This prevents the race condition where show() triggers an
  // immediate Focused(false) before focus is actually gained
  if (timeSinceShow < 300) {
    return; // Too soon — ignore this blur, it's a transient state
  }

  // Don't hide if settings modal is open (user is interacting with a dropdown, etc.)
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    return;
  }

  setTimeout(async () => {
    // Double-check: is the document still unfocused after 120ms?
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
// Initialize application
// =============================================
window.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("[FromZero] Initializing...");
    lastShowTime = Date.now(); // Mark initial show time

    // 1. Load settings
    settings = await invoke("get_settings");
    applyTheme(settings.theme);
    shortcutDisplay.textContent = settings.shortcut;
    themeSelect.value = settings.theme;

    // 2. Scan applications from Start Menu
    footerStatus.textContent = "正在扫描开始菜单...";
    try {
      appItems = await invoke("scan_apps");
      footerStatus.textContent = `已成功加载 ${appItems.length} 个应用`;
      console.log(`[FromZero] Loaded ${appItems.length} apps`);
    } catch (scanError) {
      console.error("[FromZero] Scan error:", scanError);
      footerStatus.textContent = "应用扫描失败，请检查日志";
    }

    // 3. Render frequent/recent apps
    renderRecentApps();

    // 4. Initialize search focus
    searchInput.focus();

    // 5. Setup search input listener with 100ms debounce
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = setTimeout(handleSearch, 100);
    });

    // 6. Setup keyboard event listener
    window.addEventListener("keydown", handleGlobalKeys);

    // 7. Setup Settings toggle clicks
    settingsToggle.addEventListener("click", openSettings);
    settingsClose.addEventListener("click", closeSettings);
    settingsCancel.addEventListener("click", closeSettings);
    settingsSave.addEventListener("click", saveSettingsConfig);

    // 8. Dynamic shortcut recorder hook
    recordBtn.addEventListener("click", toggleRecordingShortcut);

    // 9. Register background icon loading completion listener
    if (window.__TAURI__?.event?.listen) {
      window.__TAURI__.event.listen("icon-ready", (event) => {
        const appPath = event.payload;
        console.log(`[FromZero] Dynamically loaded icon for: ${appPath}`);
        
        // Re-render recent apps grid to show newly loaded icon
        renderRecentApps();
        
        // Dynamically update any matching icons in the search results DOM
        // without doing a full fuzzy search, to preserve selection index and focus!
        const query = searchInput.value.trim();
        if (query !== "") {
          const imgElements = document.querySelectorAll("img.result-icon");
          imgElements.forEach((img) => {
            if (img.getAttribute("data-app-path") === appPath) {
              const iconPath = img.getAttribute("data-icon-path");
              if (iconPath && window.__TAURI__?.core?.convertFileSrc) {
                img.src = window.__TAURI__.core.convertFileSrc(iconPath);
              }
            }
          });
        }
      });
    }

    console.log("[FromZero] ✓ Frontend initialization complete");

  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    footerStatus.textContent = "初始化失败，请重试";
  }
});

// Render the 8 most recently/frequently used apps
function renderRecentApps() {
  recentGrid.innerHTML = "";
  
  // Decouple from filesystem scan order: map recent_apps in exact chronological order
  const recentApps = settings.recent_apps
    .map(path => appItems.find(app => app.path === path))
    .filter(Boolean)
    .slice(0, 8);

  // If no recent apps yet, use first 8 scanned apps as defaults
  const displayApps = recentApps.length > 0 ? recentApps : appItems.slice(0, 8);

  if (displayApps.length === 0) {
    recentGrid.innerHTML = `<div style="grid-column: span 4; color: var(--text-dim); text-align: center; padding: 20px;">无可用应用</div>`;
    return;
  }

  displayApps.forEach(app => {
    const card = document.createElement("div");
    card.className = "recent-card";
    card.title = app.target;

    // Create icon — use convertFileSrc for proper Tauri asset protocol
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

// Create icon element with proper fallback
function createIconElement(iconPath, cssClass) {
  if (!iconPath || iconPath === "⚡" || iconPath === "📂" || iconPath === "🌐") {
    // Emoji icon
    const span = document.createElement("span");
    span.className = (cssClass || "") + " emoji";
    span.textContent = iconPath || "📱";
    span.style.fontSize = cssClass === "recent-icon" ? "26px" : "20px";
    if (cssClass === "recent-icon") span.style.marginBottom = "8px";
    return span;
  }

  const img = document.createElement("img");
  img.className = cssClass || "";

  // Build asset URL: convertFileSrc encodes the path properly
  try {
    if (window.__TAURI__?.core?.convertFileSrc) {
      img.src = window.__TAURI__.core.convertFileSrc(iconPath);
    } else {
      // Manual fallback: encode the full path for asset protocol
      img.src = `https://asset.localhost/${encodeURIComponent(iconPath)}`;
    }
  } catch (e) {
    console.warn("[FromZero] Icon URL error:", e);
  }

  img.loading = "lazy";
  img.onerror = () => {
    // Replace with emoji fallback on any load error
    const fallback = document.createElement("span");
    fallback.className = (cssClass || "") + " emoji";
    fallback.textContent = "📦";
    fallback.style.fontSize = cssClass === "recent-icon" ? "26px" : "20px";
    if (cssClass === "recent-icon") fallback.style.marginBottom = "8px";
    if (img.parentElement) {
      img.parentElement.replaceChild(fallback, img);
    }
  };

  return img;
}

// Global search routing
async function handleSearch() {
  const query = searchInput.value;
  selectedIndex = 0;

  const currentSearchId = ++lastSearchId;

  if (query.trim() === "") {
    // Show recent screen
    welcomeScreen.style.display = "block";
    resultsList.style.display = "none";
    filteredItems = [];
    searchIndicator.textContent = "🔍";
    return;
  }

  welcomeScreen.style.display = "none";
  resultsList.style.display = "block";

  // Check router matching
  if (query.startsWith(">")) {
    // 1. System Command router
    searchIndicator.textContent = "⚡";
    const subQuery = query.slice(1).trim().toLowerCase();
    
    filteredItems = SYSTEM_COMMANDS.filter(cmd => 
      cmd.key.includes(subQuery) || cmd.name.toLowerCase().includes(subQuery)
    ).map(cmd => ({
      type: "sys",
      title: cmd.name,
      subtitle: cmd.desc,
      icon: "⚡",
      badge: cmd.badge,
      data: cmd.key
    }));
    
    renderResults();
  } 
  else if (query.startsWith("/") || /^[a-zA-Z]:\\/.test(query)) {
    // 2. Folder Navigation router
    searchIndicator.textContent = "📂";
    filteredItems = [{
      type: "folder",
      title: `快速打开文件夹: "${query}"`,
      subtitle: "使用 Windows 资源管理器呼出",
      icon: "📂",
      badge: "路径",
      data: query
    }];
    renderResults();
  }
  else {
    // 3. Check for Web search engines carrying query content (e.g. "g query", "b query")
    const match = query.match(/^([a-zA-Z]+)\s+(.+)$/);
    if (match && settings.web_engines[match[1].toLowerCase()]) {
      const prefix = match[1].toLowerCase();
      const searchWord = match[2];
      const engineUrl = settings.web_engines[prefix];
      const targetUrl = engineUrl.replace("{}", encodeURIComponent(searchWord));
      
      const engineName = prefix === "g" ? "Google" : prefix === "b" ? "百度" : prefix === "bi" ? "Bing" : prefix === "gh" ? "GitHub" : prefix;
      
      searchIndicator.textContent = "🌐";
      filteredItems = [{
        type: "web",
        title: `在 ${engineName} 搜索: "${searchWord}"`,
        subtitle: targetUrl,
        icon: "🌐",
        badge: "网页",
        data: targetUrl
      }];
      renderResults();
    } 
    else {
      // 4. Default: Start menu app fuzzy matching
      searchIndicator.textContent = "🔍";
      try {
        const results = await invoke("search_apps", { query });
        if (currentSearchId !== lastSearchId) return; // Stale query check
        
        filteredItems = results.slice(0, 7).map(app => ({
          type: "app",
          title: app.name,
          subtitle: app.target,
          icon: app.icon_path,
          badge: "应用",
          data: app
        }));

        // Add a fallback web search option at the very bottom
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
        if (currentSearchId === lastSearchId) {
          filteredItems = [];
        } else {
          return;
        }
      }
      renderResults();
    }
  }
}

// Render filtered item list
function renderResults() {
  resultsList.innerHTML = "";
  
  if (filteredItems.length === 0) {
    resultsList.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-dim); font-size: 13px;">无搜索匹配项</div>`;
    return;
  }

  filteredItems.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `result-item ${index === selectedIndex ? "selected" : ""}`;

    const iconWrapper = document.createElement("div");
    iconWrapper.className = "result-icon-wrapper";

    if (item.icon === "⚡" || item.icon === "📂" || item.icon === "🌐") {
      const emojiSpan = document.createElement("span");
      emojiSpan.className = "result-icon emoji";
      emojiSpan.textContent = item.icon;
      iconWrapper.appendChild(emojiSpan);
    } else {
      const iconEl = createIconElement(item.icon, "result-icon");
      if (item.type === "app" && item.data && iconEl.tagName === "IMG") {
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
      executeItemAction(item);
    });

    resultsList.appendChild(el);
  });

  // Ensure selected item is visible
  const selectedEl = resultsList.children[selectedIndex];
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }
}

// Execute operations
async function executeItemAction(item) {
  try {
    if (item.type === "app") {
      const app = item.data;
      await invoke("launch_app", { path: app.path });
      
      // Update chronological recent apps list (bump existing app to front)
      const recentIndex = settings.recent_apps.indexOf(app.path);
      if (recentIndex > -1) {
        settings.recent_apps.splice(recentIndex, 1);
      }
      settings.recent_apps.unshift(app.path);
      settings.recent_apps = settings.recent_apps.slice(0, 16);
      await invoke("update_settings", { settings });
      renderRecentApps();
    } 
    else if (item.type === "sys") {
      await invoke("execute_sys_command", { command: item.data });
    } 
    else if (item.type === "folder") {
      await invoke("open_folder", { path: item.data });
    } 
    else if (item.type === "web") {
      await invoke("open_search", { url: item.data });
    }
    
    // Auto hide launcher on execution
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide after action failed:", e);
    }
    
    // Clear input and reset view
    searchInput.value = "";
    handleSearch();
  } catch (error) {
    console.error("[FromZero] Action error:", error);
    footerStatus.textContent = `执行失败: ${error}`;
  }
}

// Keyboard navigation
function handleGlobalKeys(e) {
  // Check settings recording mode (don't intercept standard launcher actions)
  if (isRecording) {
    e.preventDefault();
    recordShortcut(e);
    return;
  }

  // Intercept settings modal focus
  if (settingsOverlay.classList.contains("active")) {
    if (e.key === "Escape") {
      closeSettings();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filteredItems.length > 0) {
      selectedIndex = (selectedIndex + 1) % filteredItems.length;
      renderResults();
    }
  } 
  else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filteredItems.length > 0) {
      selectedIndex = (selectedIndex - 1 + filteredItems.length) % filteredItems.length;
      renderResults();
    }
  } 
  else if (e.key === "Enter") {
    e.preventDefault();
    if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
      executeItemAction(filteredItems[selectedIndex]);
    }
  } 
  else if (e.key === "Escape") {
    e.preventDefault();
    appWindow.hide().catch(() => {});
  } 
  else if (e.ctrlKey && e.key === ",") {
    e.preventDefault();
    openSettings();
  }
}

// Visual Theme application
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

// Settings modal control
function openSettings() {
  settingsOverlay.classList.add("active");
  themeSelect.value = settings.theme;
  shortcutDisplay.textContent = settings.shortcut;
}

function closeSettings() {
  settingsOverlay.classList.remove("active");
  isRecording = false;
  recordBtn.textContent = "录制组合键";
  recordBtn.className = "record-btn";
  // Refocus search input
  searchInput.focus();
}

async function saveSettingsConfig() {
  try {
    settings.theme = themeSelect.value;
    settings.shortcut = shortcutDisplay.textContent;
    
    applyTheme(settings.theme);
    
    await invoke("update_settings", { settings });
    closeSettings();
    searchInput.focus();
  } catch (error) {
    console.error("[FromZero] Save settings error:", error);
    footerStatus.textContent = `保存设置失败: ${error}`;
  }
}

// Global hotkey recorder
let isRecording = false;

function toggleRecordingShortcut() {
  isRecording = !isRecording;
  if (isRecording) {
    recordBtn.textContent = "请按下按键...";
    recordBtn.classList.add("recording");
  } else {
    recordBtn.textContent = "录制组合键";
    recordBtn.classList.remove("recording");
  }
}

function recordShortcut(e) {
  const parts = [];
  
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const ignoreKeys = ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock"];
  if (!ignoreKeys.includes(e.key)) {
    // Format key name for Tauri global shortcut parsing
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
    shortcutDisplay.textContent = parts.join("+");
    toggleRecordingShortcut();
  }
}
