// === Settings modal: tabs, sliders, theme, shortcut recording ===

import { invoke, appWindow } from "./tauri.js";
import {
  searchInput,
  footerStatus,
  settingsToggle,
  settingsOverlay,
  settingsClose,
  settingsCancel,
  settingsSave,
  settingsReset,
  shortcutDisplay,
  recordBtn,
  themeSelect,
  autostartToggle,
  tabBtnGeneral,
  tabBtnGlass,
  tabBtnLayout,
  panelGeneral,
  panelGlass,
  panelLayout,
} from "./dom.js";
import { state, APP_VERSION } from "./state.js";
import {
  glassSettings,
  DEFAULT_GLASS_SETTINGS,
  GLASS_SETTINGS_KEYS,
  applyVisualSettings,
  setGlassFps,
  debouncedSetCaptureFps,
} from "./glass.js";

let backupGlassSettings = null;
let currentShortcut = "Ctrl+Alt+Space";
let peekTimer = null;
let isRecording = false;
let previouslyFocusedElement = null;

// Single source of truth for all glass/layout sliders
// (drives listeners, state reads, and UI sync below).
const SLIDER_DEFS = [
  { id: "slider-glass-blur", valId: "val-glass-blur", key: "glassBlur", isFloat: false },
  { id: "slider-glass-fps", valId: "val-glass-fps", key: "glassFps", isFloat: false },
  { id: "slider-strength", valId: "val-strength", key: "strength", isFloat: false },
  { id: "slider-edge-hl", valId: "val-edge-hl", key: "edgeHl", isFloat: true, precision: 2 },
  { id: "slider-specular", valId: "val-specular", key: "specular", isFloat: true, precision: 2 },
  { id: "slider-fresnel", valId: "val-fresnel", key: "fresnel", isFloat: true, precision: 1 },
  { id: "slider-corner-radius", valId: "val-corner-radius", key: "cornerRadius", isFloat: false },
  { id: "slider-z-radius", valId: "val-z-radius", key: "zRadius", isFloat: false },
  { id: "slider-opacity", valId: "val-opacity", key: "opacity", isFloat: true, precision: 2 },
  { id: "slider-shadow-opacity", valId: "val-shadow-opacity", key: "shadowOpacity", isFloat: true, precision: 2 },
  { id: "slider-shadow-spread", valId: "val-shadow-spread", key: "shadowSpread", isFloat: false },
  { id: "slider-squircle-n", valId: "val-squircle-n", key: "squircleN", isFloat: true, precision: 1 },
  { id: "slider-search-height", valId: "val-search-height", key: "searchHeight", isFloat: false },
  { id: "slider-search-offset", valId: "val-search-offset", key: "searchOffset", isFloat: false },
  { id: "slider-results-height", valId: "val-results-height", key: "resultsHeight", isFloat: false },
  { id: "slider-chroma", valId: "val-chroma", key: "chroma", isFloat: true, precision: 2 },
  { id: "slider-distort", valId: "val-distort", key: "distortion", isFloat: true, precision: 3 },
  { id: "slider-sat", valId: "val-sat", key: "saturation", isFloat: true, precision: 2 },
  { id: "slider-brightness", valId: "val-brightness", key: "brightness", isFloat: true, precision: 2 },
  { id: "slider-tint-strength", valId: "val-tint-strength", key: "tintStrength", isFloat: true, precision: 2 },
];

function formatSliderValue(def, val) {
  return def.precision !== undefined ? val.toFixed(def.precision) : String(val);
}

// Briefly fade the settings modal so live slider tweaks are visible behind it
function peekSettingsOverlay() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.add("peek");
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    settingsOverlay.classList.remove("peek");
  }, 1200);
}

function initSliderListeners() {
  SLIDER_DEFS.forEach((def) => {
    const el = document.getElementById(def.id);
    if (!el) return;
    const valEl = document.getElementById(def.valId);
    const isFps = def.key === "glassFps";
    el.addEventListener("input", () => {
      const val = def.isFloat ? parseFloat(el.value) : parseInt(el.value);
      if (valEl) valEl.textContent = formatSliderValue(def, val);
      if (isFps) {
        setGlassFps(val);
        debouncedSetCaptureFps(val);
      } else {
        applyVisualSettings(readSlidersState());
      }
      peekSettingsOverlay();
    });
  });

  // Handle Bevel mode checkbox listener
  const bevelEl = document.getElementById("slider-bevel-mode");
  if (bevelEl) {
    bevelEl.addEventListener("change", () => {
      applyVisualSettings(readSlidersState());
      peekSettingsOverlay();
    });
  }
}

// Helper: Read sliders values
function readSlidersState() {
  const values = {};
  SLIDER_DEFS.forEach((def) => {
    const el = document.getElementById(def.id);
    if (!el) return;
    values[def.key] = def.isFloat ? parseFloat(el.value) : parseInt(el.value);
  });
  const bevelEl = document.getElementById("slider-bevel-mode");
  values.bevelMode = bevelEl ? bevelEl.checked : false;
  return values;
}

// Helper: Sync sliders elements to configurations
function syncSlidersToConfig(config) {
  SLIDER_DEFS.forEach((def) => {
    const el = document.getElementById(def.id);
    if (!el) return;
    const val = config[def.key] ?? DEFAULT_GLASS_SETTINGS[def.key];
    el.value = val;
    const valEl = document.getElementById(def.valId);
    if (valEl) valEl.textContent = formatSliderValue(def, val);
  });
  const bevelEl = document.getElementById("slider-bevel-mode");
  if (bevelEl) {
    bevelEl.checked = !!config.bevelMode;
  }
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function switchTab(tab) {
  const tabs = [
    { name: "general", btn: tabBtnGeneral, panel: panelGeneral },
    { name: "glass", btn: tabBtnGlass, panel: panelGlass },
    { name: "layout", btn: tabBtnLayout, panel: panelLayout },
  ];

  tabs.forEach((t) => {
    const isActive = t.name === tab;
    if (t.btn) {
      t.btn.classList.toggle("active", isActive);
      t.btn.setAttribute("aria-selected", String(isActive));
      t.btn.tabIndex = isActive ? 0 : -1;
    }
    if (t.panel) {
      t.panel.classList.toggle("active", isActive);
      t.panel.hidden = !isActive;
    }
  });
}

function customDirsInput() {
  return document.getElementById("custom-dirs-input");
}

function fillCustomDirsInput() {
  const el = customDirsInput();
  if (el) el.value = (state.settings.custom_app_dirs || []).join("; ");
}

function parseCustomDirsInput() {
  const el = customDirsInput();
  if (!el) return state.settings.custom_app_dirs || [];
  return el.value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function openSettings() {
  previouslyFocusedElement = document.activeElement;
  switchTab("general");
  if (settingsOverlay) {
    settingsOverlay.classList.add("active");
    settingsOverlay.setAttribute("aria-hidden", "false");
    settingsOverlay.inert = false;
  }
  if (themeSelect) themeSelect.value = state.settings.theme || "dark";
  currentShortcut = state.settings.shortcut || "Ctrl+Alt+Space";
  if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
  if (autostartToggle)
    autostartToggle.checked = state.settings.autostart || false;
  fillCustomDirsInput();

  // Back up settings in case of user cancel
  backupGlassSettings = { ...glassSettings };

  // Set sliders value to current config
  syncSlidersToConfig(glassSettings);
  requestAnimationFrame(() => settingsClose?.focus());
}

export function closeSettings() {
  clearTimeout(peekTimer);
  if (settingsOverlay) {
    settingsOverlay.classList.remove("active", "peek");
    settingsOverlay.setAttribute("aria-hidden", "true");
    settingsOverlay.inert = true;
  }
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

  if (
    previouslyFocusedElement instanceof HTMLElement &&
    previouslyFocusedElement.isConnected
  ) {
    previouslyFocusedElement.focus();
  } else if (searchInput) {
    searchInput.focus();
  }
  previouslyFocusedElement = null;
}

function resetToDefaults() {
  currentShortcut = "Ctrl+Alt+Space";
  if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
  if (themeSelect) themeSelect.value = "dark";
  if (autostartToggle) autostartToggle.checked = false;

  syncSlidersToConfig(DEFAULT_GLASS_SETTINGS);
  applyVisualSettings(DEFAULT_GLASS_SETTINGS);
}

async function saveSettingsConfig() {
  const nextSettings = JSON.parse(JSON.stringify(state.settings));
  if (themeSelect) nextSettings.theme = themeSelect.value;
  nextSettings.shortcut = currentShortcut;
  if (autostartToggle) nextSettings.autostart = autostartToggle.checked;
  nextSettings.custom_app_dirs = parseCustomDirsInput();

  const nextGlassSettings = readSlidersState();
  nextSettings.glass_settings = Object.fromEntries(
    Object.entries(GLASS_SETTINGS_KEYS).map(([key, snakeKey]) => [
      snakeKey,
      nextGlassSettings[key],
    ]),
  );

  try {
    await invoke("update_settings", {
      settings: nextSettings,
      oldSettings: state.settings,
    });
    // Success: commit to global state
    state.settings = nextSettings;
    Object.assign(glassSettings, nextGlassSettings);
    applyTheme(state.settings.theme);
    backupGlassSettings = null;
    closeSettings();
    try {
      await appWindow.hide();
    } catch (e) {
      console.warn("[FromZero] Hide after save failed:", e);
    }
  } catch (error) {
    console.error("[FromZero] Save settings error:", error);
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 保存设置失败: ${error}`;
    alert("保存设置失败: " + error);
  }
}

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

function recordShortcut(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const ignoreKeys = ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock"];
  const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const hasNonShiftModifier = e.ctrlKey || e.altKey || e.metaKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);

  // Prefer global hotkeys that cannot be triggered by normal uppercase typing.
  // Allow: Ctrl/Alt/Super combinations, Shift with another modifier, or function keys.
  if (
    (!hasModifier || (e.shiftKey && !hasNonShiftModifier)) &&
    !isFunctionKey
  ) {
    if (shortcutDisplay)
      shortcutDisplay.textContent = "请使用 Ctrl/Alt/Win 组合，或 F1-F24";
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

// Sync the General-tab widgets to freshly-loaded settings (called once at init)
export function syncGeneralSettingsUI() {
  if (shortcutDisplay)
    shortcutDisplay.textContent = state.settings.shortcut || "Ctrl+Alt+Space";
  if (themeSelect) themeSelect.value = state.settings.theme || "dark";
  if (autostartToggle)
    autostartToggle.checked = state.settings.autostart || false;
}

export function initSettingsUI() {
  if (settingsToggle) settingsToggle.addEventListener("click", openSettings);
  if (settingsClose) settingsClose.addEventListener("click", closeSettings);
  if (settingsCancel) settingsCancel.addEventListener("click", closeSettings);
  if (settingsSave) settingsSave.addEventListener("click", saveSettingsConfig);
  if (settingsReset) settingsReset.addEventListener("click", resetToDefaults);

  if (tabBtnGeneral)
    tabBtnGeneral.addEventListener("click", () => switchTab("general"));
  if (tabBtnGlass)
    tabBtnGlass.addEventListener("click", () => switchTab("glass"));
  if (tabBtnLayout)
    tabBtnLayout.addEventListener("click", () => switchTab("layout"));

  const tabs = [tabBtnGeneral, tabBtnGlass, tabBtnLayout].filter(Boolean);
  tabs.forEach((tab, index) => {
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else nextIndex = (index - 1 + tabs.length) % tabs.length;

      const nextTab = tabs[nextIndex];
      const panelId = nextTab.getAttribute("aria-controls");
      switchTab(panelId?.replace("panel-", "") ?? "general");
      nextTab.focus();
    });
  });

  if (recordBtn) recordBtn.addEventListener("click", toggleRecordingShortcut);

  // Register visual sliders change events
  initSliderListeners();

  // Dedicated keydown listener for shortcut recording at document level
  // (separate from handleGlobalKeys which is on window and may miss events
  //  when focus is inside the modal overlay)
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Tab" &&
      settingsOverlay?.classList.contains("active")
    ) {
      const focusable = Array.from(
        settingsOverlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      if (focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      currentShortcut = state.settings.shortcut || "Ctrl+Alt+Space";
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
}
