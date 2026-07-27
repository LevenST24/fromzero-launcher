// === FromZero Launcher — entry module ===
// Wires modules together: init, global keyboard handling, event listeners.

import { invoke, listen, appWindow } from "./js/tauri.js";
import { state, APP_VERSION } from "./js/state.js";
import {
  searchInput,
  resultsList,
  footerStatus,
  settingsOverlay,
} from "./js/dom.js";
import {
  glassSettings,
  GLASS_SETTINGS_KEYS,
  applyVisualSettings,
  handleWindowFocus,
  initGlassLifecycle,
} from "./js/glass.js";
import {
  handleSearch,
  renderRecentApps,
  createIconElement,
  updateSelectionVisual,
  executeItemAction,
} from "./js/search.js";
import {
  applyTheme,
  openSettings,
  closeSettings,
  initSettingsUI,
  syncGeneralSettingsUI,
} from "./js/settings-ui.js";

// Global error diagnostics forwarded to the Rust backend console
window.onerror = function (message, source, lineno, colno, error) {
  const msg = `[Global JS Error] ${message} at ${source}:${lineno}:${colno}`;
  console.error(msg);
  invoke("debug_log", { msg: msg }).catch(() => {});
  return false;
};
window.addEventListener("unhandledrejection", function (event) {
  const msg = `[Unhandled Promise Rejection] ${event.reason}`;
  console.error(msg);
  invoke("debug_log", { msg: msg }).catch(() => {});
});

function scheduleSearch() {
  clearTimeout(state.searchDebounceTimeout);
  state.searchDebounceTimeout = setTimeout(() => {
    state.searchDebounceTimeout = null;
    void handleSearch();
  }, 180);
}

function resultIndexFromEvent(event) {
  if (!(event.target instanceof Element) || !resultsList) return null;
  const result = event.target.closest(".result-item");
  if (!result || !resultsList.contains(result)) return null;

  const index = Number.parseInt(result.dataset.index ?? "", 10);
  return Number.isInteger(index) && index >= 0 && index < state.filteredItems.length
    ? index
    : null;
}

function bindCoreUiEvents() {
  if (searchInput) {
    searchInput.addEventListener("compositionstart", () => {
      state.isComposing = true;
    });
    searchInput.addEventListener("compositionend", () => {
      state.isComposing = false;
      scheduleSearch();
    });
    searchInput.addEventListener("input", () => {
      if (!state.isComposing) scheduleSearch();
    });
  }

  window.addEventListener("keydown", handleGlobalKeys);

  if (!resultsList) return;
  resultsList.addEventListener("click", (event) => {
    const index = resultIndexFromEvent(event);
    if (index === null) return;
    state.selectedIndex = index;
    updateSelectionVisual();
  });
  resultsList.addEventListener("dblclick", (event) => {
    const index = resultIndexFromEvent(event);
    if (index === null) return;
    state.selectedIndex = index;
    updateSelectionVisual();
    void executeItemAction(state.filteredItems[index]);
  });
  // `pointerover` bubbles, so a single listener covers every dynamically
  // rendered result without the surprising capture behavior of mouseenter.
  resultsList.addEventListener("pointerover", (event) => {
    const index = resultIndexFromEvent(event);
    if (index === null || index === state.selectedIndex) return;
    state.selectedIndex = index;
    updateSelectionVisual();
  });
}

async function registerTauriListeners() {
  if (!listen) return;

  const subscriptions = [
    listen("apps-updated", (event) => {
      const newApps = Array.isArray(event.payload) ? event.payload : [];
      console.log(
        `[FromZero] Received background apps update: ${newApps.length} apps`,
      );
      state.appItems = newApps;
      if (footerStatus)
        footerStatus.textContent = `${APP_VERSION} · 已更新 ${state.appItems.length} 个应用`;
      renderRecentApps();
      void handleSearch();
    }),
    listen("icon-ready", (event) => {
      const appPath = event.payload;
      const app = state.appItems.find((candidate) => candidate.path === appPath);
      if (!app) return;

      const recentCard = Array.from(
        document.querySelectorAll(".recent-card"),
      ).find((card) => card.getAttribute("data-app-path") === appPath);
      const existingIcon = recentCard?.querySelector(".recent-icon");
      if (existingIcon) {
        recentCard.replaceChild(
          createIconElement(app.icon_path, "recent-icon"),
          existingIcon,
        );
      }

      if (!app.icon_path) return;
      document.querySelectorAll(".result-icon").forEach((element) => {
        if (element.getAttribute("data-app-path") !== appPath) return;
        const newIcon = createIconElement(app.icon_path, "result-icon");
        newIcon.setAttribute("data-app-path", appPath);
        newIcon.setAttribute("data-icon-path", app.icon_path);
        element.parentElement?.replaceChild(newIcon, element);
      });
    }),
  ];

  const results = await Promise.allSettled(subscriptions);
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error("[FromZero] Failed to register Tauri listener:", result.reason);
    }
  });
}

async function loadApps() {
  if (footerStatus)
    footerStatus.textContent = `${APP_VERSION} · 正在扫描开始菜单...`;
  try {
    state.appItems = await invoke("scan_apps");
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 已成功加载 ${state.appItems.length} 个应用`;
    console.log(`[FromZero] Loaded ${state.appItems.length} apps`);
  } catch (error) {
    console.error("[FromZero] Scan error:", error);
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 应用扫描失败，请检查日志`;
  } finally {
    renderRecentApps();
    if (searchInput?.value.trim()) void handleSearch();
  }
}

async function handleGlobalKeys(e) {
  if (state.isComposing || e.isComposing) {
    return;
  }
  // Shortcut recording is handled by a dedicated document-level keydown listener
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    if (e.key === "Escape") closeSettings();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (state.searchDebounceTimeout) {
      clearTimeout(state.searchDebounceTimeout);
      state.searchDebounceTimeout = null;
      await handleSearch();
    }
    if (state.filteredItems.length > 0) {
      if (state.selectedIndex < state.filteredItems.length - 1) {
        state.selectedIndex++;
        updateSelectionVisual();
      }
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (state.searchDebounceTimeout) {
      clearTimeout(state.searchDebounceTimeout);
      state.searchDebounceTimeout = null;
      await handleSearch();
    }
    if (state.filteredItems.length > 0) {
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelectionVisual();
      }
    }
  } else if (
    e.key === "Backspace" &&
    state.currentDirPath &&
    searchInput &&
    searchInput.value === state.currentDirPath
  ) {
    // Go up one directory level — but only intercept the keystroke when there
    // actually IS a parent to go to. At a drive root (e.g. "E:\") the regex
    // can't climb further, so fall through to the normal Backspace so the user
    // can delete the text instead of being stuck.
    const parentPath = state.currentDirPath.replace(/\\[^\\]+\\$/, "\\");
    if (parentPath !== state.currentDirPath && parentPath.length >= 3) {
      e.preventDefault();
      searchInput.value = parentPath;
      handleSearch();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (state.searchDebounceTimeout) {
      clearTimeout(state.searchDebounceTimeout);
      state.searchDebounceTimeout = null;
      await handleSearch();
    }
    const selected = state.filteredItems[state.selectedIndex];
    if (
      e.shiftKey &&
      selected &&
      (selected.type === "file" || selected.type === "dir")
    ) {
      // Open parent directory in Explorer
      const filePath = selected.data.path;
      const parentDir = filePath.substring(0, filePath.lastIndexOf("\\"));
      if (parentDir) {
        try {
          await invoke("open_folder", { path: parentDir });
        } catch (err) {
          console.warn(err);
        }
      }
      return;
    }
    if (state.filteredItems.length > 0 && selected) {
      executeItemAction(selected);
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

// =============================================
// Initialize application
// =============================================
window.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("[FromZero] Initializing...");
    initGlassLifecycle();

    try {
      state.settings = await invoke("get_settings");
      state.settings.recent_apps = state.settings.recent_apps || [];
      state.settings.web_engines = state.settings.web_engines || {};
    } catch (e) {
      console.error(
        "[FromZero] Failed to load settings, using empty defaults:",
        e,
      );
      state.settings = {};
    }
    state.settings.recent_apps ||= [];
    state.settings.web_engines ||= {};
    state.settings.theme ||= "dark";

    // Load Liquid Glass parameters from unified settings
    if (state.settings.glass_settings) {
      for (const [key, snakeKey] of Object.entries(GLASS_SETTINGS_KEYS)) {
        glassSettings[key] =
          state.settings.glass_settings[snakeKey] ?? glassSettings[key];
      }
    }
    applyVisualSettings(glassSettings);

    applyTheme(state.settings.theme);
    syncGeneralSettingsUI();
    bindCoreUiEvents();
    initSettingsUI();
    if (searchInput) searchInput.focus();

    // Register before scan_apps: a warm-cache scan starts its background
    // refresh immediately and could otherwise emit apps-updated before the UI
    // is listening.
    await registerTauriListeners();

    // Start the live glass capture as early as possible — it depends only on
    // glassSettings (already loaded), NOT on the app list. Previously this ran
    // at the very end of init, AFTER `await scan_apps` (a multi-second
    // PowerShell Start-Menu scan), so the window showed the plain Acrylic
    // fallback for several seconds before the glass kicked in. Kick it off now
    // and let the app scan proceed in the background.
    if (document.hasFocus()) {
      handleWindowFocus().catch((e) =>
        console.warn("[FromZero] Early glass start failed:", e),
      );
    }

    renderRecentApps();
    // Do not block input/settings initialization on the first full Start Menu
    // scan. Search automatically refreshes when the app list arrives.
    void loadApps();

    console.log("[FromZero] ✓ Frontend initialization complete");
    // Glass capture was already started earlier (right after settings load), so
    // it is not kicked off again here — the pumpToken guard would dedupe it
    // anyway, but starting once keeps the path clean.
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 初始化失败，请重试`;
  }
});
