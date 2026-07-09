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
  console.warn(
    "[FromZero] window.__TAURI__ not found, using development mocks",
  );
  invoke = async (cmd, args) => {
    console.log(`[Mock Invoke] ${cmd}`, args);
    if (cmd === "get_settings") {
      return {
        shortcut: "Ctrl+Alt+Space",
        theme: "dark",
        web_engines: { g: "https://google.com/search?q={}" },
        recent_apps: [],
        autostart: false,
      };
    }
    if (cmd === "scan_apps") return [];
    if (cmd === "search_apps") return [];
    return {};
  };
  getCurrentWindow = () => ({
    hide: async () => console.log("[Mock Window] hide"),
    show: async () => console.log("[Mock Window] show"),
    setFocus: async () => console.log("[Mock Window] setFocus"),
    listen: async (event, callback) => {
      console.log(`[Mock Window] listen for ${event}`);
      return () => {};
    },
  });
  listen = (event, callback) => getCurrentWindow().listen(event, callback);
  convertFileSrc = (path) =>
    `https://asset.localhost/${encodeURIComponent(path)}`;
}

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

// App state variables
let appItems = [];
let filteredItems = [];
let selectedIndex = 0;
let settings = {};

// Liquid Glass customizable parameters
let glassSettings = {
  glassBlur: 20,
  glassFps: 60,
  strength: 28,
  searchHeight: 46,
  searchOffset: 10,
  resultsHeight: 280,

  // Liquid-glass preset matching the reference playground: light blur + strong
  // refraction + gloss (specular/fresnel) + a slight ice-blue tint + drop
  // shadow. The murky dark theme-tint was removed from the shader.
  edgeHl: 0.05,
  specular: 0.5,
  fresnel: 1.0,
  cornerRadius: 30.0,
  zRadius: 100.0,
  opacity: 1.0,
  shadowOpacity: 0.0,
  shadowSpread: 0.0,
  distortion: 0.0,
  saturation: 0.0,
  brightness: -0.2,
  tintStrength: 0.2,
  bevelMode: false,

  // Deprecated fields kept for compatibility
  borderOpacity: 0.6,
  chroma: 0.05,
  frost: 3.0,
  beer: 15,
  caustic: 0.6,
  squircleN: 4.5,
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
let currentShortcut = "Ctrl+Alt+Space";

// Mouse tracking to ignore hover selection during scroll
let lastMouseX = 0;
let lastMouseY = 0;
let pumping = false;
// Single-loop guard for pumpFrames: each fresh capture session bumps this token,
// so any older render loop self-terminates on its next tick (prevents concurrent
// double-rendering when focus fires twice without an intervening blur).
// NOTE: intentionally separate from captureGeneration, which the watchdog bumps
// while keeping the same render loop alive.
let pumpToken = 0;
let activeGlassFps = 60;
let peekTimer = null;

// WebGL state
let gl = null;
let glProgram = null;
let bgTexture = null;
let blurTexture = null;
let webglInitialized = false;
let lastRenderedSeq = 0;

// GPU two-pass separable Gaussian blur (replaces the old canvas 2D blur, which
// produced anisotropic "晕染"/smearing). The background is blurred on the GPU
// via ping-pong framebuffers, giving a clean isotropic frosted-glass blur.
let blurProgram = null;
let glQuadBuffer = null;
let glPosAttr = 0;
let blurPosAttr = 0;
let blurDirLoc = null;
let blurSigmaLoc = null;
let blurRadiusLoc = null;
let blurSrcLoc = null;
let blurFboA = null;
let blurFboB = null;
let blurTexA = null;
let blurTexB = null;
let blurFboW = 0;
let blurFboH = 0;

// Uniform locations
let bgTexLocation = null;
let blurTexLocation = null;
let resolutionLocation = null;
let centerLocation = null;
let sizeLocation = null;
let radiusLocation = null;
let refractLocation = null;
let chromaLocation = null;
let edgeHLLocation = null;
let specLocation = null;
let fresnelLocation = null;
let distortLocation = null;
let alphaLocation = null;
let satLocation = null;
let tintLocation = null;
let zRadiusLocation = null;
let brightnessLocation = null;
let shadowAlphaLocation = null;
let shadowSpreadLocation = null;
let shadowOffYLocation = null;
let bevelModeLocation = null;
let tintStrengthLocation = null;

// State machine & lifecycle control
let glassState = "Acrylic"; // "Acrylic", "Starting", "LiquidGlass", "Stopping"
let captureGeneration = 0;
let watchdogTimer = null;
let lastFrameTime = 0;

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
const settingsReset = document.getElementById("settings-reset");
const shortcutDisplay = document.getElementById("shortcut-display");
const recordBtn = document.getElementById("record-btn");
const themeSelect = document.getElementById("theme-select");
const autostartToggle = document.getElementById("autostart-toggle");
const tabBtnGeneral = document.getElementById("tab-btn-general");
const tabBtnGlass = document.getElementById("tab-btn-glass");
const tabBtnLayout = document.getElementById("tab-btn-layout");
const panelGeneral = document.getElementById("panel-general");
const panelGlass = document.getElementById("panel-glass");
const panelLayout = document.getElementById("panel-layout");

const appWindow = getCurrentWindow();

// System commands helper list
const SYSTEM_COMMANDS = [
  {
    key: "lock",
    name: "锁定屏幕 (Lock Screen)",
    desc: "锁定当前的 Windows 会话",
    badge: "系统",
  },
  {
    key: "sleep",
    name: "休眠系统 (Sleep)",
    desc: "使计算机进入低功耗睡眠状态",
    badge: "系统",
  },
  {
    key: "shutdown",
    name: "关闭计算机 (Shutdown)",
    desc: "关闭电源并退出所有应用",
    badge: "警告",
  },
  {
    key: "restart",
    name: "重启计算机 (Restart)",
    desc: "重新启动操作系统",
    badge: "系统",
  },
];

const APP_VERSION = "v0.2.5";

// =============================================
// Window Focus/Blur Management & State Machine
// =============================================

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (
      pumping &&
      (glassState === "LiquidGlass" || glassState === "Starting")
    ) {
      const inactiveTime = Date.now() - lastFrameTime;
      if (inactiveTime > 1500) {
        console.warn(
          `[FromZero] Watchdog: No new frames for ${inactiveTime}ms. Restarting background capture session...`,
        );
        lastFrameTime = Date.now(); // Reset time to avoid multiple triggers
        try {
          const gen = ++captureGeneration;
          await invoke("stop_bg_capture");
          if (gen === captureGeneration && pumping) {
            await invoke("start_bg_capture");
          }
        } catch (e) {
          console.error("[FromZero] Watchdog restart failed:", e);
        }
      }
    }
  }, 1000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function handleWindowFocus() {
  // Guard against redundant re-entry: on startup this is called once early
  // (right after settings load) and again from the window 'focus' event. If a
  // render loop is already pumping and we're not in the dormant Acrylic state,
  // don't tear the state machine back to "Starting" — just keep the live glass
  // running (the capture command is idempotent anyway).
  if (pumping && (glassState === "Starting" || glassState === "LiquidGlass")) {
    lastShowTime = Date.now();
    return;
  }
  const gen = ++captureGeneration;
  lastShowTime = Date.now();
  glassState = "Starting";
  pumping = true;
  lastFrameTime = Date.now();

  const container = document.getElementById("launcher-container");
  if (container) {
    container.classList.add("blurred");
    container.classList.remove("liquid-glass-active");
  }

  // Keep DWM Acrylic active during starting phase
  try {
    await invoke("set_blur", { value: glassSettings.glassBlur });
  } catch (_) {}

  try {
    await invoke("start_bg_capture");
    if (gen !== captureGeneration || !pumping) return;
    // Bump the pump token so any previously running render loop (e.g. from a
    // duplicate focus event that never saw a blur) terminates on its next tick,
    // leaving exactly one active loop.
    const myPumpToken = ++pumpToken;
    pumpFrames(myPumpToken);
    startWatchdog();
  } catch (e) {
    console.warn(
      "[FromZero] Live glass capture unavailable, fallback to Acrylic:",
      e,
    );
    if (gen !== captureGeneration) return;
    pumping = false;
    glassState = "Acrylic";
    stopWatchdog();
    if (container) {
      container.classList.add("blurred");
      container.classList.remove("liquid-glass-active");
    }
    try {
      await invoke("set_blur", { value: glassSettings.glassBlur });
    } catch (_) {}
  }

  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }, 50);
}

window.addEventListener("focus", handleWindowFocus);

window.addEventListener("blur", async () => {
  const gen = ++captureGeneration;
  glassState = "Stopping";
  pumping = false;
  stopWatchdog();

  const container = document.getElementById("launcher-container");
  if (container) {
    container.classList.add("blurred");
    container.classList.remove("liquid-glass-active");
  }

  // Restore DWM Acrylic for a smooth show/fade transition next time
  try {
    await invoke("set_blur", { value: glassSettings.glassBlur });
  } catch (_) {}

  try {
    await invoke("stop_bg_capture");
  } catch (_) {}

  const timeSinceShow = Date.now() - lastShowTime;
  if (timeSinceShow < 300) {
    return;
  }
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    return;
  }
  setTimeout(async () => {
    if (!document.hasFocus() && glassState === "Stopping") {
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
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

// =============================================
// Helper: clear DOM element children safely (no innerHTML)
// =============================================
function clearChildren(el) {
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

// Helper: Apply visual configurations to DOM/CSS and SVG filter scales in real time
function applyVisualSettings(config) {
  const container = document.getElementById("launcher-container");
  if (!container) return;

  activeGlassFps = config.glassFps || 60;
  glassSettings.glassBlur = config.glassBlur;
  glassSettings.glassFps = config.glassFps;
  glassSettings.strength = config.strength ?? glassSettings.strength;

  // New Liquid Glass properties
  glassSettings.edgeHl = config.edgeHl ?? glassSettings.edgeHl;
  glassSettings.specular = config.specular ?? glassSettings.specular;
  glassSettings.fresnel = config.fresnel ?? glassSettings.fresnel;
  glassSettings.cornerRadius =
    config.cornerRadius ?? glassSettings.cornerRadius;
  glassSettings.zRadius = config.zRadius ?? glassSettings.zRadius;
  glassSettings.opacity = config.opacity ?? glassSettings.opacity;
  glassSettings.shadowOpacity =
    config.shadowOpacity ?? glassSettings.shadowOpacity;
  glassSettings.shadowSpread =
    config.shadowSpread ?? glassSettings.shadowSpread;
  glassSettings.chroma = config.chroma ?? glassSettings.chroma;
  glassSettings.distortion = config.distortion ?? glassSettings.distortion;
  glassSettings.saturation = config.saturation ?? glassSettings.saturation;
  glassSettings.brightness = config.brightness ?? glassSettings.brightness;
  glassSettings.tintStrength =
    config.tintStrength ?? glassSettings.tintStrength;
  glassSettings.bevelMode = config.bevelMode ?? glassSettings.bevelMode;

  // Layout properties
  glassSettings.squircleN = config.squircleN ?? glassSettings.squircleN;
  glassSettings.searchHeight =
    config.searchHeight ?? glassSettings.searchHeight ?? 46;
  glassSettings.searchOffset =
    config.searchOffset ?? glassSettings.searchOffset ?? 10;
  glassSettings.resultsHeight =
    config.resultsHeight ?? glassSettings.resultsHeight ?? 280;

  container.style.setProperty(
    "--search-height",
    `${glassSettings.searchHeight}px`,
  );
  container.style.setProperty(
    "--search-offset",
    `${glassSettings.searchOffset}px`,
  );
  container.style.setProperty(
    "--results-height",
    `${glassSettings.resultsHeight}px`,
  );
  container.style.setProperty(
    "--corner-radius",
    `${glassSettings.cornerRadius}px`,
  );

  // Set canvas blur CSS custom property directly (full range up to 30px)
  container.style.setProperty("--canvas-blur", `${config.glassBlur}px`);

  // Toggle DWM Acrylic: only when not in LiquidGlass or Starting state
  if (glassState === "Acrylic" || glassState === "Stopping") {
    clearTimeout(setBlurTimeout);
    setBlurTimeout = setTimeout(() => {
      try {
        invoke("set_blur", { value: config.glassBlur });
      } catch (e) {}
    }, 60);
  }

  // Dynamically update recent apps list row count based on container height
  renderRecentApps();
}

// 300ms debounced invoke to set_capture_fps
const debouncedSetCaptureFps = (() => {
  let timer = null;
  return (fps) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (pumping) {
        try {
          await invoke("set_capture_fps", { fps });
        } catch (e) {
          console.error("[FromZero] Failed to set capture FPS:", e);
        }
      }
    }, 300);
  };
})();

// Helper: Initialize sliders listeners
function initSliderListeners() {
  const sliders = [
    {
      id: "slider-glass-blur",
      valId: "val-glass-blur",
      key: "glassBlur",
      isFloat: false,
    },
    {
      id: "slider-strength",
      valId: "val-strength",
      key: "strength",
      isFloat: false,
    },
    {
      id: "slider-edge-hl",
      valId: "val-edge-hl",
      key: "edgeHl",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-specular",
      valId: "val-specular",
      key: "specular",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-fresnel",
      valId: "val-fresnel",
      key: "fresnel",
      isFloat: true,
      precision: 1,
    },
    {
      id: "slider-corner-radius",
      valId: "val-corner-radius",
      key: "cornerRadius",
      isFloat: false,
    },
    {
      id: "slider-z-radius",
      valId: "val-z-radius",
      key: "zRadius",
      isFloat: false,
    },
    {
      id: "slider-opacity",
      valId: "val-opacity",
      key: "opacity",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-shadow-opacity",
      valId: "val-shadow-opacity",
      key: "shadowOpacity",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-shadow-spread",
      valId: "val-shadow-spread",
      key: "shadowSpread",
      isFloat: false,
    },
    {
      id: "slider-squircle-n",
      valId: "val-squircle-n",
      key: "squircleN",
      isFloat: true,
      precision: 1,
    },
    {
      id: "slider-search-height",
      valId: "val-search-height",
      key: "searchHeight",
      isFloat: false,
    },
    {
      id: "slider-search-offset",
      valId: "val-search-offset",
      key: "searchOffset",
      isFloat: false,
    },
    {
      id: "slider-results-height",
      valId: "val-results-height",
      key: "resultsHeight",
      isFloat: false,
    },

    // New sliders
    {
      id: "slider-chroma",
      valId: "val-chroma",
      key: "chroma",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-distort",
      valId: "val-distort",
      key: "distortion",
      isFloat: true,
      precision: 3,
    },
    {
      id: "slider-sat",
      valId: "val-sat",
      key: "saturation",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-brightness",
      valId: "val-brightness",
      key: "brightness",
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-tint-strength",
      valId: "val-tint-strength",
      key: "tintStrength",
      isFloat: true,
      precision: 2,
    },
  ];

  sliders.forEach((s) => {
    const el = document.getElementById(s.id);
    const valEl = document.getElementById(s.valId);
    if (el) {
      el.addEventListener("input", () => {
        const val = s.isFloat ? parseFloat(el.value) : parseInt(el.value);
        if (valEl) {
          if (s.precision !== undefined) {
            valEl.textContent = val.toFixed(s.precision);
          } else {
            valEl.textContent = val;
          }
        }

        const currentConfig = readSlidersState();
        applyVisualSettings(currentConfig);

        if (settingsOverlay) {
          settingsOverlay.classList.add("peek");
          clearTimeout(peekTimer);
          peekTimer = setTimeout(() => {
            settingsOverlay.classList.remove("peek");
          }, 1200);
        }
      });
    }
  });

  const fpsEl = document.getElementById("slider-glass-fps");
  const fpsValEl = document.getElementById("val-glass-fps");
  if (fpsEl) {
    fpsEl.addEventListener("input", () => {
      const val = parseInt(fpsEl.value);
      if (fpsValEl) {
        fpsValEl.textContent = val;
      }
      glassSettings.glassFps = val;
      activeGlassFps = val;

      if (settingsOverlay) {
        settingsOverlay.classList.add("peek");
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => {
          settingsOverlay.classList.remove("peek");
        }, 1200);
      }

      debouncedSetCaptureFps(val);
    });
  }

  // Handle Bevel mode checkbox listener
  const bevelEl = document.getElementById("slider-bevel-mode");
  if (bevelEl) {
    bevelEl.addEventListener("change", () => {
      const currentConfig = readSlidersState();
      applyVisualSettings(currentConfig);

      if (settingsOverlay) {
        settingsOverlay.classList.add("peek");
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => {
          settingsOverlay.classList.remove("peek");
        }, 1200);
      }
    });
  }
}

// Helper: Read sliders values
function readSlidersState() {
  const bevelEl = document.getElementById("slider-bevel-mode");
  return {
    glassBlur: parseInt(document.getElementById("slider-glass-blur").value),
    glassFps: parseInt(document.getElementById("slider-glass-fps").value),
    strength: parseInt(document.getElementById("slider-strength").value),
    edgeHl: parseFloat(document.getElementById("slider-edge-hl").value),
    specular: parseFloat(document.getElementById("slider-specular").value),
    fresnel: parseFloat(document.getElementById("slider-fresnel").value),
    cornerRadius: parseFloat(
      document.getElementById("slider-corner-radius").value,
    ),
    zRadius: parseFloat(document.getElementById("slider-z-radius").value),
    opacity: parseFloat(document.getElementById("slider-opacity").value),
    shadowOpacity: parseFloat(
      document.getElementById("slider-shadow-opacity").value,
    ),
    shadowSpread: parseFloat(
      document.getElementById("slider-shadow-spread").value,
    ),
    squircleN: parseFloat(document.getElementById("slider-squircle-n").value),
    searchHeight: parseInt(
      document.getElementById("slider-search-height").value,
    ),
    searchOffset: parseInt(
      document.getElementById("slider-search-offset").value,
    ),
    resultsHeight: parseInt(
      document.getElementById("slider-results-height").value,
    ),

    // New fields
    chroma: parseFloat(document.getElementById("slider-chroma").value),
    distortion: parseFloat(document.getElementById("slider-distort").value),
    saturation: parseFloat(document.getElementById("slider-sat").value),
    brightness: parseFloat(document.getElementById("slider-brightness").value),
    tintStrength: parseFloat(
      document.getElementById("slider-tint-strength").value,
    ),
    bevelMode: bevelEl ? bevelEl.checked : false,

    // Maintain old fields internally for compatibility
    borderOpacity: glassSettings.borderOpacity,
    frost: glassSettings.frost,
    beer: glassSettings.beer,
    caustic: glassSettings.caustic,
  };
}

// Helper: Sync sliders elements to configurations
function syncSlidersToConfig(config) {
  const mappings = [
    {
      id: "slider-glass-blur",
      valId: "val-glass-blur",
      val: config.glassBlur,
      isFloat: false,
    },
    {
      id: "slider-glass-fps",
      valId: "val-glass-fps",
      val: config.glassFps,
      isFloat: false,
    },
    {
      id: "slider-strength",
      valId: "val-strength",
      val: config.strength,
      isFloat: false,
    },
    {
      id: "slider-edge-hl",
      valId: "val-edge-hl",
      val: config.edgeHl,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-specular",
      valId: "val-specular",
      val: config.specular,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-fresnel",
      valId: "val-fresnel",
      val: config.fresnel,
      isFloat: true,
      precision: 1,
    },
    {
      id: "slider-corner-radius",
      valId: "val-corner-radius",
      val: config.cornerRadius,
      isFloat: false,
    },
    {
      id: "slider-z-radius",
      valId: "val-z-radius",
      val: config.zRadius,
      isFloat: false,
    },
    {
      id: "slider-opacity",
      valId: "val-opacity",
      val: config.opacity,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-shadow-opacity",
      valId: "val-shadow-opacity",
      val: config.shadowOpacity,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-shadow-spread",
      valId: "val-shadow-spread",
      val: config.shadowSpread,
      isFloat: false,
    },
    {
      id: "slider-squircle-n",
      valId: "val-squircle-n",
      val: config.squircleN,
      isFloat: true,
      precision: 1,
    },
    {
      id: "slider-search-height",
      valId: "val-search-height",
      val: config.searchHeight ?? 46,
      isFloat: false,
    },
    {
      id: "slider-search-offset",
      valId: "val-search-offset",
      val: config.searchOffset ?? 10,
      isFloat: false,
    },
    {
      id: "slider-results-height",
      valId: "val-results-height",
      val: config.resultsHeight ?? 280,
      isFloat: false,
    },

    // New mappings
    {
      id: "slider-chroma",
      valId: "val-chroma",
      val: config.chroma ?? 0.28,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-distort",
      valId: "val-distort",
      val: config.distortion ?? 0.0,
      isFloat: true,
      precision: 3,
    },
    {
      id: "slider-sat",
      valId: "val-sat",
      val: config.saturation ?? 0.0,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-brightness",
      valId: "val-brightness",
      val: config.brightness ?? -0.3,
      isFloat: true,
      precision: 2,
    },
    {
      id: "slider-tint-strength",
      valId: "val-tint-strength",
      val: config.tintStrength ?? 0.2,
      isFloat: true,
      precision: 2,
    },
  ];

  mappings.forEach((m) => {
    const el = document.getElementById(m.id);
    const valEl = document.getElementById(m.valId);
    if (el) {
      el.value = m.val;
      if (valEl) {
        if (m.precision !== undefined) {
          valEl.textContent = m.val.toFixed(m.precision);
        } else {
          valEl.textContent = m.val;
        }
      }
    }
  });

  const bevelEl = document.getElementById("slider-bevel-mode");
  if (bevelEl) {
    bevelEl.checked = !!config.bevelMode;
  }
}

// =============================================
// Real-time Background Refraction Helpers
// =============================================
function compileShader(gl, source, type) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const msg =
      "[FromZero] Shader compile error (" +
      (type === gl.VERTEX_SHADER ? "VERTEX" : "FRAGMENT") +
      "):\n" +
      log;
    console.error(msg);
    invoke("debug_log", { msg: msg }).catch(() => {});
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebGL(canvas) {
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      depth: false,
      antialias: true,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      const msg =
        "[FromZero] WebGL2 context not supported, falling back to WebGL1 (Premium shader disabled)";
      console.warn(msg);
      invoke("debug_log", { msg: msg }).catch(() => {});
      return false;
    }

    const vsSource = `#version 300 es
      in vec2 a_position;
      out vec2 v_texCoord;
      void main() {
        v_texCoord = a_position * 0.5 + 0.5;
        v_texCoord.y = 1.0 - v_texCoord.y;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_texCoord;
      out vec4 fragColor;

      uniform sampler2D u_bgTex;
      uniform sampler2D u_blurTex;
      uniform vec2 u_resolution;
      uniform vec2 u_center;
      uniform vec2 u_size;
      uniform float u_radius;
      uniform float u_refract;
      uniform float u_chroma;
      uniform float u_edgeHL;
      uniform float u_spec;
      uniform float u_fresnel;
      uniform float u_distort;
      uniform float u_alpha;
      uniform float u_sat;
      uniform vec4 u_tint;
      uniform float u_zRadius;
      uniform float u_brightness;
      uniform float u_shadowAlpha;
      uniform float u_shadowSpread;
      uniform float u_shadowOffY;
      uniform float u_bevelMode;
      uniform float u_tintStrength;

      // Rounded-rect signed distance
      float rrSDF(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + vec2(r);
        return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
      }

      // Bevel height field
      float bevelHeight(float d, float zR) {
        if (d <= 0.0) return 0.0;
        if (d >= zR) return zR;
        return sqrt(d * (2.0 * zR - d));
      }

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vec2 px = v_texCoord * u_resolution;
        vec2 half_ = u_size * 0.5;
        float r = min(u_radius, min(half_.x, half_.y));
        float sdf = rrSDF(px - u_center, half_, r);

        // ------ Shadow (outside panel) ------
        if (sdf > 0.0) {
          float sdfShadow = rrSDF(px - u_center - vec2(0.0, u_shadowOffY), half_, r);
          float d = max(sdfShadow - 1.0, 0.0);
          float spread = max(u_shadowSpread, 1.0);
          float falloff = 1.0 / (spread * spread);
          float outerShadow = exp(-d * d * falloff) * 0.65;
          float contactShadow = exp(-d * 0.08 / max(spread * 0.04, 0.01)) * 0.35;
          float shadow = (outerShadow + contactShadow) * u_shadowAlpha;

          // Output shadow outside card with transparent background
          fragColor = vec4(0.0, 0.0, 0.0, shadow);
          return;
        }

        // ------ Inside Glass Panel ------
        float mask = 1.0 - smoothstep(-1.5, 0.5, sdf);
        float maxD = min(half_.x, half_.y);
        float inside = -sdf;
        float edge = smoothstep(maxD * 0.35, 0.0, inside);

        // Surface normal (top surface) via bevel height field
        float zR = u_zRadius;
        float e = 2.0;
        float dC = inside;
        float dR = -rrSDF(px + vec2(e, 0.0) - u_center, half_, r);
        float dL = -rrSDF(px - vec2(e, 0.0) - u_center, half_, r);
        float dU = -rrSDF(px + vec2(0.0, e) - u_center, half_, r);
        float dD = -rrSDF(px - vec2(0.0, e) - u_center, half_, r);
        float hC = bevelHeight(dC, zR);
        float hR = bevelHeight(dR, zR);
        float hL = bevelHeight(dL, zR);
        float hU = bevelHeight(dU, zR);
        float hD = bevelHeight(dD, zR);
        vec2 hGrad = vec2(hR - hL, hU - hD) / (2.0 * e);
        vec3 N = normalize(vec3(-hGrad, 1.0));

        float depth = smoothstep(0.0, zR, inside);

        // ------ Refraction ------
        vec2 pxToUV = vec2(1.0, -1.0) / u_resolution;
        float ior = 1.5;
        float refrPow = 1.0 - 1.0 / ior;
        float thickness = hC * 2.0;
        float thickNorm = thickness / max(zR * 2.0, 1.0);
        vec2 refrPx;
        if (u_bevelMode < 0.5) {
          // Biconvex: physically-based dual-surface refraction
          vec2 exitRefr = hGrad * refrPow;
          vec2 entryRefr = hGrad * refrPow;
          vec2 throughRefr = entryRefr * thickNorm * 0.5;
          refrPx = (exitRefr + entryRefr + throughRefr) * u_refract * 30.0;
          vec2 centerDir = -(px - u_center) / max(half_, vec2(1.0));
          refrPx += centerDir * u_refract * 4.0 * depth;
        } else {
          // Dome (plano-convex): uniform magnification
          refrPx = -(px - u_center) * u_refract * depth * 0.35;
        }
        vec2 refr = refrPx * pxToUV;

        // ------ Micro-distortion noise ------
        vec2 ns = px * 0.08;
        vec2 absPxToUV = vec2(1.0) / u_resolution;
        vec2 micro = (vec2(hash(ns), hash(ns + vec2(37.0))) - 0.5) * u_distort * 4.0 * absPxToUV;

        // ------ Chromatic aberration ------
        float caS = u_chroma * 18.0 * (edge * 0.7 + 0.3) * 2.0;
        vec2 caD = N.xy * caS * pxToUV;
        vec2 base = v_texCoord + refr + micro;

        vec3 sharp = vec3(
          texture(u_bgTex,  base + caD).r,
          texture(u_bgTex,  base).g,
          texture(u_bgTex,  base - caD).b
        );
        vec3 blur = vec3(
          texture(u_blurTex, base + caD).r,
          texture(u_blurTex, base).g,
          texture(u_blurTex, base - caD).b
        );

        // Edge-weighted blur mix
        float edgeMix = (1.0 - edge * 0.15);
        vec3 col = mix(sharp, blur, edgeMix);

        // ------ Brightness ------
        col *= 1.0 + u_brightness;

        // ------ Saturation ------
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(lum), col, 1.0 + u_sat);

        // ------ Ice-blue Tint ------
        // (The reference liquid-glass shader applies ONLY this subtle ice-blue
        // tint. An earlier extra "theme-aware" mix toward a dark color
        // (18,18,24) was what made the glass look murky/闷 — removed.)
        col = mix(col, col * vec3(0.92, 0.95, 1.05), u_tintStrength);
        col *= 1.0 + 0.06 * depth;

        // ------ Fresnel ------
        float fres = pow(1.0 - abs(N.z), 4.0) * u_fresnel;

        // ------ Specular highlights (multi-light Blinn-Phong) ------
        vec3 V = vec3(0.0, 0.0, 1.0);
        vec3 L1 = normalize(vec3(0.4, 0.7, 1.0));
        vec3 H1 = normalize(L1 + V);
        float sp1 = pow(max(dot(N, H1), 0.0), 90.0);
        vec3 L2 = normalize(vec3(-0.3, -0.5, 1.0));
        vec3 H2 = normalize(L2 + V);
        float sp2 = pow(max(dot(N, H2), 0.0), 50.0) * 0.3;
        vec3 L3 = normalize(vec3(0.1, 0.3, 1.0));
        float spB = pow(max(dot(N, L3), 0.0), 6.0) * 0.1;
        vec3 L4 = normalize(vec3(0.0, 0.9, 0.4));
        vec3 H4 = normalize(L4 + V);
        float sp4 = pow(max(dot(N, H4), 0.0), 120.0) * 0.6;
        float totalSpec = (sp1 + sp2 + spB + sp4) * u_spec;

        // ------ Inner border / stroke highlight ------
        float borderWidth = 1.5;
        float innerStroke = smoothstep(-borderWidth - 1.0, -borderWidth, sdf)
                          * (1.0 - smoothstep(-1.0, 0.0, sdf));
        float topBias = 0.5 + 0.5 * (-(px.y - u_center.y) / half_.y);
        innerStroke *= (0.4 + 0.6 * topBias);

        // ------ Edge highlight & inner glow ------
        float rim = edge * u_edgeHL * 0.22;
        float innerGlow = smoothstep(5.0, 0.0, -sdf) * u_edgeHL * 0.15;

        // ------ Environment-like reflection (fake) ------
        float envRefl = (N.y * 0.5 + 0.5) * fres * 0.08;

        // ------ Composite ------
        vec3 fin = col;
        fin += vec3(totalSpec);
        fin += vec3(rim + innerGlow);
        fin += vec3(innerStroke * u_edgeHL * 0.55);
        fin += vec3(envRefl);
        fin = mix(fin, vec3(1.0), fres * 0.2);

        vec3 bgColor = texture(u_bgTex, v_texCoord).rgb;
        fragColor = vec4(mix(bgColor, fin, mask * u_alpha), 1.0);
      }
    `;

    const vs = compileShader(gl, vsSource, gl.VERTEX_SHADER);
    const fs = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);

    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(glProgram);
      const msg = "[FromZero] WebGL program link error:\n" + log;
      console.error(msg);
      invoke("debug_log", { msg: msg }).catch(() => {});
      return false;
    }

    gl.useProgram(glProgram);

    const positionBuffer = gl.createBuffer();
    glQuadBuffer = positionBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const posAttr = gl.getAttribLocation(glProgram, "a_position");
    glPosAttr = posAttr;
    gl.enableVertexAttribArray(posAttr);
    gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

    // --- Compile the separable Gaussian blur program (for GPU background blur) ---
    {
      const blurVsSrc = `#version 300 es
        in vec2 a_position;
        out vec2 v_uv;
        void main() {
          v_uv = a_position * 0.5 + 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }`;
      const blurFsSrc = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;
        uniform sampler2D u_src;
        uniform vec2 u_dir;     // texel step along blur axis (1/size, 0) or (0, 1/size)
        uniform float u_sigma;
        uniform int u_radius;
        void main() {
          float wsum = 0.0;
          vec3 acc = vec3(0.0);
          for (int i = -32; i <= 32; i++) {
            if (i < -u_radius || i > u_radius) continue;
            float w = exp(-0.5 * float(i * i) / (u_sigma * u_sigma));
            acc += texture(u_src, v_uv + u_dir * float(i)).rgb * w;
            wsum += w;
          }
          fragColor = vec4(acc / wsum, 1.0);
        }`;
      const bvs = compileShader(gl, blurVsSrc, gl.VERTEX_SHADER);
      const bfs = compileShader(gl, blurFsSrc, gl.FRAGMENT_SHADER);
      if (bvs && bfs) {
        blurProgram = gl.createProgram();
        gl.attachShader(blurProgram, bvs);
        gl.attachShader(blurProgram, bfs);
        gl.linkProgram(blurProgram);
        if (!gl.getProgramParameter(blurProgram, gl.LINK_STATUS)) {
          console.error(
            "[FromZero] Blur program link error:\n" +
              gl.getProgramInfoLog(blurProgram),
          );
          blurProgram = null;
        } else {
          blurPosAttr = gl.getAttribLocation(blurProgram, "a_position");
          blurDirLoc = gl.getUniformLocation(blurProgram, "u_dir");
          blurSigmaLoc = gl.getUniformLocation(blurProgram, "u_sigma");
          blurRadiusLoc = gl.getUniformLocation(blurProgram, "u_radius");
          blurSrcLoc = gl.getUniformLocation(blurProgram, "u_src");
        }
      }
      gl.useProgram(glProgram);
    }

    bgTexLocation = gl.getUniformLocation(glProgram, "u_bgTex");
    blurTexLocation = gl.getUniformLocation(glProgram, "u_blurTex");
    resolutionLocation = gl.getUniformLocation(glProgram, "u_resolution");
    centerLocation = gl.getUniformLocation(glProgram, "u_center");
    sizeLocation = gl.getUniformLocation(glProgram, "u_size");
    radiusLocation = gl.getUniformLocation(glProgram, "u_radius");
    refractLocation = gl.getUniformLocation(glProgram, "u_refract");
    chromaLocation = gl.getUniformLocation(glProgram, "u_chroma");
    edgeHLLocation = gl.getUniformLocation(glProgram, "u_edgeHL");
    specLocation = gl.getUniformLocation(glProgram, "u_spec");
    fresnelLocation = gl.getUniformLocation(glProgram, "u_fresnel");
    distortLocation = gl.getUniformLocation(glProgram, "u_distort");
    alphaLocation = gl.getUniformLocation(glProgram, "u_alpha");
    satLocation = gl.getUniformLocation(glProgram, "u_sat");
    tintLocation = gl.getUniformLocation(glProgram, "u_tint");
    zRadiusLocation = gl.getUniformLocation(glProgram, "u_zRadius");
    brightnessLocation = gl.getUniformLocation(glProgram, "u_brightness");
    shadowAlphaLocation = gl.getUniformLocation(glProgram, "u_shadowAlpha");
    shadowSpreadLocation = gl.getUniformLocation(glProgram, "u_shadowSpread");
    shadowOffYLocation = gl.getUniformLocation(glProgram, "u_shadowOffY");
    bevelModeLocation = gl.getUniformLocation(glProgram, "u_bevelMode");
    tintStrengthLocation = gl.getUniformLocation(glProgram, "u_tintStrength");

    bgTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    blurTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blurTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    canvas.style.filter = "none";

    // Pre-warm WebGL: render a blank frame to warm up shader compilation and GPU pipeline
    try {
      gl.viewport(0, 0, 10, 10);
      const dummyTex1 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dummyTex1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      );

      const dummyTex2 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dummyTex2);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      );

      gl.useProgram(glProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dummyTex1);
      gl.uniform1i(bgTexLocation, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dummyTex2);
      gl.uniform1i(blurTexLocation, 1);

      gl.uniform2f(resolutionLocation, 10, 10);
      gl.uniform2f(centerLocation, 5, 5);
      gl.uniform2f(sizeLocation, 10, 10);
      gl.uniform1f(radiusLocation, 2);
      gl.uniform1f(refractLocation, 0);
      gl.uniform1f(chromaLocation, 0);
      gl.uniform1f(edgeHLLocation, 0);
      gl.uniform1f(specLocation, 0);
      gl.uniform1f(fresnelLocation, 0);
      gl.uniform1f(distortLocation, 0);
      gl.uniform1f(alphaLocation, 1.0);
      gl.uniform1f(satLocation, 0);
      gl.uniform4f(tintLocation, 0, 0, 0, 0);
      gl.uniform1f(zRadiusLocation, 5);
      gl.uniform1f(brightnessLocation, 0);
      gl.uniform1f(shadowAlphaLocation, 0);
      gl.uniform1f(shadowSpreadLocation, 0);
      gl.uniform1f(shadowOffYLocation, 0);
      gl.uniform1f(bevelModeLocation, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.deleteTexture(dummyTex1);
      gl.deleteTexture(dummyTex2);
      console.log("[FromZero] WebGL context pre-warmed successfully");
    } catch (e) {
      console.warn("[FromZero] WebGL pre-warming failed:", e);
    }

    webglInitialized = true;
    const msg = "[FromZero] WebGL2 context successfully initialized";
    console.log(msg);
    invoke("debug_log", { msg: msg }).catch(() => {});
    return true;
  } catch (e) {
    const msg = "[FromZero] Failed to init WebGL2 context: " + e;
    console.error(msg);
    invoke("debug_log", { msg: msg }).catch(() => {});
    webglInitialized = false;
    return false;
  }
}

// (Re)allocate the ping-pong framebuffers used by the GPU Gaussian blur to a
// given size. Cheap no-op when the size is unchanged.
function ensureBlurFbos(bw, bh) {
  if (blurFboA && blurFboW === bw && blurFboH === bh) return true;
  if (blurTexA) gl.deleteTexture(blurTexA);
  if (blurTexB) gl.deleteTexture(blurTexB);
  if (blurFboA) gl.deleteFramebuffer(blurFboA);
  if (blurFboB) gl.deleteFramebuffer(blurFboB);
  const make = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f };
  };
  const A = make();
  const B = make();
  blurTexA = A.t;
  blurFboA = A.f;
  blurTexB = B.t;
  blurFboB = B.f;
  blurFboW = bw;
  blurFboH = bh;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== 0;
}

async function pumpFrames(myToken) {
  // If a newer capture session started, this older loop must die so only one
  // render loop runs at a time. Tokenless calls (legacy) default to current token.
  if (myToken === undefined) myToken = pumpToken;
  if (!pumping || myToken !== pumpToken) return;
  const bgCanvas = document.getElementById("bg-canvas");
  if (!bgCanvas) return;

  if (!webglInitialized && !initWebGL(bgCanvas)) {
    pumping = false;
    return;
  }

  const startTime = Date.now();

  try {
    const res = await fetch(
      `http://bgframe.localhost/frame?since=${lastRenderedSeq}`,
      { cache: "no-store" },
    );
    if (res.status === 200) {
      lastFrameTime = Date.now();
      const seq = +res.headers.get("X-Frame-Seq");
      const w = +res.headers.get("X-Frame-Width");
      const h = +res.headers.get("X-Frame-Height");
      const buf = await res.arrayBuffer();
      if (seq !== lastRenderedSeq) {
        lastRenderedSeq = seq;
        if (buf.byteLength === w * h * 4) {
          if (bgCanvas.width !== w || bgCanvas.height !== h) {
            bgCanvas.width = w;
            bgCanvas.height = h;
            gl.viewport(0, 0, w, h);
          }

          // 1. Upload background texture (unit 0)
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, bgTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            w,
            h,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(buf),
          );

          // 2. GPU two-pass separable Gaussian blur of the background.
          // Half-resolution blur (scaleDown=2): ~4× fewer texels, main shader
          // samples with normalized UVs so size is irrelevant. Falls back to
          // the sharp bg if the blur program is unavailable.
          const scaleDown = 2;
          const bw = Math.max(1, Math.floor(w / scaleDown));
          const bh = Math.max(1, Math.floor(h / scaleDown));
          let blurResultTex = bgTexture;
          if (blurProgram && ensureBlurFbos(bw, bh)) {
            // Light, full-resolution Gaussian. The reference "liquid glass" look
            // comes from refraction + gloss over a LIGHTLY blurred background,
            // not heavy frost — so sigma stays small (blur 20 -> sigma ~3.6).
            const sigma = Math.max(0.5, glassSettings.glassBlur * 0.18);
            const radius = Math.min(32, Math.ceil(sigma * 2.5));

            gl.useProgram(blurProgram);
            gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
            gl.enableVertexAttribArray(blurPosAttr);
            gl.vertexAttribPointer(blurPosAttr, 2, gl.FLOAT, false, 0, 0);
            gl.uniform1f(blurSigmaLoc, sigma);
            gl.uniform1i(blurRadiusLoc, radius);
            gl.viewport(0, 0, bw, bh);

            // Pass 1: horizontal, bgTexture -> FBO A
            gl.bindFramebuffer(gl.FRAMEBUFFER, blurFboA);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, bgTexture);
            gl.uniform1i(blurSrcLoc, 0);
            gl.uniform2f(blurDirLoc, 1.0 / bw, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // Pass 2: vertical, FBO A -> FBO B
            gl.bindFramebuffer(gl.FRAMEBUFFER, blurFboB);
            gl.bindTexture(gl.TEXTURE_2D, blurTexA);
            gl.uniform2f(blurDirLoc, 0.0, 1.0 / bh);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            blurResultTex = blurTexB;
          }

          // 3. Main glass pass: bg (unit 0) + blurred bg (unit 1)
          gl.viewport(0, 0, w, h);
          gl.useProgram(glProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
          gl.enableVertexAttribArray(glPosAttr);
          gl.vertexAttribPointer(glPosAttr, 2, gl.FLOAT, false, 0, 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, bgTexture);
          gl.uniform1i(bgTexLocation, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, blurResultTex);
          gl.uniform1i(blurTexLocation, 1);

          const scale = w / 720.0;
          gl.uniform2f(resolutionLocation, w, h);
          gl.uniform2f(centerLocation, 360.0 * scale, 265.0 * scale);
          gl.uniform2f(sizeLocation, 640.0 * scale, 450.0 * scale);
          gl.uniform1f(radiusLocation, glassSettings.cornerRadius * scale);

          // u_refract: maps strength 0~60 to 0~1.5 (default 30 -> 0.75)
          gl.uniform1f(refractLocation, glassSettings.strength / 40.0);
          gl.uniform1f(chromaLocation, glassSettings.chroma); // default 0.28
          gl.uniform1f(edgeHLLocation, glassSettings.edgeHl);
          gl.uniform1f(specLocation, glassSettings.specular);
          gl.uniform1f(fresnelLocation, glassSettings.fresnel);
          gl.uniform1f(distortLocation, glassSettings.distortion);
          gl.uniform1f(alphaLocation, glassSettings.opacity);
          gl.uniform1f(satLocation, glassSettings.saturation);
          gl.uniform1f(zRadiusLocation, glassSettings.zRadius * scale);
          gl.uniform1f(brightnessLocation, glassSettings.brightness);
          gl.uniform1f(shadowAlphaLocation, glassSettings.shadowOpacity);
          gl.uniform1f(
            shadowSpreadLocation,
            glassSettings.shadowSpread * scale,
          );
          gl.uniform1f(shadowOffYLocation, 8.0 * scale); // Drop shadow Y offset
          gl.uniform1f(bevelModeLocation, glassSettings.bevelMode ? 1.0 : 0.0);
          gl.uniform1f(tintStrengthLocation, glassSettings.tintStrength);

          const isDark =
            !document.documentElement.hasAttribute("data-theme") ||
            document.documentElement.getAttribute("data-theme") === "dark";
          // Keep the tint light and only weakly coupled to blur. The old curve
          // (blur*0.008+0.01) pushed the dark tint up to ~0.25 at high blur,
          // which made "more blur = murkier/darker". A gentler, capped curve
          // keeps heavy frost bright and clean/通透.
          const tintOpacity = Math.min(
            0.12,
            Math.max(0.02, glassSettings.glassBlur * 0.003 + 0.02),
          );
          if (isDark) {
            gl.uniform4f(
              tintLocation,
              18 / 255,
              18 / 255,
              24 / 255,
              tintOpacity,
            );
          } else {
            gl.uniform4f(
              tintLocation,
              240 / 255,
              240 / 255,
              245 / 255,
              tintOpacity,
            );
          }

          gl.drawArrays(gl.TRIANGLES, 0, 6);

          if (glassState === "Starting") {
            glassState = "LiquidGlass";
            console.log(
              "[FromZero] Handshake: First frame rendered, transitioning to LiquidGlass state",
            );
            const container = document.getElementById("launcher-container");
            if (container) {
              container.classList.remove("blurred");
              container.classList.add("liquid-glass-active");
            }
            try {
              await invoke("set_blur", { value: 0 });
            } catch (_) {}
          }
        }
      }
    } else if (res.status === 204) {
      lastFrameTime = Date.now();
    }
  } catch (err) {
    console.error("[FromZero] WebGL render/fetch error:", err);
  }

  const targetInterval = Math.round(1000 / activeGlassFps);
  const elapsed = Date.now() - startTime;
  const delay = Math.max(0, targetInterval - elapsed);
  setTimeout(() => {
    if (pumping && myToken === pumpToken) {
      requestAnimationFrame(() => pumpFrames(myToken));
    }
  }, delay);
}

// =============================================
// Initialize application
// =============================================
window.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("[FromZero] Initializing...");
    lastShowTime = Date.now();

    try {
      settings = await invoke("get_settings");
      settings.recent_apps = settings.recent_apps || [];
      settings.web_engines = settings.web_engines || {};
    } catch (e) {
      console.error(
        "[FromZero] Failed to load settings, using empty defaults:",
        e,
      );
      settings = {};
    }

    // Load Liquid Glass parameters from unified settings
    if (settings.glass_settings) {
      glassSettings.glassBlur =
        settings.glass_settings.glass_blur ?? glassSettings.glassBlur;
      glassSettings.borderOpacity =
        settings.glass_settings.border_opacity ?? glassSettings.borderOpacity;
      glassSettings.glassFps =
        settings.glass_settings.glass_fps ?? glassSettings.glassFps;
      glassSettings.strength =
        settings.glass_settings.strength ?? glassSettings.strength;
      glassSettings.chroma =
        settings.glass_settings.chroma ?? glassSettings.chroma;
      glassSettings.frost =
        settings.glass_settings.frost ?? glassSettings.frost;
      glassSettings.beer = settings.glass_settings.beer ?? glassSettings.beer;
      glassSettings.caustic =
        settings.glass_settings.caustic ?? glassSettings.caustic;
      glassSettings.squircleN =
        settings.glass_settings.squircle_n ?? glassSettings.squircleN;
      glassSettings.searchHeight =
        settings.glass_settings.search_height ?? glassSettings.searchHeight;
      glassSettings.searchOffset =
        settings.glass_settings.search_offset ?? glassSettings.searchOffset;
      glassSettings.resultsHeight =
        settings.glass_settings.results_height ?? glassSettings.resultsHeight;

      // Load new Liquid Glass properties
      glassSettings.edgeHl =
        settings.glass_settings.edge_hl ?? glassSettings.edgeHl;
      glassSettings.specular =
        settings.glass_settings.specular ?? glassSettings.specular;
      glassSettings.fresnel =
        settings.glass_settings.fresnel ?? glassSettings.fresnel;
      glassSettings.cornerRadius =
        settings.glass_settings.corner_radius ?? glassSettings.cornerRadius;
      glassSettings.zRadius =
        settings.glass_settings.z_radius ?? glassSettings.zRadius;
      glassSettings.opacity =
        settings.glass_settings.opacity ?? glassSettings.opacity;
      glassSettings.shadowOpacity =
        settings.glass_settings.shadow_opacity ?? glassSettings.shadowOpacity;
      glassSettings.shadowSpread =
        settings.glass_settings.shadow_spread ?? glassSettings.shadowSpread;
      glassSettings.distortion =
        settings.glass_settings.distortion ?? glassSettings.distortion;
      glassSettings.saturation =
        settings.glass_settings.saturation ?? glassSettings.saturation;
      glassSettings.brightness =
        settings.glass_settings.brightness ?? glassSettings.brightness;
      glassSettings.tintStrength =
        settings.glass_settings.tint_strength ?? glassSettings.tintStrength;
      glassSettings.bevelMode =
        settings.glass_settings.bevel_mode ?? glassSettings.bevelMode;
    }
    applyVisualSettings(glassSettings);
    // Set initial DWM Acrylic state based on glassBlur slider
    try {
      await invoke("set_blur", { value: glassSettings.glassBlur });
    } catch (e) {
      console.warn("[FromZero] set_blur init failed:", e);
    }

    applyTheme(settings.theme);
    if (shortcutDisplay)
      shortcutDisplay.textContent = settings.shortcut || "Ctrl+Alt+Space";
    if (themeSelect) themeSelect.value = settings.theme || "dark";
    if (autostartToggle) autostartToggle.checked = settings.autostart || false;

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

    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 正在扫描开始菜单...`;
    try {
      appItems = await invoke("scan_apps");
      if (footerStatus)
        footerStatus.textContent = `${APP_VERSION} · 已成功加载 ${appItems.length} 个应用`;
      console.log(`[FromZero] Loaded ${appItems.length} apps`);
    } catch (scanError) {
      console.error("[FromZero] Scan error:", scanError);
      if (footerStatus)
        footerStatus.textContent = `${APP_VERSION} · 应用扫描失败，请检查日志`;
    }

    if (listen) {
      listen("apps-updated", (event) => {
        const newApps = event.payload;
        console.log(
          `[FromZero] Received background apps update: ${newApps.length} apps`,
        );
        appItems = newApps;
        if (footerStatus)
          footerStatus.textContent = `${APP_VERSION} · 已更新 ${appItems.length} 个应用`;
        renderRecentApps();
        handleSearch();
      }).catch((e) =>
        console.error("[FromZero] Failed to listen to apps-updated event:", e),
      );
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
    if (settingsSave)
      settingsSave.addEventListener("click", saveSettingsConfig);
    if (settingsReset) settingsReset.addEventListener("click", resetToDefaults);

    if (tabBtnGeneral)
      tabBtnGeneral.addEventListener("click", () => switchTab("general"));
    if (tabBtnGlass)
      tabBtnGlass.addEventListener("click", () => switchTab("glass"));
    if (tabBtnLayout)
      tabBtnLayout.addEventListener("click", () => switchTab("layout"));

    if (recordBtn) recordBtn.addEventListener("click", toggleRecordingShortcut);

    // Register visual sliders change events
    initSliderListeners();

    // =============================================
    // Tauri window event listeners
    // =============================================
    listen("icon-ready", (event) => {
      const appPath = event.payload;
      const recentCard = Array.from(
        document.querySelectorAll(".recent-card"),
      ).find((card) => card.getAttribute("data-app-path") === appPath);
      const app = appItems.find((a) => a.path === appPath);
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
          const app = appItems.find((a) => a.path === appPath);
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
    // Glass capture was already started earlier (right after settings load), so
    // it is not kicked off again here — the pumpToken guard would dedupe it
    // anyway, but starting once keeps the path clean.
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 初始化失败，请重试`;
  }
});

function renderRecentApps() {
  if (!recentGrid) return;
  clearChildren(recentGrid);

  // Dynamic row slicing based on left column client height
  const leftCol = document.getElementById("results-left-col");
  let maxApps = 8;
  if (leftCol) {
    const colHeight = leftCol.clientHeight;
    // Threshold is 200px. If clientHeight is less than 200px, limit icons to 1 row (4 apps).
    // Otherwise show 2 rows (8 apps). Always show at least 1 row (4 apps) as the minimum limit.
    if (colHeight > 0 && colHeight < 200) {
      maxApps = 4;
    }
  }

  const recentApps = (settings.recent_apps || [])
    .map((path) => appItems.find((app) => app.path === path))
    .filter(Boolean)
    .slice(0, maxApps);
  const displayApps =
    recentApps.length > 0 ? recentApps : appItems.slice(0, maxApps);
  if (displayApps.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "recent-empty";
    emptyDiv.textContent = "无可用应用";
    recentGrid.appendChild(emptyDiv);
    return;
  }
  displayApps.forEach((app) => {
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
    card.addEventListener("click", () =>
      executeItemAction({ type: "app", data: app }),
    );
    recentGrid.appendChild(card);
  });
}

function createIconElement(iconPath, cssClass) {
  if (
    !iconPath ||
    /^[\u{2190}-\u{21FF}\u{1F300}-\u{1FAF8}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚡📂🌐📁🖼️📝💻📦📄🎵🎬]/u.test(
      iconPath,
    )
  ) {
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
    if (element.hasAttribute("data-app-path"))
      fallback.setAttribute(
        "data-app-path",
        element.getAttribute("data-app-path"),
      );
    if (element.hasAttribute("data-icon-path"))
      fallback.setAttribute(
        "data-icon-path",
        element.getAttribute("data-icon-path"),
      );
    if (element.parentElement)
      element.parentElement.replaceChild(fallback, element);
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
  if (resultsList) resultsList.style.display = "flex";
  if (query.startsWith(">")) {
    if (searchIndicator) searchIndicator.textContent = "⚡";
    const subQuery = query.slice(1).trim().toLowerCase();
    filteredItems = SYSTEM_COMMANDS.filter(
      (cmd) =>
        cmd.key.includes(subQuery) || cmd.name.toLowerCase().includes(subQuery),
    ).map((cmd) => ({
      type: "sys",
      title: cmd.name,
      subtitle: cmd.desc,
      icon: "⚡",
      badge: cmd.badge,
      data: cmd.key,
    }));
    renderResults();
    // File search mode: "f keyword" or "find keyword"
  } else if (/^(?:f|find)\s+/i.test(query)) {
    const fileSearchMatch = query.match(/^(?:f|find)\s+(.+)$/i);
    if (fileSearchMatch) {
      const fileQuery = fileSearchMatch[1].trim();
      if (searchIndicator) searchIndicator.textContent = "🔍";
      try {
        const files = await invoke("search_files", {
          query: fileQuery,
          isInline: false,
        });
        if (currentSearchId !== lastSearchId) return;
        filteredItems = files.slice(0, 20).map((f) => ({
          type: f.is_dir ? "dir" : "file",
          title: f.name,
          subtitle: f.path,
          icon: getFileIcon(f),
          badge: f.is_dir ? "文件夹" : f.extension.toUpperCase() || "文件",
          data: f,
        }));
      } catch (e) {
        console.error("[FromZero] File search error:", e);
        filteredItems = [];
      }
      renderResults();
      if (filteredItems.length > 0) triggerPreview(filteredItems[0]);
      else hidePreview();
      return;
    } else {
      // Prefix present but no keyword yet (e.g. "f "): clear stale results
      // instead of leaving the previous query's list on screen.
      if (searchIndicator) searchIndicator.textContent = "🔍";
      filteredItems = [];
      renderResults();
      hidePreview();
      return;
    }
  } else if (
    query.startsWith("\\\\") ||
    query.startsWith("//") ||
    /^[a-zA-Z]:[\\\/]/.test(query) ||
    /^[a-zA-Z]:$/.test(query)
  ) {
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
      const files = await invoke("list_directory", {
        path: parentDir,
        searchTerm: searchInDir,
      });
      if (currentSearchId !== lastSearchId) return;
      currentDirPath = parentDir;
      filteredItems = files.map((f) => ({
        type: f.is_dir ? "dir" : "file",
        title: f.name === ".." ? ".. (返回上级目录)" : f.name,
        subtitle: f.path,
        icon: getFileIcon(f),
        badge: f.is_dir
          ? f.name === ".."
            ? "返回"
            : "文件夹"
          : f.extension
            ? f.extension.toUpperCase()
            : "文件",
        data: f,
      }));
    } catch (e) {
      console.error("[FromZero] Directory listing error:", e);
      filteredItems = [
        {
          type: "folder",
          title: `打开文件夹: "${dirPath}"`,
          subtitle: e.toString(),
          icon: "📂",
          badge: "错误",
          data: dirPath,
        },
      ];
    }
    renderResults();
    if (
      filteredItems.length > 0 &&
      (filteredItems[0].type === "file" || filteredItems[0].type === "dir")
    ) {
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
      filteredItems = [
        {
          type: "web",
          title: `在 ${engineName} 搜索: "${searchWord}"`,
          subtitle: targetUrl,
          icon: "🌐",
          badge: "网页",
          data: targetUrl,
        },
      ];
      renderResults();
    } else {
      if (searchIndicator) searchIndicator.textContent = "🔍";
      try {
        const [appResults, fileResults] = await Promise.all([
          invoke("search_apps", { query }),
          invoke("search_files", { query, isInline: true }).catch((err) => {
            console.warn("[FromZero] Inline file search error:", err);
            return [];
          }),
        ]);
        if (currentSearchId !== lastSearchId) return;

        // Map apps
        const appItemsList = appResults.slice(0, 7).map((app) => ({
          type: "app",
          title: app.name,
          subtitle: app.target,
          icon: app.icon_path,
          badge: "应用",
          data: app,
        }));

        // Map files
        const fileItemsList = fileResults.slice(0, 15).map((f) => ({
          type: f.is_dir ? "dir" : "file",
          title: f.name,
          subtitle: f.path,
          icon: getFileIcon(f),
          badge: f.is_dir
            ? f.name === ".."
              ? "返回"
              : "文件夹"
            : f.extension
              ? f.extension.toUpperCase()
              : "文件",
          data: f,
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
            data: defaultBaidu,
          });
        }
      } catch (e) {
        console.error("[FromZero] Search error:", e);
        if (currentSearchId === lastSearchId) filteredItems = [];
      }
      renderResults();

      if (
        filteredItems.length > 0 &&
        (filteredItems[0].type === "file" || filteredItems[0].type === "dir")
      ) {
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
  lastRenderedSelectedIndex = -1;
  if (filteredItems.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "results-empty";
    emptyDiv.textContent = "无搜索匹配项";
    resultsList.appendChild(emptyDiv);
    return;
  }
  // Batch DOM inserts to avoid repeated reflows while building the list
  const fragment = document.createDocumentFragment();
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
    fragment.appendChild(el);
  });
  resultsList.appendChild(fragment);
  lastRenderedSelectedIndex = selectedIndex;
  const selectedEl = resultsList.children[selectedIndex];
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

/** Tracks last selected DOM index to avoid O(n) classList thrash on hover */
let lastRenderedSelectedIndex = -1;

function updateSelectionVisual() {
  if (!resultsList) return;
  const items = resultsList.children;
  const prev = lastRenderedSelectedIndex;
  const next = selectedIndex;

  if (
    prev !== next &&
    prev >= 0 &&
    prev < items.length &&
    items[prev].classList &&
    items[prev].classList.contains("result-item")
  ) {
    items[prev].classList.remove("selected");
  }

  if (
    next >= 0 &&
    next < items.length &&
    items[next].classList &&
    items[next].classList.contains("result-item")
  ) {
    items[next].classList.add("selected");
    items[next].scrollIntoView({ block: "nearest" });
  }
  lastRenderedSelectedIndex = next;

  if (
    filteredItems[selectedIndex] &&
    (filteredItems[selectedIndex].type === "file" ||
      filteredItems[selectedIndex].type === "dir")
  ) {
    triggerPreview(filteredItems[selectedIndex]);
  } else {
    hidePreview();
  }
}

async function executeItemAction(item) {
  try {
    if (item.type === "app") {
      const app = item.data;
      await invoke("launch_app", { path: app.path });
      try {
        const updatedSettings = await invoke("bump_recent_app", {
          path: app.path,
        });
        settings = { ...settings, ...updatedSettings };
        renderRecentApps();
      } catch (bumpError) {
        console.error(
          "[FromZero] Failed thread-safe recent app bump:",
          bumpError,
        );
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
      const newPath = item.data.path.endsWith("\\")
        ? item.data.path
        : item.data.path + "\\";
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
    if (footerStatus)
      footerStatus.textContent = `${APP_VERSION} · 执行失败: ${error}`;
  }
}

async function handleGlobalKeys(e) {
  if (isComposing || e.isComposing) {
    return;
  }
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
  } else if (
    e.key === "Backspace" &&
    currentDirPath &&
    searchInput &&
    searchInput.value === currentDirPath
  ) {
    // Go up one directory level
    e.preventDefault();
    const parentPath = currentDirPath.replace(/\\[^\\]+\\$/, "\\");
    if (parentPath !== currentDirPath && parentPath.length >= 3) {
      searchInput.value = parentPath;
      handleSearch();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchDebounceTimeout) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
    }
    if (
      e.shiftKey &&
      filteredItems[selectedIndex] &&
      (filteredItems[selectedIndex].type === "file" ||
        filteredItems[selectedIndex].type === "dir")
    ) {
      // Open parent directory in Explorer
      const filePath = filteredItems[selectedIndex].data.path;
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
  const tabs = [
    { name: "general", btn: tabBtnGeneral, panel: panelGeneral },
    { name: "glass", btn: tabBtnGlass, panel: panelGlass },
    { name: "layout", btn: tabBtnLayout, panel: panelLayout },
  ];

  tabs.forEach((t) => {
    if (t.name === tab) {
      if (t.btn) t.btn.classList.add("active");
      if (t.panel) t.panel.classList.add("active");
    } else {
      if (t.btn) t.btn.classList.remove("active");
      if (t.panel) t.panel.classList.remove("active");
    }
  });
}

function openSettings() {
  switchTab("general");
  if (settingsOverlay) settingsOverlay.classList.add("active");
  if (themeSelect) themeSelect.value = settings.theme || "dark";
  currentShortcut = settings.shortcut || "Ctrl+Alt+Space";
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

function resetToDefaults() {
  currentShortcut = "Ctrl+Alt+Space";
  if (shortcutDisplay) shortcutDisplay.textContent = currentShortcut;
  if (themeSelect) themeSelect.value = "dark";
  if (autostartToggle) autostartToggle.checked = false;

  const defaults = {
    glassBlur: 20,
    glassFps: 60,
    strength: 28,
    edgeHl: 0.05,
    specular: 0.5,
    fresnel: 1.0,
    cornerRadius: 30.0,
    zRadius: 100.0,
    opacity: 1.0,
    shadowOpacity: 0.0,
    shadowSpread: 0.0,
    distortion: 0.0,
    saturation: 0.0,
    brightness: -0.2,
    tintStrength: 0.2,
    bevelMode: false,

    // Layout defaults
    squircleN: 4.5,
    searchHeight: 46,
    searchOffset: 10,
    resultsHeight: 280,

    // Maintain deprecated fields
    borderOpacity: 0.6,
    chroma: 0.05,
    frost: 3.0,
    beer: 15,
    caustic: 0.6,
  };

  syncSlidersToConfig(defaults);
  applyVisualSettings(defaults);
  invoke("set_blur", { value: defaults.glassBlur }).catch((e) =>
    console.warn(e),
  );
}

async function saveSettingsConfig() {
  const nextSettings = JSON.parse(JSON.stringify(settings));
  if (themeSelect) nextSettings.theme = themeSelect.value;
  nextSettings.shortcut = currentShortcut;
  if (autostartToggle) nextSettings.autostart = autostartToggle.checked;

  const nextGlassSettings = readSlidersState();
  nextSettings.glass_settings = {
    glass_blur: nextGlassSettings.glassBlur,
    glass_fps: nextGlassSettings.glassFps,
    strength: nextGlassSettings.strength,
    edge_hl: nextGlassSettings.edgeHl,
    specular: nextGlassSettings.specular,
    fresnel: nextGlassSettings.fresnel,
    corner_radius: nextGlassSettings.cornerRadius,
    z_radius: nextGlassSettings.zRadius,
    opacity: nextGlassSettings.opacity,
    shadow_opacity: nextGlassSettings.shadowOpacity,
    shadow_spread: nextGlassSettings.shadowSpread,
    squircle_n: nextGlassSettings.squircleN,
    search_height: nextGlassSettings.searchHeight,
    search_offset: nextGlassSettings.searchOffset,
    results_height: nextGlassSettings.resultsHeight,

    // New Liquid Glass properties
    distortion: nextGlassSettings.distortion,
    saturation: nextGlassSettings.saturation,
    brightness: nextGlassSettings.brightness,
    tint_strength: nextGlassSettings.tintStrength,
    bevel_mode: nextGlassSettings.bevelMode,

    // Maintain deprecated fields for backward compatibility
    border_opacity: nextGlassSettings.borderOpacity,
    chroma: nextGlassSettings.chroma,
    frost: nextGlassSettings.frost,
    beer: nextGlassSettings.beer,
    caustic: nextGlassSettings.caustic,
  };

  try {
    await invoke("update_settings", { settings: nextSettings });
    // Success: commit to global variables
    settings = nextSettings;
    glassSettings = nextGlassSettings;
    applyTheme(settings.theme);
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
    currentShortcut = settings.shortcut || "Ctrl+Alt+Space";
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

// =============================================
// File Explorer: Helper Functions & Preview
// =============================================

/** Invalidate in-flight preview IPC when selection races */
let previewRequestId = 0;
/** Small LRU-ish cache: path -> FilePreview (metadata + text only, no media bytes) */
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 48;
/** Skip re-fetch if same path is already showing */
let activePreviewPath = null;

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

function getFileIcon(item) {
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
  pdf(el, item, preview) {
    if (preview.content !== "asset") {
      appendPreviewEmpty(el, "PDF 过大，无法预览");
      return;
    }
    const src = assetSrcForPath(item.data.path);
    if (!src) return appendPreviewEmpty(el, "PDF 路径无效");
    const iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.title = item.data.name || "PDF";
    iframe.className = "preview-pdf";
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    el.appendChild(iframe);
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
  renderer(previewContent, item, preview);
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
    if (
      !filteredItems[selectedIndex] ||
      !filteredItems[selectedIndex].data ||
      filteredItems[selectedIndex].data.path !== requestedPath
    ) {
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

function hidePreview() {
  clearTimeout(previewDebounceTimeout);
  previewRequestId++; // cancel in-flight showPreview
  activePreviewPath = null;
  const previewPanel = document.getElementById("preview-panel");
  if (previewPanel) previewPanel.classList.remove("active");
  const previewContent = document.getElementById("preview-content");
  if (previewContent) clearChildren(previewContent);
}

function triggerPreview(item) {
  clearTimeout(previewDebounceTimeout);
  // 80ms: enough to coalesce rapid hover without feeling laggy
  previewDebounceTimeout = setTimeout(() => {
    showPreview(item);
  }, 80);
}
