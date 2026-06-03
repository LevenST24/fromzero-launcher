// === FromZero Launcher — Main Frontend Logic ===

// App state variables
let appItems = [];
let filteredItems = [];
let selectedIndex = 0;
let settings = { shortcut: "Alt+Space", theme: "dark", web_engines: {}, recent_apps: [], autostart: false };

// Search debounce and query race condition tracking
let lastSearchId = 0;
let searchDebounceTimeout = null;

// Focus management: timestamp of last show (for debounce)
let lastShowTime = 0;

// IME Composition state tracking
let isComposing = false;

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

// System commands helper list
const SYSTEM_COMMANDS = [
  { key: "lock", name: "锁定屏幕 (Lock Screen)", desc: "锁定当前的 Windows 会话", badge: "系统" },
  { key: "sleep", name: "休眠系统 (Sleep)", desc: "使计算机进入低功耗睡眠状态", badge: "系统" },
  { key: "shutdown", name: "关闭计算机 (Shutdown)", desc: "关闭电源并退出所有应用", badge: "警告" },
  { key: "restart", name: "重启计算机 (Restart)", desc: "重新启动操作系统", badge: "系统" }
];

// =============================================
// Tauri Core APIs Wrapper with Safety Guards
// =============================================
let invoke = null;
let appWindow = null;
let isMock = false;

// Animation loop state
let springAnimationId = null;
let startSprings = null;
let stopSprings = null;

function ensureTauri() {
  if (window.__TAURI__) {
    if (isMock || !invoke || !appWindow) {
      invoke = window.__TAURI__.core.invoke;
      appWindow = window.__TAURI__.window.getCurrentWindow();
      isMock = false;
    }
  } else if (!invoke || !appWindow) {
    console.warn("[FromZero] __TAURI__ not found, setting up fallback mocks");
    isMock = true;
    invoke = async (cmd, args) => {
      console.log(`[Mock Invoke] ${cmd}`, args);
      if (cmd === "get_settings") {
        return { shortcut: "Alt+Space", theme: "dark", web_engines: { g: "https://google.com/search?q={}" }, recent_apps: [], autostart: false };
      }
      if (cmd === "scan_apps") return [];
      if (cmd === "search_apps") return [];
      return {};
    };
    appWindow = {
      hide: async () => console.log("[Mock AppWindow] hide"),
      show: async () => console.log("[Mock AppWindow] show"),
      setFocus: async () => console.log("[Mock AppWindow] setFocus"),
      listen: (event, callback) => {
        console.log(`[Mock AppWindow] listen for ${event}`);
        return () => {};
      }
    };
  }
}

ensureTauri();

function logDebug(msg) {
  console.log(msg);
}

// =============================================
// Window Focus/Blur Management (JS-side with debounce)
// =============================================

window.addEventListener("focus", () => {
  lastShowTime = Date.now();
  if (startSprings) startSprings();
  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
    }
  }, 50);
});

window.addEventListener("blur", () => {
  if (stopSprings) stopSprings();
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
        ensureTauri();
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
    lastShowTime = Date.now();
    ensureTauri();

    try {
      const loaded = await invoke("get_settings");
      settings = { ...settings, ...loaded };
      settings.recent_apps = settings.recent_apps || [];
      settings.web_engines = settings.web_engines || {};
    } catch (e) {
      console.error("[FromZero] Failed to load settings, using default:", e);
    }

    applyTheme(settings.theme);
    if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Alt+Space";
    if (themeSelect) themeSelect.value = settings.theme || "dark";

    if (footerStatus) footerStatus.textContent = "正在扫描开始菜单...";
    try {
      appItems = await invoke("scan_apps");
      if (footerStatus) footerStatus.textContent = `已成功加载 ${appItems.length} 个应用`;
      console.log(`[FromZero] Loaded ${appItems.length} apps`);
    } catch (scanError) {
      console.error("[FromZero] Scan error:", scanError);
      if (footerStatus) footerStatus.textContent = "应用扫描失败，请检查日志";
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
        logDebug("[Debug] compositionend: scheduling search, current timeout: " + searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          logDebug("[Debug] search timeout fired (compositionend)");
          searchDebounceTimeout = null;
          handleSearch();
        }, 100);
      });
      searchInput.addEventListener("input", () => {
        if (isComposing) return;
        clearTimeout(searchDebounceTimeout);
        logDebug("[Debug] input event: value = " + searchInput.value + ", scheduling search, current timeout: " + searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
          logDebug("[Debug] search timeout fired (input)");
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

    if (recordBtn) recordBtn.addEventListener("click", toggleRecordingShortcut);

    // =============================================
    // Specular Highlight — cursor-following light spot (Liquid Glass)
    // NO refractive drift / NO wave effect
    // =============================================
    const container = document.getElementById("launcher-container");
    if (container) {
      // Spring state for specular highlight only
      let targetMouseX = 0;
      let targetMouseY = 0;
      let isHovered = false;

      // Specular Highlight Spring (snappy light reflection)
      let shX = -999, shY = -999;
      let shVx = 0, shVy = 0;
      const shStiffness = 0.12;
      const shDamping = 0.16;

      function updateSprings() {
        if (!document.getElementById("launcher-container")) {
          springAnimationId = null;
          return;
        }

        let targetShX = -999;
        let targetShY = -999;

        if (isHovered) {
          targetShX = targetMouseX;
          targetShY = targetMouseY;
        }

        // Update Specular Highlight Spring only
        if (targetShX === -999) {
          shX = -999;
          shY = -999;
          shVx = 0;
          shVy = 0;
        } else {
          if (shX === -999) { shX = targetShX; shY = targetShY; }
          const ax = (targetShX - shX) * shStiffness;
          const ay = (targetShY - shY) * shStiffness;
          shVx = (shVx + ax) * (1 - shDamping);
          shVy = (shVy + ay) * (1 - shDamping);
          shX += shVx;
          shY += shVy;
        }

        // Render CSS coordinates for specular highlight
        if (shX === -999) {
          container.style.setProperty("--mx", `-999px`);
          container.style.setProperty("--my", `-999px`);
        } else {
          container.style.setProperty("--mx", `${shX}px`);
          container.style.setProperty("--my", `${shY}px`);
        }

        springAnimationId = requestAnimationFrame(updateSprings);
      }

      startSprings = () => {
        if (!springAnimationId) {
          springAnimationId = requestAnimationFrame(updateSprings);
        }
      };

      stopSprings = () => {
        if (springAnimationId) {
          cancelAnimationFrame(springAnimationId);
          springAnimationId = null;
        }
      };

      // Start the animation loop
      startSprings();

      container.addEventListener("mouseenter", () => {
        isHovered = true;
      });

      container.addEventListener("mousemove", (e) => {
        const rect = container.getBoundingClientRect();
        targetMouseX = e.clientX - rect.left;
        targetMouseY = e.clientY - rect.top;
        isHovered = true;
      });

      container.addEventListener("mouseleave", () => {
        isHovered = false;
      });
    }

    if (window.__TAURI__) {
      appWindow.listen("tauri://focus", () => {
        lastShowTime = Date.now();
        if (searchInput) searchInput.focus();
        if (startSprings) startSprings();
      });

      appWindow.listen("tauri://blur", () => {
        if (stopSprings) stopSprings();
      });

      if (window.__TAURI__.event?.listen) {
        window.__TAURI__.event.listen("icon-ready", (event) => {
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
      }
    }
    console.log("[FromZero] ✓ Frontend initialization complete");
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus) footerStatus.textContent = "初始化失败，请重试";
  }
});

function renderRecentApps() {
  if (!recentGrid) return;
  recentGrid.innerHTML = "";
  const recentApps = (settings.recent_apps || [])
    .map(path => appItems.find(app => app.path === path))
    .filter(Boolean)
    .slice(0, 8);
  const displayApps = recentApps.length > 0 ? recentApps : appItems.slice(0, 8);
  if (displayApps.length === 0) {
    recentGrid.innerHTML = `<div style="grid-column: span 4; color: var(--text-dim); text-align: center; padding: 20px;">无可用应用</div>`;
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
  if (!iconPath || iconPath === "⚡" || iconPath === "📂" || iconPath === "🌐") {
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
    ensureTauri();
    if (window.__TAURI__?.core?.convertFileSrc) {
      img.src = window.__TAURI__.core.convertFileSrc(iconPath);
    } else {
      img.src = `https://asset.localhost/${encodeURIComponent(iconPath)}`;
    }
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
  } else if (query.startsWith("/") || query.startsWith("\\\\") || /^[a-zA-Z]:\\/.test(query)) {
    if (searchIndicator) searchIndicator.textContent = "📂";
    filteredItems = [{
      type: "folder",
      title: `快速打开文件夹: "${query}"`,
      subtitle: "使用 Windows 资源管理器呼出",
      icon: "📂",
      badge: "路径",
      data: query
    }];
    renderResults();
  } else {
    const match = query.match(/^([a-zA-Z]+)\s+(.+)$/);
    if (match && settings.web_engines[match[1].toLowerCase()]) {
      const prefix = match[1].toLowerCase();
      const searchWord = match[2];
      const engineUrl = settings.web_engines[prefix];
      const targetUrl = engineUrl.replace("{}", encodeURIComponent(searchWord));
      const knownEngines = { g: "Google", b: "百度", bi: "Bing", gh: "GitHub" };
      const engineName = knownEngines[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1));
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
        ensureTauri();
        const results = await invoke("search_apps", { query });
        if (currentSearchId !== lastSearchId) return;
        filteredItems = results.slice(0, 7).map(app => ({
          type: "app",
          title: app.name,
          subtitle: app.target,
          icon: app.icon_path,
          badge: "应用",
          data: app
        }));
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
    }
  }
}

function renderResults() {
  if (!resultsList) return;
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
    el.addEventListener("click", () => { selectedIndex = index; executeItemAction(item); });
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
      } else {
        items[i].classList.remove("selected");
      }
    }
  }
}

async function executeItemAction(item) {
  try {
    ensureTauri();
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
      await invoke("execute_sys_command", { command: item.data });
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
    if (footerStatus) footerStatus.textContent = `执行失败: ${error}`;
  }
}

async function handleGlobalKeys(e) {
  if (isRecording) {
    e.preventDefault();
    recordShortcut(e);
    return;
  }
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    if (e.key === "Escape") closeSettings();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      logDebug("[Debug] ArrowDown: clearing searchDebounceTimeout and running search immediately");
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
      logDebug("[Debug] ArrowUp: clearing searchDebounceTimeout and running search immediately");
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
  } else if (e.key === "Enter") {
    e.preventDefault();
    logDebug("[Debug] Enter keydown pressed. searchDebounceTimeout: " + searchDebounceTimeout + ", selectedIndex: " + selectedIndex + ", filteredItems length: " + filteredItems.length);
    if (searchDebounceTimeout && selectedIndex === 0) {
      logDebug("[Debug] Enter: clearing searchDebounceTimeout and running immediate search");
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
      logDebug("[Debug] Enter: handleSearch finished. selectedIndex reset to: " + selectedIndex);
    }
    logDebug("[Debug] Enter: launching item at selectedIndex: " + selectedIndex + ", item: " + JSON.stringify(filteredItems[selectedIndex]));
    if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
      executeItemAction(filteredItems[selectedIndex]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    ensureTauri();
    appWindow.hide().catch(() => {});
  } else if (e.ctrlKey && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    openSettings();
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function openSettings() {
  if (settingsOverlay) settingsOverlay.classList.add("active");
  if (themeSelect) themeSelect.value = settings.theme || "dark";
  if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Alt+Space";
  if (autostartToggle) autostartToggle.checked = settings.autostart || false;
}

function closeSettings() {
  if (settingsOverlay) settingsOverlay.classList.remove("active");
  isRecording = false;
  if (recordBtn) {
    recordBtn.textContent = "录制组合键";
    recordBtn.className = "record-btn";
  }
  if (searchInput) searchInput.focus();
}

async function saveSettingsConfig() {
  try {
    ensureTauri();
    if (themeSelect) settings.theme = themeSelect.value;
    if (shortcutDisplay) settings.shortcut = shortcutDisplay.textContent;
    if (autostartToggle) settings.autostart = autostartToggle.checked;
    applyTheme(settings.theme);
    await invoke("update_settings", { settings });
    closeSettings();
    if (searchInput) searchInput.focus();
  } catch (error) {
    console.error("[FromZero] Save settings error:", error);
    if (footerStatus) footerStatus.textContent = `保存设置失败: ${error}`;
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
  } else {
    if (recordBtn) {
      recordBtn.textContent = "录制组合键";
      recordBtn.classList.remove("recording");
    }
  }
}

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
  const isFunctionKey = /^F[1-9][0-2]?$/.test(e.key);
  if (!hasModifier && !isFunctionKey) return;
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
    if (shortcutDisplay) shortcutDisplay.textContent = parts.join("+");
    toggleRecordingShortcut();
  }
}
