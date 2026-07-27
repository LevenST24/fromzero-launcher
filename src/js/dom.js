// === Cached DOM element references ===

export const searchInput = document.getElementById("search-input");
export const searchIndicator = document.getElementById("search-indicator");
export const welcomeScreen = document.getElementById("welcome-screen");
export const recentGrid = document.getElementById("recent-grid");
export const resultsList = document.getElementById("results-list");
export const footerStatus = document.getElementById("footer-status");
export const launcherContainer = document.getElementById("launcher-container");
export const bgCanvas = document.getElementById("bg-canvas");

// Settings Modal DOM Elements
export const settingsToggle = document.getElementById("settings-toggle");
export const settingsOverlay = document.getElementById("settings-overlay");
export const settingsClose = document.getElementById("settings-close");
export const settingsCancel = document.getElementById("settings-cancel");
export const settingsSave = document.getElementById("settings-save");
export const settingsReset = document.getElementById("settings-reset");
export const shortcutDisplay = document.getElementById("shortcut-display");
export const recordBtn = document.getElementById("record-btn");
export const themeSelect = document.getElementById("theme-select");
export const autostartToggle = document.getElementById("autostart-toggle");
export const tabBtnGeneral = document.getElementById("tab-btn-general");
export const tabBtnGlass = document.getElementById("tab-btn-glass");
export const tabBtnLayout = document.getElementById("tab-btn-layout");
export const panelGeneral = document.getElementById("panel-general");
export const panelGlass = document.getElementById("panel-glass");
export const panelLayout = document.getElementById("panel-layout");

// Helper: clear DOM element children safely (no innerHTML), revoking any blob URLs
export function clearChildren(el) {
  const mediaElements = el.querySelectorAll("[data-blob-url]");
  mediaElements.forEach((item) => {
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
