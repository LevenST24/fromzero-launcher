// === FromZero Launcher — Main Frontend Logic ===

// Safe extraction of Tauri APIs with fallback mocks for non-Tauri browser environments/test runner
let invoke, getCurrentWindow, listen, convertFileSrc;

if (window.__TAURI__) {
  invoke = window.__TAURI__.core.invoke;
  getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  listen = window.__TAURI__.event ? window.__TAURI__.event.listen : getCurrentWindow().listen;
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
  glassBlur: 24,
  dispScale: 70,
  dispEdge: 20,
  dispStrength: 0.45,
  specularOpacity: 0.60,
  borderOpacity: 0.60
};
let backupGlassSettings = null;

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

// Animation loop state
let springAnimationId = null;
let startSprings = null;
let stopSprings = null;

// =============================================
// Window Focus/Blur Management (JS-side with debounce)
// =============================================

window.addEventListener("focus", () => {
  lastShowTime = Date.now();
  updateRefractionBackground();
  if (startSprings) startSprings();
  const container = document.getElementById("launcher-container");
  if (container) container.classList.remove("blurred");
  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
    }
  }, 50);
});

window.addEventListener("blur", () => {
  if (stopSprings) stopSprings();
  const container = document.getElementById("launcher-container");
  if (container) container.classList.add("blurred");

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
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// =============================================
// Generate Displacement Map via Canvas
// Creates an SDF-based edge displacement map for the SVG feDisplacementMap filter.
// Pixels near edges have non-neutral (0.5, 0.5) values → displacement.
// Center pixels are neutral → no distortion.
// This is ported from rdev/liquid-glass-react's shader-utils.
// =============================================
function generateDisplacementMap(width, height, borderRadius, edgeWidthParam, displacementStrengthParam) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const r = borderRadius;
  const edgeWidth = edgeWidthParam || 20; // pixels from edge where displacement is visible
  const displacementStrength = displacementStrengthParam !== undefined ? displacementStrengthParam : 0.45; // max displacement as fraction of 0.5 range

  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;

  // Helper: Inigo Quilez Rounded Box SDF
  function sdRoundBox(x, y, w, h, radius) {
    const px = x - w / 2;
    const py = y - h / 2;
    const qx = Math.abs(px) - w / 2 + radius;
    const qy = Math.abs(py) - h / 2 + radius;
    const maxQ = Math.max(qx, qy);
    const minPart = Math.min(maxQ, 0.0);
    const maxQx0 = Math.max(qx, 0.0);
    const maxQy0 = Math.max(qy, 0.0);
    const lenPart = Math.sqrt(maxQx0 * maxQx0 + maxQy0 * maxQy0);
    return minPart + lenPart - radius;
  }

  // Helper: Normal pointing outward
  function getRoundBoxNormal(x, y, w, h, radius) {
    const px = x - w / 2;
    const py = y - h / 2;
    const signX = px >= 0 ? 1 : -1;
    const signY = py >= 0 ? 1 : -1;
    const qx = Math.abs(px) - w / 2 + radius;
    const qy = Math.abs(py) - h / 2 + radius;

    if (qx > 0 || qy > 0) {
      const qxPlus = Math.max(qx, 0);
      const qyPlus = Math.max(qy, 0);
      const len = Math.sqrt(qxPlus * qxPlus + qyPlus * qyPlus) || 1;
      return {
        x: (qxPlus / len) * signX,
        y: (qyPlus / len) * signY
      };
    } else {
      if (qx > qy) {
        return { x: signX, y: 0 };
      } else {
        return { x: 0, y: signY };
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 4;
      const sdfValue = sdRoundBox(x, y, width, height, r);
      const dist = Math.abs(sdfValue);

      // 1. Calculate displacement (R & G channels)
      let dispX = 0.5;
      let dispY = 0.5;

      if (dist < edgeWidth) {
        const t = Math.max(0, 1 - dist / edgeWidth);
        const smoothT = t * t * (3 - 2 * t); // smoothstep
        const normal = getRoundBoxNormal(x, y, width, height, r);

        // Subtract normal to refract inward (avoiding out-of-bounds sampling)
        dispX = 0.5 - normal.x * displacementStrength * smoothT;
        dispY = 0.5 - normal.y * displacementStrength * smoothT;
      }

      pixels[pi] = Math.round(dispX * 255);     // R channel
      pixels[pi + 1] = Math.round(dispY * 255); // G channel
      pixels[pi + 2] = 128;                       // B channel (neutral)

      // 2. Calculate antialiased rounded mask (Alpha channel)
      // sdfValue is negative inside, positive outside the rounded rectangle.
      // We want a smooth transition from 255 (inside) to 0 (outside) at the boundary.
      let alpha = 0;
      if (sdfValue < -1.0) {
        alpha = 255;
      } else if (sdfValue > 1.0) {
        alpha = 0;
      } else {
        // Linear transition over a 2px boundary (-1.0 to 1.0)
        alpha = Math.round((1.0 - sdfValue) / 2.0 * 255);
      }
      pixels[pi + 3] = alpha;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Helper: Apply visual configurations to DOM/CSS and SVG filter scales in real time
function applyVisualSettings(config) {
  const container = document.getElementById("launcher-container");
  if (!container) return;

  container.style.setProperty("--glass-blur", `${config.glassBlur}px`);
  container.style.setProperty("--specular-opacity", config.specularOpacity);

  // Border opacities are scaled based on the single borderOpacity slider value
  const b1 = (config.borderOpacity * 0.3).toFixed(3);
  const b2 = (config.borderOpacity * 0.2).toFixed(3);
  container.style.setProperty("--border1-opacity", b1);
  container.style.setProperty("--border2-opacity", b2);

  // Update SVG feDisplacementMap scale attribute in real time
  const dispMaps = document.querySelectorAll("feDisplacementMap");
  if (dispMaps.length >= 3) {
    const s = config.dispScale;
    dispMaps[0].setAttribute("scale", Math.max(0, s));
    dispMaps[1].setAttribute("scale", Math.max(0, s - 4));
    dispMaps[2].setAttribute("scale", Math.max(0, s - 8));
  }

  // Update SVG feGaussianBlur stdDeviation attribute in real time
  const glassBlurFilter = document.getElementById("glass-blur-filter");
  if (glassBlurFilter) {
    glassBlurFilter.setAttribute("stdDeviation", config.glassBlur);
  }
}

// Helper: Fetch background Base64 image from Rust state and update style
async function updateRefractionBackground() {
  const container = document.getElementById("launcher-container");
  try {
    const base64 = await invoke("get_background");
    const refractionBg = document.getElementById("refraction-bg");
    if (refractionBg && base64 && base64.trim() !== "") {
      refractionBg.style.backgroundImage = `url("${base64}")`;
      if (container) {
        container.classList.remove("no-refraction");
      }
      console.log("[FromZero] ✓ Refraction background updated");
    } else {
      if (container) {
        container.classList.add("no-refraction");
      }
      console.warn("[FromZero] Captured background is empty, using fallback");
    }
  } catch (e) {
    if (container) {
      container.classList.add("no-refraction");
    }
    console.warn("[FromZero] Failed to get captured background, using fallback:", e);
  }
}

// Helper: Debounce displacement map regeneration during slider moves to ensure 60fps fluidity
let canvasDebounceTimeout = null;
function triggerCanvasRegen(edgeVal, strengthVal) {
  clearTimeout(canvasDebounceTimeout);
  canvasDebounceTimeout = setTimeout(() => {
    try {
      const feImageEl = document.getElementById("displacement-map-image");
      if (feImageEl) {
        const mapCanvas = generateDisplacementMap(640, 450, 16, edgeVal, strengthVal);
        feImageEl.setAttribute("href", mapCanvas.toDataURL("image/png"));
        console.log("[FromZero] ✓ Displacement map updated live");
      }
    } catch (e) {
      console.warn("Canvas regeneration error:", e);
    }
  }, 40);
}

// Helper: Initialize sliders listeners
function initSliderListeners() {
  const sliders = [
    { id: "slider-glass-blur", valId: "val-glass-blur", key: "glassBlur", isFloat: false },
    { id: "slider-disp-scale", valId: "val-disp-scale", key: "dispScale", isFloat: false },
    { id: "slider-disp-edge", valId: "val-disp-edge", key: "dispEdge", isFloat: false, triggerCanvas: true },
    { id: "slider-disp-strength", valId: "val-disp-strength", key: "dispStrength", isFloat: true, triggerCanvas: true },
    { id: "slider-specular-opacity", valId: "val-specular-opacity", key: "specularOpacity", isFloat: true },
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

        if (s.triggerCanvas) {
          triggerCanvasRegen(currentConfig.dispEdge, currentConfig.dispStrength);
        }
      });
    }
  });
}

// Helper: Read sliders values
function readSlidersState() {
  return {
    glassBlur: parseInt(document.getElementById("slider-glass-blur").value),
    dispScale: parseInt(document.getElementById("slider-disp-scale").value),
    dispEdge: parseInt(document.getElementById("slider-disp-edge").value),
    dispStrength: parseFloat(document.getElementById("slider-disp-strength").value),
    specularOpacity: parseFloat(document.getElementById("slider-specular-opacity").value),
    borderOpacity: parseFloat(document.getElementById("slider-border-opacity").value)
  };
}

// Helper: Sync sliders elements to configurations
function syncSlidersToConfig(config) {
  const mappings = [
    { id: "slider-glass-blur", valId: "val-glass-blur", val: config.glassBlur, isFloat: false },
    { id: "slider-disp-scale", valId: "val-disp-scale", val: config.dispScale, isFloat: false },
    { id: "slider-disp-edge", valId: "val-disp-edge", val: config.dispEdge, isFloat: false },
    { id: "slider-disp-strength", valId: "val-disp-strength", val: config.dispStrength, isFloat: true },
    { id: "slider-specular-opacity", valId: "val-specular-opacity", val: config.specularOpacity, isFloat: true },
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

    // Load Liquid Glass parameters from localStorage
    try {
      const stored = localStorage.getItem("fromzero-liquid-glass");
      if (stored) {
        glassSettings = { ...glassSettings, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn("Failed to load local glass settings:", e);
    }
    applyVisualSettings(glassSettings);
    updateRefractionBackground();

    applyTheme(settings.theme);
    if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Ctrl+Space";
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
    // Displacement Map Initialization
    // Load pre-baked displacement map data into SVG feImage
    // =============================================
    try {
      // The displacement map is a PNG base64 data URL stored inline
      const feImageEl = document.getElementById("displacement-map-image");
      if (feImageEl) {
        // Generate the displacement map via Canvas (SDF-based edge displacement)
        const mapCanvas = generateDisplacementMap(640, 450, 16, glassSettings.dispEdge, glassSettings.dispStrength);
        feImageEl.setAttribute("href", mapCanvas.toDataURL("image/png"));
        console.log("[FromZero] ✓ Displacement map generated and loaded");
      }
    } catch (e) {
      console.warn("[FromZero] Displacement map init failed, refraction disabled:", e);
    }

    // =============================================
    // Specular Highlight + Border Highlight — cursor-following light
    // =============================================
    const container = document.getElementById("launcher-container");
    if (container) {
      // Spring state for specular highlight + border highlight
      let targetMouseX = 0;
      let targetMouseY = 0;
      let isHovered = false;

      // Specular Highlight Spring (snappy light reflection)
      let shX = -999, shY = -999;
      let shVx = 0, shVy = 0;
      const shStiffness = 0.12;
      const shDamping = 0.16;
      let isSpringRunning = false;

      // Border highlight angle (smooth interpolation, no spring needed)
      let currentBorderAngle = 135;
      let targetBorderAngle = 135;

      function updateSprings() {
        if (!document.getElementById("launcher-container")) {
          springAnimationId = null;
          isSpringRunning = false;
          return;
        }

        let targetShX = -999;
        let targetShY = -999;

        if (isHovered) {
          targetShX = targetMouseX;
          targetShY = targetMouseY;
        }

        let needsUpdate = false;

        // Update Specular Highlight Spring only
        if (targetShX === -999) {
          if (shX !== -999) {
            shX = -999;
            shY = -999;
            shVx = 0;
            shVy = 0;
            needsUpdate = true; // One final frame to write offscreen variables
          }
        } else {
          if (shX === -999) { shX = targetShX; shY = targetShY; }
          const dx = targetShX - shX;
          const dy = targetShY - shY;

          // Only animate if the spring has not settled
          if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(shVx) > 0.05 || Math.abs(shVy) > 0.05) {
            const ax = dx * shStiffness;
            const ay = dy * shStiffness;
            shVx = (shVx + ax) * (1 - shDamping);
            shVy = (shVy + ay) * (1 - shDamping);
            shX += shVx;
            shY += shVy;
            needsUpdate = true;
          } else {
            // Settle exactly to target coordinates
            shX = targetShX;
            shY = targetShY;
            shVx = 0;
            shVy = 0;
          }
        }

        // Render CSS coordinates for specular highlight
        if (shX === -999) {
          container.style.setProperty("--mx", `-999px`);
          container.style.setProperty("--my", `-999px`);
        } else {
          container.style.setProperty("--mx", `${shX}px`);
          container.style.setProperty("--my", `${shY}px`);
        }

        // Update border highlight angle (smooth interpolation)
        const angleDiff = targetBorderAngle - currentBorderAngle;
        if (Math.abs(angleDiff) > 0.1) {
          currentBorderAngle += angleDiff * 0.08;
          container.style.setProperty("--border-angle", `${currentBorderAngle}deg`);
        }

        if (needsUpdate) {
          springAnimationId = requestAnimationFrame(updateSprings);
        } else {
          springAnimationId = null;
          isSpringRunning = false;
        }
      }

      startSprings = () => {
        if (!springAnimationId) {
          isSpringRunning = true;
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

        // Calculate border highlight angle based on cursor position relative to center
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const dx = targetMouseX - cx;
        const dy = targetMouseY - cy;
        // Convert to angle (0-360), offset so top-left is default
        targetBorderAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360 + 90) % 360;

        if (!isSpringRunning) {
          startSprings();
        }
      });

      container.addEventListener("mouseleave", () => {
        isHovered = false;
      });
    }

    appWindow.listen("tauri://focus", () => {
      lastShowTime = Date.now();
      updateRefractionBackground();
      if (searchInput) searchInput.focus();
      if (startSprings) startSprings();
      const container = document.getElementById("launcher-container");
      if (container) container.classList.remove("blurred");
    });

    appWindow.listen("tauri://blur", () => {
      if (stopSprings) stopSprings();
      const container = document.getElementById("launcher-container");
      if (container) container.classList.add("blurred");
    });

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
    if (footerStatus) footerStatus.textContent = "初始化失败，请重试";
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
    el.style.animationDelay = `${index * 25}ms`;
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
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchDebounceTimeout && selectedIndex === 0) {
      clearTimeout(searchDebounceTimeout);
      searchDebounceTimeout = null;
      await handleSearch();
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
  if (shortcutDisplay) shortcutDisplay.textContent = settings.shortcut || "Ctrl+Space";
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
    triggerCanvasRegen(backupGlassSettings.dispEdge, backupGlassSettings.dispStrength);
    backupGlassSettings = null;
  }

  if (searchInput) searchInput.focus();
}

async function saveSettingsConfig() {
  if (themeSelect) settings.theme = themeSelect.value;
  if (shortcutDisplay) settings.shortcut = shortcutDisplay.textContent;
  if (autostartToggle) settings.autostart = autostartToggle.checked;
  applyTheme(settings.theme);

  // Commit glass settings
  glassSettings = readSlidersState();
  try {
    localStorage.setItem("fromzero-liquid-glass", JSON.stringify(glassSettings));
  } catch (e) {
    console.warn("Failed to save glass settings to localStorage:", e);
  }

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
    if (shortcutDisplay) shortcutDisplay.textContent = parts.join("+");
    toggleRecordingShortcut();
  }
}