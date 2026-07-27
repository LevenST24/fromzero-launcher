// === Liquid Glass: WebGL pipeline, frame pump & capture lifecycle ===

import { invoke, appWindow } from "./tauri.js";
import { launcherContainer, bgCanvas, searchInput, settingsOverlay } from "./dom.js";
import { renderRecentApps } from "./search.js";

// Liquid-glass preset matching the reference playground: light blur + strong
// refraction + gloss (specular/fresnel) + a slight ice-blue tint + drop
// shadow. The murky dark theme-tint was removed from the shader.
export const DEFAULT_GLASS_SETTINGS = {
  glassBlur: 20,
  glassFps: 60,
  strength: 28,
  searchHeight: 46,
  searchOffset: 10,
  resultsHeight: 280,
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
  chroma: 0.05,
  squircleN: 4.5,
};

// camelCase (frontend) -> snake_case (settings.json / Rust) key mapping
export const GLASS_SETTINGS_KEYS = {
  glassBlur: "glass_blur",
  glassFps: "glass_fps",
  strength: "strength",
  chroma: "chroma",
  squircleN: "squircle_n",
  searchHeight: "search_height",
  searchOffset: "search_offset",
  resultsHeight: "results_height",
  edgeHl: "edge_hl",
  specular: "specular",
  fresnel: "fresnel",
  cornerRadius: "corner_radius",
  zRadius: "z_radius",
  opacity: "opacity",
  shadowOpacity: "shadow_opacity",
  shadowSpread: "shadow_spread",
  distortion: "distortion",
  saturation: "saturation",
  brightness: "brightness",
  tintStrength: "tint_strength",
  bevelMode: "bevel_mode",
};

// Live glass parameters (mutated in place; never reassigned so importers stay bound)
export const glassSettings = { ...DEFAULT_GLASS_SETTINGS };

// Focus management: timestamp of last show (for debounce)
let lastShowTime = 0;

let pumping = false;
// Single-loop guard for pumpFrames: each fresh capture session bumps this token,
// so any older render loop self-terminates on its next tick (prevents concurrent
// double-rendering when focus fires twice without an intervening blur).
// NOTE: intentionally separate from captureGeneration, which the watchdog bumps
// while keeping the same render loop alive.
let pumpToken = 0;
let activeGlassFps = 60;

// WebGL state
let gl = null;
let glProgram = null;
let bgTexture = null;
let bgTexW = 0;
let bgTexH = 0;
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
let lastRecentLayoutKey = "";

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

export async function handleWindowFocus() {
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

  const container = launcherContainer;
  if (container) {
    container.classList.add("blurred");
    container.classList.remove("liquid-glass-active");
  }

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
  }

  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }, 50);
}

async function handleWindowBlur() {
  const gen = ++captureGeneration;
  glassState = "Stopping";
  pumping = false;
  stopWatchdog();

  const container = launcherContainer;
  if (container) {
    container.classList.add("blurred");
    container.classList.remove("liquid-glass-active");
  }

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
}

export function initGlassLifecycle() {
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
  lastShowTime = Date.now();
}

// Update FPS from the settings UI (slider input)
export function setGlassFps(val) {
  glassSettings.glassFps = val;
  activeGlassFps = val;
}

// Helper: Apply visual configurations to DOM/CSS in real time
export function applyVisualSettings(config) {
  const container = launcherContainer;
  if (!container) return;

  activeGlassFps = config.glassFps || 60;
  glassSettings.glassBlur = config.glassBlur;
  glassSettings.glassFps = config.glassFps;
  for (const key of Object.keys(DEFAULT_GLASS_SETTINGS)) {
    if (key === "glassBlur" || key === "glassFps") continue;
    glassSettings[key] = config[key] ?? glassSettings[key];
  }

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

  // Re-render the recent apps grid only when layout-affecting values change;
  // every glass slider fires this handler and a full grid rebuild per input
  // event is wasteful.
  const layoutKey = `${glassSettings.searchHeight}|${glassSettings.searchOffset}|${glassSettings.resultsHeight}`;
  if (layoutKey !== lastRecentLayoutKey) {
    lastRecentLayoutKey = layoutKey;
    renderRecentApps();
  }
}

// 300ms debounced invoke to set_capture_fps
export const debouncedSetCaptureFps = (() => {
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
    bgTexW = 0;
    bgTexH = 0;
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
          }

          // 1. Upload background texture (unit 0).
          // texSubImage2D updates in place when size is unchanged, avoiding
          // driver-side storage reallocation on every frame.
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, bgTexture);
          if (bgTexW === w && bgTexH === h) {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              w,
              h,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              new Uint8Array(buf),
            );
          } else {
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
            bgTexW = w;
            bgTexH = h;
          }

          // 2. GPU two-pass separable Gaussian blur of the background.
          // Full-resolution blur to avoid bilinear upscaling softness that
          // half-res FBOs introduce when sampled back at full size.
          const bw = w;
          const bh = h;
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
            if (launcherContainer) {
              launcherContainer.classList.remove("blurred");
              launcherContainer.classList.add("liquid-glass-active");
            }
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
