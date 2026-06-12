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

// Global error diagnostics forwarded to the Rust backend console
window.onerror = function(message, source, lineno, colno, error) {
  const msg = `[Global JS Error] ${message} at ${source}:${lineno}:${colno}`;
  console.error(msg);
  invoke("debug_log", { msg: msg }).catch(() => {});
  return false;
};
window.addEventListener("unhandledrejection", function(event) {
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
  glassBlur: 8,
  borderOpacity: 0.60,
  glassFps: 60,
  strength: 30,
  chroma: 0.045,
  frost: 3.0,
  beer: 15,
  caustic: 0.6,
  squircleN: 4.5,
  searchHeight: 46,
  searchOffset: 10
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
let activeGlassFps = 60;
let peekTimer = null;

// WebGL state
let gl = null;
let glProgram = null;
let textureImage = null;
let webglInitialized = false;
let lastRenderedSeq = 0;

// Mouse tracking for dynamic spotlight & metaballs
let currentMouseX = 320;
let currentMouseY = 225;
document.addEventListener("mousemove", (e) => {
  currentMouseX = e.clientX;
  currentMouseY = e.clientY;
});

// Uniform locations
let resolutionLocation = null;
let centerLocation = null;
let halfSizeLocation = null;
let cornerLocation = null;
let bandLocation = null;
let strengthLocation = null;
let magnifyLocation = null;
let chromaLocation = null;
let imageLocation = null;
let squircleNLocation = null;
let specularLocation = null;
let frostLocation = null;
let beerThicknessLocation = null;
let causticStrengthLocation = null;
let mouseLocation = null;
let dprLocation = null;
let tintLocation = null;
let thicknessLocation = null;
let domeHeightLocation = null;
let iorLocation = null;
let bgDistLocation = null;

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

const APP_VERSION = "v0.2.3preview";

// =============================================
// Window Focus/Blur Management & State Machine
// =============================================

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (pumping && (glassState === "LiquidGlass" || glassState === "Starting")) {
      const inactiveTime = Date.now() - lastFrameTime;
      if (inactiveTime > 1500) {
        console.warn(`[FromZero] Watchdog: No new frames for ${inactiveTime}ms. Restarting background capture session...`);
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
    pumpFrames();
    startWatchdog();
  } catch (e) {
    console.warn("[FromZero] Live glass capture unavailable, fallback to Acrylic:", e);
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

  activeGlassFps = config.glassFps || 60;
  glassSettings.glassBlur = config.glassBlur;
  glassSettings.borderOpacity = config.borderOpacity;
  glassSettings.glassFps = config.glassFps;
  glassSettings.strength = config.strength ?? glassSettings.strength;
  glassSettings.chroma = config.chroma ?? glassSettings.chroma;
  glassSettings.frost = config.frost ?? glassSettings.frost;
  glassSettings.beer = config.beer ?? glassSettings.beer;
  glassSettings.caustic = config.caustic ?? glassSettings.caustic;
  glassSettings.squircleN = config.squircleN ?? glassSettings.squircleN;
  glassSettings.searchHeight = config.searchHeight ?? glassSettings.searchHeight ?? 46;
  glassSettings.searchOffset = config.searchOffset ?? glassSettings.searchOffset ?? 10;

  container.style.setProperty("--search-height", `${glassSettings.searchHeight}px`);
  container.style.setProperty("--search-offset", `${glassSettings.searchOffset}px`);

  const b1 = (config.borderOpacity * 0.7).toFixed(3);
  const b2 = (config.borderOpacity * 0.5).toFixed(3);
  container.style.setProperty("--border1-opacity", b1);
  container.style.setProperty("--border2-opacity", b2);

  // Set canvas blur CSS custom property directly (full range up to 30px)
  container.style.setProperty("--canvas-blur", `${config.glassBlur}px`);

  const glassBlurLayer = document.querySelector('.glass-blur-layer');
  if (glassBlurLayer) {
    const isDark = !document.documentElement.hasAttribute('data-theme') ||
                   document.documentElement.getAttribute('data-theme') === 'dark';
    const tintOpacity = Math.max(0.01, config.glassBlur * 0.008 + 0.01).toFixed(3);
    if (isDark) {
      glassBlurLayer.style.backgroundColor = `rgba(18, 18, 24, ${tintOpacity})`;
    } else {
      glassBlurLayer.style.backgroundColor = `rgba(240, 240, 245, ${tintOpacity})`;
    }
  }

  // Toggle DWM Acrylic: only when not in LiquidGlass or Starting state
  if (glassState === "Acrylic" || glassState === "Stopping") {
    clearTimeout(setBlurTimeout);
    setBlurTimeout = setTimeout(() => {
      try { invoke("set_blur", { value: config.glassBlur }); } catch (e) {}
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
    { id: "slider-glass-blur", valId: "val-glass-blur", key: "glassBlur", isFloat: false },
    { id: "slider-border-opacity", valId: "val-border-opacity", key: "borderOpacity", isFloat: true, isBorder: true },
    { id: "slider-strength", valId: "val-strength", key: "strength", isFloat: false },
    { id: "slider-chroma", valId: "val-chroma", key: "chroma", isFloat: true, isDispersion: true },
    { id: "slider-frost", valId: "val-frost", key: "frost", isFloat: true },
    { id: "slider-beer", valId: "val-beer", key: "beer", isFloat: false },
    { id: "slider-caustic", valId: "val-caustic", key: "caustic", isFloat: true },
    { id: "slider-squircle-n", valId: "val-squircle-n", key: "squircleN", isFloat: true },
    { id: "slider-search-height", valId: "val-search-height", key: "searchHeight", isFloat: false },
    { id: "slider-search-offset", valId: "val-search-offset", key: "searchOffset", isFloat: false }
  ];

  sliders.forEach(s => {
    const el = document.getElementById(s.id);
    const valEl = document.getElementById(s.valId);
    if (el) {
      el.addEventListener("input", () => {
        const val = s.isFloat ? parseFloat(el.value) : parseInt(el.value);
        if (valEl) {
          if (s.isDispersion) {
            valEl.textContent = val.toFixed(3);
          } else if (s.isBorder) {
            valEl.textContent = val.toFixed(2);
          } else if (s.isFloat) {
            valEl.textContent = val.toFixed(1);
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
}

// Helper: Read sliders values
function readSlidersState() {
  return {
    glassBlur: parseInt(document.getElementById("slider-glass-blur").value),
    borderOpacity: parseFloat(document.getElementById("slider-border-opacity").value),
    glassFps: parseInt(document.getElementById("slider-glass-fps").value),
    strength: parseInt(document.getElementById("slider-strength").value),
    chroma: parseFloat(document.getElementById("slider-chroma").value),
    frost: parseFloat(document.getElementById("slider-frost").value),
    beer: parseInt(document.getElementById("slider-beer").value),
    caustic: parseFloat(document.getElementById("slider-caustic").value),
    squircleN: parseFloat(document.getElementById("slider-squircle-n").value),
    searchHeight: parseInt(document.getElementById("slider-search-height").value),
    searchOffset: parseInt(document.getElementById("slider-search-offset").value)
  };
}

// Helper: Sync sliders elements to configurations
function syncSlidersToConfig(config) {
  const mappings = [
    { id: "slider-glass-blur", valId: "val-glass-blur", val: config.glassBlur, isFloat: false },
    { id: "slider-border-opacity", valId: "val-border-opacity", val: config.borderOpacity, isFloat: true, isBorder: true },
    { id: "slider-glass-fps", valId: "val-glass-fps", val: config.glassFps, isFloat: false },
    { id: "slider-strength", valId: "val-strength", val: config.strength, isFloat: false },
    { id: "slider-chroma", valId: "val-chroma", val: config.chroma, isFloat: true, isDispersion: true },
    { id: "slider-frost", valId: "val-frost", val: config.frost, isFloat: true },
    { id: "slider-beer", valId: "val-beer", val: config.beer, isFloat: false },
    { id: "slider-caustic", valId: "val-caustic", val: config.caustic, isFloat: true },
    { id: "slider-squircle-n", valId: "val-squircle-n", val: config.squircleN, isFloat: true },
    { id: "slider-search-height", valId: "val-search-height", val: config.searchHeight ?? 46, isFloat: false },
    { id: "slider-search-offset", valId: "val-search-offset", val: config.searchOffset ?? 10, isFloat: false }
  ];

  mappings.forEach(m => {
    const el = document.getElementById(m.id);
    const valEl = document.getElementById(m.valId);
    if (el) {
      el.value = m.val;
      if (valEl) {
        if (m.isDispersion) {
          valEl.textContent = m.val.toFixed(3);
        } else if (m.isBorder) {
          valEl.textContent = m.val.toFixed(2);
        } else if (m.isFloat) {
          valEl.textContent = m.val.toFixed(1);
        } else {
          valEl.textContent = m.val;
        }
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
const CORNER = 24.0;

function compileShader(gl, source, type) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const msg = "[FromZero] Shader compile error (" + (type === gl.VERTEX_SHADER ? "VERTEX" : "FRAGMENT") + "):\n" + log;
    console.error(msg);
    invoke("debug_log", { msg: msg }).catch(() => {});
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebGL(canvas) {
  try {
    gl = canvas.getContext("webgl2", { alpha: true, depth: false, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) {
      const msg = "[FromZero] WebGL2 context not supported, falling back to WebGL1 (Premium shader disabled)";
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

      uniform sampler2D u_image;
      uniform vec2 u_resolution;
      uniform vec2 u_center;
      uniform vec2 u_halfSize;
      uniform float u_corner;
      uniform float u_band;
      uniform float u_strength;
      uniform float u_magnify;
      uniform float u_chroma;
      uniform vec2 u_mouse;
      uniform float u_specularStrength;
      uniform float u_frost;
      uniform float u_beerThickness;
      uniform float u_causticStrength;
      uniform float u_squircleN;
      uniform float u_dpr;
      uniform vec4 u_tint;

      // New Height Field & Snell Refraction uniforms
      uniform float u_thickness;
      uniform float u_domeHeight;
      uniform float u_ior;
      uniform float u_bgDist;

      // Color conversion formulas: sRGB <-> LCh (via XYZ and Lab)
      vec3 srgb2rgb(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
      }
      vec3 rgb2srgb(vec3 c) {
        return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      vec3 rgb2xyz(vec3 c) {
        mat3 m = mat3(
          0.4124, 0.2126, 0.0193,
          0.3576, 0.7152, 0.1192,
          0.1805, 0.0722, 0.9505
        );
        return c * m;
      }
      vec3 xyz2rgb(vec3 c) {
        mat3 m = mat3(
          3.2406, -0.9689, 0.0557,
          -1.5372, 1.8758, -0.2040,
          -0.4986, 0.0415, 1.0570
        );
        return c * m;
      }
      float xyz_f(float t) {
        return mix(7.787 * t + 16.0 / 116.0, pow(t, 1.0 / 3.0), step(0.008856, t));
      }
      vec3 xyz2lab(vec3 c) {
        vec3 white = vec3(0.950456, 1.0, 1.088754);
        vec3 cn = c / white;
        vec3 f = vec3(xyz_f(cn.x), xyz_f(cn.y), xyz_f(cn.z));
        return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
      }
      float lab_f_inv(float t) {
        return mix(0.1284 * (t - 16.0 / 116.0), t * t * t, step(0.206897, t));
      }
      vec3 lab2xyz(vec3 c) {
        vec3 white = vec3(0.950456, 1.0, 1.088754);
        float p = (c.x + 16.0) / 116.0;
        return white * vec3(lab_f_inv(p + c.y / 500.0), lab_f_inv(p), lab_f_inv(p - c.z / 200.0));
      }
      vec3 lab2lch(vec3 c) {
        float l = c.x;
        float c_val = length(c.yz);
        float h = atan(c.z, c.y) * 57.2957795;
        if (h < 0.0) h += 360.0;
        return vec3(l, c_val, h);
      }
      vec3 lch2lab(vec3 c) {
        float h_rad = c.z * 0.01745329;
        return vec3(c.x, c.y * cos(h_rad), c.y * sin(h_rad));
      }
      vec3 srgb2lch(vec3 c) {
        return lab2lch(xyz2lab(rgb2xyz(srgb2rgb(c))));
      }
      vec3 lch2srgb(vec3 c) {
        return rgb2srgb(xyz2rgb(lab2xyz(lch2lab(c))));
      }

      // SDF functions
      float superellipseCornerSDF(vec2 p, float r, float n) {
        p = abs(p);
        return pow(pow(max(p.x, 0.0), n) + pow(max(p.y, 0.0), n), 1.0 / n) - r;
      }

      float roundedRectSDF(vec2 p, vec2 center, vec2 size, float cornerRadius, float n) {
        p -= center;
        vec2 extents = size * 0.5 - vec2(cornerRadius);
        vec2 q = abs(p) - extents;
        if (q.x > 0.0 && q.y > 0.0) {
          return superellipseCornerSDF(q, cornerRadius, n);
        }
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - cornerRadius;
      }

      // Combined Scene SDF function (centered round-rect)
      float getSDF(vec2 p) {
        vec2 cardSize = (u_halfSize + vec2(u_corner)) * 2.0;
        return roundedRectSDF(p, vec2(0.0), cardSize, u_corner, u_squircleN);
      }

      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }

      // 6-Channel Chromatic Dispersion sampling to create premium realistic rainbow refractions
      vec3 sample6ChannelDispersion(sampler2D tex, vec2 baseUV, vec2 normal, float strength, float chroma) {
        float r_ior = 1.0 + chroma * 1.5;
        float y_ior = 1.0 + chroma * 0.9;
        float g_ior = 1.0 + chroma * 0.3;
        float c_ior = 1.0 - chroma * 0.3;
        float b_ior = 1.0 - chroma * 0.9;
        float v_ior = 1.0 - chroma * 1.5;
        
        vec2 offR = normal * strength * r_ior;
        vec2 offY = normal * strength * y_ior;
        vec2 offG = normal * strength * g_ior;
        vec2 offC = normal * strength * c_ior;
        vec2 offB = normal * strength * b_ior;
        vec2 offV = normal * strength * v_ior;
        
        vec3 cRed    = texture(tex, clamp(baseUV + offR, 0.001, 0.999)).rgb;
        vec3 cYellow = texture(tex, clamp(baseUV + offY, 0.001, 0.999)).rgb;
        vec3 cGreen  = texture(tex, clamp(baseUV + offG, 0.001, 0.999)).rgb;
        vec3 cCyan   = texture(tex, clamp(baseUV + offC, 0.001, 0.999)).rgb;
        vec3 cBlue   = texture(tex, clamp(baseUV + offB, 0.001, 0.999)).rgb;
        vec3 cViolet = texture(tex, clamp(baseUV + offV, 0.001, 0.999)).rgb;
        
        // Convert colors to 6-channel coordinates
        float r = cRed.r * 0.5;
        float g = cGreen.g * 0.5;
        float b = cBlue.b * 0.5;
        float y = (2.0 * cYellow.r + 2.0 * cYellow.g - cYellow.b) / 6.0;
        float c = (2.0 * cCyan.g + 2.0 * cCyan.b - cCyan.r) / 6.0;
        float v = (2.0 * cViolet.b + 2.0 * cViolet.r - cViolet.g) / 6.0;
        
        // Reconstruct back to RGB
        vec3 rgb;
        rgb.r = r + (2.0 * v + 2.0 * y - c) / 3.0;
        rgb.g = g + (2.0 * y + 2.0 * c - v) / 3.0;
        rgb.b = b + (2.0 * c + 2.0 * v - y) / 3.0;
        return rgb;
      }

      // Neutral clear glass absorption (absorbs all channels equally to prevent greenish/blueish tint)
      vec3 applyBeerAbsorption(vec3 color, float t, float thickness) {
        vec3 absorptionCoeff = vec3(0.012, 0.012, 0.012);
        // More absorption at edge (when t is small) and less in the center (when t is large)
        float pathLength = (1.0 - t * 0.5) * thickness;
        vec3 transmission = exp(-absorptionCoeff * pathLength);
        return color * transmission;
      }

      // Height field: circular edge bevel + parabolic central dome
      float heightField(vec2 p) {
        float d = -getSDF(p); // d is positive inside
        if (d <= 0.0) return 0.0;
        
        // 1) bevel: edge bevel profile from 0 to 1
        float x = clamp(d / u_band, 0.0, 1.0);
        float bevel = sqrt(max(1.0 - (1.0 - x) * (1.0 - x), 0.0));
        
        // 2) dome: parabolic curvature
        vec2 q = p / (u_halfSize + vec2(u_corner));
        float dome = max(1.0 - dot(q, q), 0.0);
        
        return u_thickness * bevel + u_domeHeight * dome;
      }

      void main() {
        vec2 px = v_texCoord * u_resolution;
        vec2 p = px - u_center;
        
        float dC = -getSDF(p);
        float zR = u_band;
        
        // Calculate normal vector via height gradient finite differences
        float e = 1.5;
        float dR = -getSDF(p + vec2(e, 0.0));
        float dL = -getSDF(p - vec2(e, 0.0));
        float dU = -getSDF(p + vec2(0.0, e));
        float dD = -getSDF(p - vec2(0.0, e));
        
        float hC = heightField(p);
        float hR = heightField(p + vec2(e, 0.0));
        float hL = heightField(p - vec2(e, 0.0));
        float hU = heightField(p + vec2(0.0, e));
        float hD = heightField(p - vec2(0.0, e));
        
        vec2 hGrad = vec2(hR - hL, hU - hD) / (2.0 * e);
        vec3 N = normalize(vec3(-hGrad, 1.0));
        
        // Snell Refraction
        vec3 I = vec3(0.0, 0.0, -1.0); // incident vector
        
        // 1. Refract entering the front glass surface
        vec3 R1 = refract(I, N, 1.0 / u_ior);
        if (length(R1) < 0.0001) R1 = refract(I, N, 1.0 / 1.5); // fallback
        
        // Offset inside the glass medium
        vec2 offset1 = R1.xy / max(-R1.z, 0.0001) * hC;
        
        // 2. Refract exiting the flat back glass surface
        vec3 R2 = refract(R1, vec3(0.0, 0.0, 1.0), u_ior);
        if (length(R2) < 0.0001) R2 = R1; // fallback
        
        // Offset in the air gap from glass to background
        vec2 offset2 = R2.xy / max(-R2.z, 0.0001) * u_bgDist;
        
        vec2 refrPx = offset1 + offset2;
        vec2 refrUV = refrPx / u_resolution;

        // Frosting noise offset
        float angle = random(v_texCoord) * 6.283185;
        float dist = sqrt(random(v_texCoord + 0.5)) * u_frost * 4.0;
        vec2 noise_off = vec2(cos(angle), sin(angle)) / u_resolution * dist;
        
        vec2 baseUV = v_texCoord + refrUV + noise_off;
        
        // Chromatic dispersion
        vec2 normal2D = length(N.xy) > 0.0001 ? normalize(N.xy) : vec2(0.0);
        vec3 glassColor = sample6ChannelDispersion(u_image, baseUV, normal2D, length(refrUV) * 0.8, u_chroma);
        
        // Apply colorless transparent Beer's absorption
        float t = clamp(dC / zR, 0.0, 1.0);
        glassColor = applyBeerAbsorption(glassColor, t, u_beerThickness);
        
        // Apply theme tint
        glassColor = mix(glassColor, u_tint.rgb, u_tint.a);
        
        // LCh color space correction: boost L and C near edges to prevent gloomy gray zones
        vec3 glassLCh = srgb2lch(glassColor);
        float edgeVal = 1.0 - t; // 0.0 at center, 1.0 at edge
        glassLCh.x += 18.0 * edgeVal * u_specularStrength;
        glassLCh.y += 10.0 * edgeVal * u_specularStrength;
        glassLCh.x = clamp(glassLCh.x, 0.0, 100.0);
        glassColor = lch2srgb(glassLCh);
        
        // Specular & Caustics setup
        vec3 viewDir = vec3(0.0, 0.0, 1.0);
        
        // Static overhead lighting
        vec3 light1Dir = normalize(vec3(-0.3, 0.6, 1.0));
        vec3 half1Dir = normalize(light1Dir + viewDir);
        float NdotH1 = max(dot(N, half1Dir), 0.0);
        float spec1 = pow(NdotH1, 75.0) * 1.5;
        
        // Soft overhead ambient light
        vec3 light2Dir = normalize(vec3(0.4, 0.7, 1.0));
        vec3 half2Dir = normalize(light2Dir + viewDir);
        float NdotH2 = max(dot(N, half2Dir), 0.0);
        float spec2 = pow(NdotH2, 40.0) * 0.3;
        
        vec3 specularColor = vec3(1.0) * (spec1 * 1.2 + spec2) * u_specularStrength * edgeVal;
        
        // Fresnel Sheen (Schlick's approximation)
        float cosTheta = max(dot(N, viewDir), 0.0);
        float fresnel = pow(1.0 - cosTheta, 4.0) * 0.38 * edgeVal;
        vec3 sheenColor = vec3(1.0) * fresnel;
        
        // Dynamic Caustics
        float bandShape = pow(edgeVal * (1.0 - edgeVal * 0.5), 0.65);
        float rawAlignment = dot(light1Dir.xy, -normal2D);
        float focusAlignment = max(rawAlignment, 0.0);
        float caustics = bandShape * focusAlignment * u_causticStrength * 1.8;
        
        // Rainbow caustics
        vec3 causticsColor = vec3(0.85, 1.0, 0.95) * caustics;
        causticsColor.r *= 1.0 + 0.15 * rawAlignment;
        causticsColor.b *= 1.0 - 0.15 * rawAlignment;
        
        // Top-Left Inner Bevel Stroke
        float borderWidth = 1.8 * u_dpr;
        float innerStroke = smoothstep(-borderWidth - 1.0, -borderWidth, -dC) * (1.0 - smoothstep(-1.0, 0.0, -dC));
        float topBias = max(dot(normal2D, normalize(vec2(-0.5, 0.85))), 0.0);
        vec3 strokeColor = vec3(1.0) * innerStroke * topBias * 0.65;
        
        // Final pixel composite
        vec3 finalColor = glassColor + specularColor + sheenColor + causticsColor + strokeColor;
        
        // Smooth shape edge anti-aliasing with transparent background
        float edgeAlpha = 1.0 - smoothstep(-1.5, 0.0, -dC);
        fragColor = vec4(finalColor, edgeAlpha);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]), gl.STATIC_DRAW);

    const posAttr = gl.getAttribLocation(glProgram, "a_position");
    gl.enableVertexAttribArray(posAttr);
    gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

    imageLocation = gl.getUniformLocation(glProgram, "u_image");
    resolutionLocation = gl.getUniformLocation(glProgram, "u_resolution");
    centerLocation = gl.getUniformLocation(glProgram, "u_center");
    halfSizeLocation = gl.getUniformLocation(glProgram, "u_halfSize");
    cornerLocation = gl.getUniformLocation(glProgram, "u_corner");
    bandLocation = gl.getUniformLocation(glProgram, "u_band");
    strengthLocation = gl.getUniformLocation(glProgram, "u_strength");
    magnifyLocation = gl.getUniformLocation(glProgram, "u_magnify");
    chromaLocation = gl.getUniformLocation(glProgram, "u_chroma");
    
    // WebGL 2 Premium uniforms
    squircleNLocation = gl.getUniformLocation(glProgram, "u_squircleN");
    specularLocation = gl.getUniformLocation(glProgram, "u_specularStrength");
    frostLocation = gl.getUniformLocation(glProgram, "u_frost");
    beerThicknessLocation = gl.getUniformLocation(glProgram, "u_beerThickness");
    causticStrengthLocation = gl.getUniformLocation(glProgram, "u_causticStrength");
    mouseLocation = gl.getUniformLocation(glProgram, "u_mouse");
    dprLocation = gl.getUniformLocation(glProgram, "u_dpr");
    tintLocation = gl.getUniformLocation(glProgram, "u_tint");

    // Height Field & Snell Refraction uniforms
    thicknessLocation = gl.getUniformLocation(glProgram, "u_thickness");
    domeHeightLocation = gl.getUniformLocation(glProgram, "u_domeHeight");
    iorLocation = gl.getUniformLocation(glProgram, "u_ior");
    bgDistLocation = gl.getUniformLocation(glProgram, "u_bgDist");

    textureImage = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, textureImage);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    canvas.style.filter = "blur(var(--canvas-blur, 2px)) saturate(150%) brightness(0.92)";

    // Pre-warm WebGL: render a blank frame to warm up shader compilation and GPU pipeline
    try {
      gl.viewport(0, 0, 10, 10);
      const dummyTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dummyTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.useProgram(glProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dummyTex);
      gl.uniform1i(imageLocation, 0);
      gl.uniform2f(resolutionLocation, 10, 10);
      gl.uniform2f(centerLocation, 5, 5);
      gl.uniform2f(halfSizeLocation, 5, 5);
      gl.uniform1f(cornerLocation, 2);
      gl.uniform1f(bandLocation, 2);
      gl.uniform1f(strengthLocation, 0);
      gl.uniform1f(magnifyLocation, 0);
      gl.uniform1f(chromaLocation, 0);
      gl.uniform1f(squircleNLocation, 4.0);
      gl.uniform1f(specularLocation, 0);
      gl.uniform1f(frostLocation, 0);
      gl.uniform1f(beerThicknessLocation, 0);
      gl.uniform1f(causticStrengthLocation, 0);
      gl.uniform1f(dprLocation, 1.0);
      gl.uniform4f(tintLocation, 0, 0, 0, 0);
      if (thicknessLocation) gl.uniform1f(thicknessLocation, 30.0);
      if (domeHeightLocation) gl.uniform1f(domeHeightLocation, 6.0);
      if (iorLocation) gl.uniform1f(iorLocation, 1.5);
      if (bgDistLocation) gl.uniform1f(bgDistLocation, 40.0);
      if (mouseLocation) gl.uniform2f(mouseLocation, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.deleteTexture(dummyTex);
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

async function pumpFrames() {
  if (!pumping) return;
  const bgCanvas = document.getElementById("bg-canvas");
  if (!bgCanvas) return;

  if (!webglInitialized && !initWebGL(bgCanvas)) {
    pumping = false;
    return;
  }

  const startTime = Date.now();

  try {
    const res = await fetch(`http://bgframe.localhost/frame?since=${lastRenderedSeq}`, { cache: "no-store" });
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

          gl.bindTexture(gl.TEXTURE_2D, textureImage);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf));

          gl.useProgram(glProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, textureImage);
          gl.uniform1i(imageLocation, 0);

          const scale = w / 720.0;
          const dpr = window.devicePixelRatio;
          gl.uniform2f(resolutionLocation, w, h);
          gl.uniform2f(centerLocation, 360.0 * scale, 265.0 * scale);
          gl.uniform2f(halfSizeLocation, (320.0 - CORNER) * scale, (225.0 - CORNER) * scale);
          gl.uniform1f(cornerLocation, CORNER * scale);

          // u_band: bevel border size
          const dynamicBand = (75.0 + glassSettings.glassBlur * 1.5) * scale;
          gl.uniform1f(bandLocation, dynamicBand);

          // u_strength: refraction strength
          const dynamicStrength = (glassSettings.strength) * scale;
          gl.uniform1f(strengthLocation, dynamicStrength);

          gl.uniform1f(magnifyLocation, 0.015);
          gl.uniform1f(chromaLocation, glassSettings.chroma);

          // Bind WebGL 2 Premium uniforms
          gl.uniform1f(squircleNLocation, glassSettings.squircleN);
          gl.uniform1f(specularLocation, 0.45);
          gl.uniform1f(frostLocation, glassSettings.frost);
          gl.uniform1f(beerThicknessLocation, glassSettings.beer);
          gl.uniform1f(causticStrengthLocation, glassSettings.caustic);
          gl.uniform1f(dprLocation, dpr);

          // Bind Height Field & Snell Refraction uniforms dynamically based on settings sliders
          const thicknessVal = glassSettings.beer * 2.5; // Mapped: beer 10~24 -> thickness 25~60
          const domeHeightVal = glassSettings.caustic * 10.0; // Mapped: caustic 0.4~1.2 -> domeHeight 4~12
          const iorVal = 1.3 + glassSettings.chroma * 5.0; // Mapped: chroma 0.03~0.05 -> ior 1.45~1.55
          const bgDistVal = glassSettings.strength * 1.3; // Mapped: strength 0~60 -> bgDist 0~78
          
          if (thicknessLocation) gl.uniform1f(thicknessLocation, thicknessVal * scale);
          if (domeHeightLocation) gl.uniform1f(domeHeightLocation, domeHeightVal * scale);
          if (iorLocation) gl.uniform1f(iorLocation, iorVal);
          if (bgDistLocation) gl.uniform1f(bgDistLocation, bgDistVal * scale);

          const isDark = !document.documentElement.hasAttribute('data-theme') ||
                         document.documentElement.getAttribute('data-theme') === 'dark';
          const tintOpacity = Math.max(0.01, glassSettings.glassBlur * 0.008 + 0.01);
          if (isDark) {
            gl.uniform4f(tintLocation, 18/255, 18/255, 24/255, tintOpacity);
          } else {
            gl.uniform4f(tintLocation, 240/255, 240/255, 245/255, tintOpacity);
          }

          // Convert mouse coordinate relative to centered canvas
          if (mouseLocation) {
            const mx = (currentMouseX - 320) * dpr * scale;
            const my = (currentMouseY - 225) * dpr * scale;
            gl.uniform2f(mouseLocation, mx, my);
          }

          gl.drawArrays(gl.TRIANGLES, 0, 6);

          if (glassState === "Starting") {
            glassState = "LiquidGlass";
            console.log("[FromZero] Handshake: First frame rendered, transitioning to LiquidGlass state");
            const container = document.getElementById("launcher-container");
            if (container) {
              container.classList.remove("blurred");
              container.classList.add("liquid-glass-active");
            }
            try { await invoke("set_blur", { value: 0 }); } catch (_) {}
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
      glassSettings.glassFps = settings.glass_settings.glass_fps ?? glassSettings.glassFps;
      glassSettings.strength = settings.glass_settings.strength ?? glassSettings.strength;
      glassSettings.chroma = settings.glass_settings.chroma ?? glassSettings.chroma;
      glassSettings.frost = settings.glass_settings.frost ?? glassSettings.frost;
      glassSettings.beer = settings.glass_settings.beer ?? glassSettings.beer;
      glassSettings.caustic = settings.glass_settings.caustic ?? glassSettings.caustic;
      glassSettings.squircleN = settings.glass_settings.squircle_n ?? glassSettings.squircleN;
      glassSettings.searchHeight = settings.glass_settings.search_height ?? glassSettings.searchHeight;
      glassSettings.searchOffset = settings.glass_settings.search_offset ?? glassSettings.searchOffset;
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

    if (listen) {
      listen("apps-updated", (event) => {
        const newApps = event.payload;
        console.log(`[FromZero] Received background apps update: ${newApps.length} apps`);
        appItems = newApps;
        if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 已更新 ${appItems.length} 个应用`;
        renderRecentApps();
        handleSearch();
      }).catch((e) => console.error("[FromZero] Failed to listen to apps-updated event:", e));
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
    if (document.hasFocus()) {
      await handleWindowFocus();
    }
  } catch (error) {
    console.error("[FromZero] Initialization error:", error);
    if (footerStatus) footerStatus.textContent = `${APP_VERSION} · 初始化失败，请重试`;
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
    .map(path => appItems.find(app => app.path === path))
    .filter(Boolean)
    .slice(0, maxApps);
  const displayApps = recentApps.length > 0 ? recentApps : appItems.slice(0, maxApps);
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
    border_opacity: glassSettings.borderOpacity,
    glass_fps: glassSettings.glassFps,
    strength: glassSettings.strength,
    chroma: glassSettings.chroma,
    frost: glassSettings.frost,
    beer: glassSettings.beer,
    caustic: glassSettings.caustic,
    squircle_n: glassSettings.squircleN,
    search_height: glassSettings.searchHeight,
    search_offset: glassSettings.searchOffset
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