// === Search, results list, recent apps & item actions ===

import { invoke, appWindow, convertFileSrc } from "./tauri.js";
import {
  searchInput,
  searchIndicator,
  welcomeScreen,
  recentGrid,
  resultsList,
  footerStatus,
  clearChildren,
} from "./dom.js";
import { state, APP_VERSION } from "./state.js";
import { getFileIcon, triggerPreview, hidePreview } from "./preview.js";

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

// Helper: generate engine display name from prefix
function getEngineName(prefix) {
  const knownNames = { g: "Google", b: "百度", bi: "Bing", gh: "GitHub" };
  if (knownNames[prefix]) return knownNames[prefix];
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export function renderRecentApps() {
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

  const recentApps = (state.settings.recent_apps || [])
    .map((path) => state.appItems.find((app) => app.path === path))
    .filter(Boolean)
    .slice(0, maxApps);
  const displayApps =
    recentApps.length > 0 ? recentApps : state.appItems.slice(0, maxApps);
  if (displayApps.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "recent-empty";
    emptyDiv.textContent = "无可用应用";
    recentGrid.appendChild(emptyDiv);
    return;
  }
  displayApps.forEach((app) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "recent-card";
    card.title = app.target;
    card.setAttribute("aria-label", `打开 ${app.name}`);
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

const EMOJI_ICON_REGEX =
  /^[\u{2190}-\u{21FF}\u{1F300}-\u{1FAF8}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚡📂🌐📁🖼️📝💻📦📄🎵🎬]/u;

export function createIconElement(iconPath, cssClass) {
  if (!iconPath || EMOJI_ICON_REGEX.test(iconPath)) {
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

export async function handleSearch() {
  if (!searchInput) return;
  const query = searchInput.value;
  state.selectedIndex = 0;
  state.filteredItems = [];
  state.currentDirPath = null;
  hidePreview();
  const currentSearchId = ++state.lastSearchId;
  if (query.trim() === "") {
    if (welcomeScreen) welcomeScreen.style.display = "block";
    if (resultsList) resultsList.style.display = "none";
    state.filteredItems = [];
    if (searchIndicator) searchIndicator.textContent = "🔍";
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }
  searchInput.setAttribute("aria-expanded", "true");
  if (welcomeScreen) welcomeScreen.style.display = "none";
  if (resultsList) resultsList.style.display = "flex";
  if (query.startsWith(">")) {
    if (searchIndicator) searchIndicator.textContent = "⚡";
    const subQuery = query.slice(1).trim().toLowerCase();
    state.filteredItems = SYSTEM_COMMANDS.filter(
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
        if (currentSearchId !== state.lastSearchId) return;
        state.filteredItems = files.slice(0, 20).map((f) => ({
          type: f.is_dir ? "dir" : "file",
          title: f.name,
          subtitle: f.path,
          icon: getFileIcon(f),
          badge: f.is_dir ? "文件夹" : f.extension.toUpperCase() || "文件",
          data: f,
        }));
      } catch (e) {
        console.error("[FromZero] File search error:", e);
        if (currentSearchId !== state.lastSearchId) return;
        state.filteredItems = [];
      }
      renderResults();
      if (state.filteredItems.length > 0) triggerPreview(state.filteredItems[0]);
      else hidePreview();
      return;
    } else {
      // Prefix present but no keyword yet (e.g. "f "): clear stale results
      // instead of leaving the previous query's list on screen.
      if (searchIndicator) searchIndicator.textContent = "🔍";
      state.filteredItems = [];
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
      if (currentSearchId !== state.lastSearchId) return;
      state.currentDirPath = parentDir;
      state.filteredItems = files.map((f) => ({
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
      if (currentSearchId !== state.lastSearchId) return;
      state.filteredItems = [
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
      state.filteredItems.length > 0 &&
      (state.filteredItems[0].type === "file" ||
        state.filteredItems[0].type === "dir")
    ) {
      triggerPreview(state.filteredItems[0]);
    } else {
      hidePreview();
    }
    return;
  } else {
    const match = query.match(/^([a-zA-Z]+)\s+(.+)$/);
    if (match && state.settings.web_engines[match[1].toLowerCase()]) {
      const prefix = match[1].toLowerCase();
      const searchWord = match[2];
      const engineUrl = state.settings.web_engines[prefix];
      const targetUrl = engineUrl.replace("{}", encodeURIComponent(searchWord));
      const engineName = getEngineName(prefix);
      if (searchIndicator) searchIndicator.textContent = "🌐";
      state.filteredItems = [
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
        // A one-character file crawl is both noisy and disproportionately
        // expensive. Explicit `f ...` search still supports any query length.
        const inlineFileSearch =
          Array.from(query.trim()).length >= 2
            ? invoke("search_files", { query, isInline: true }).catch((err) => {
                console.warn("[FromZero] Inline file search error:", err);
                return [];
              })
            : Promise.resolve([]);
        const [appResults, fileResults] = await Promise.all([
          invoke("search_apps", { query }),
          inlineFileSearch,
        ]);
        if (currentSearchId !== state.lastSearchId) return;

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

        state.filteredItems = [...appItemsList, ...fileItemsList];

        if (state.filteredItems.length < 7) {
          const defaultBaidu = `https://baidu.com/s?wd=${encodeURIComponent(query)}`;
          state.filteredItems.push({
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
        if (currentSearchId !== state.lastSearchId) return;
        state.filteredItems = [];
      }
      renderResults();

      if (
        state.filteredItems.length > 0 &&
        (state.filteredItems[0].type === "file" ||
          state.filteredItems[0].type === "dir")
      ) {
        triggerPreview(state.filteredItems[0]);
      } else {
        hidePreview();
      }
    }
  }
}

/** Tracks last selected DOM index to avoid O(n) classList thrash on hover */
let lastRenderedSelectedIndex = -1;

function renderResults() {
  if (!resultsList) return;
  clearChildren(resultsList);
  lastRenderedSelectedIndex = -1;
  if (state.filteredItems.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "results-empty";
    emptyDiv.textContent = "无搜索匹配项";
    resultsList.appendChild(emptyDiv);
    if (searchInput) searchInput.removeAttribute("aria-activedescendant");
    return;
  }
  // Batch DOM inserts to avoid repeated reflows while building the list
  const fragment = document.createDocumentFragment();
  state.filteredItems.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `result-item ${index === state.selectedIndex ? "selected" : ""}`;
    el.id = `result-option-${index}`;
    el.setAttribute("role", "option");
    el.setAttribute(
      "aria-selected",
      index === state.selectedIndex ? "true" : "false",
    );
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
    el.setAttribute("data-index", index);
    fragment.appendChild(el);
  });
  resultsList.appendChild(fragment);
  lastRenderedSelectedIndex = state.selectedIndex;
  const selectedEl = resultsList.children[state.selectedIndex];
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
    if (searchInput)
      searchInput.setAttribute("aria-activedescendant", selectedEl.id);
  }
}

export function updateSelectionVisual() {
  if (!resultsList) return;
  const items = resultsList.children;
  const prev = lastRenderedSelectedIndex;
  const next = state.selectedIndex;

  if (
    prev !== next &&
    prev >= 0 &&
    prev < items.length &&
    items[prev].classList &&
    items[prev].classList.contains("result-item")
  ) {
    items[prev].classList.remove("selected");
    items[prev].setAttribute("aria-selected", "false");
  }

  if (
    next >= 0 &&
    next < items.length &&
    items[next].classList &&
    items[next].classList.contains("result-item")
  ) {
    items[next].classList.add("selected");
    items[next].setAttribute("aria-selected", "true");
    items[next].scrollIntoView({ block: "nearest" });
    if (searchInput)
      searchInput.setAttribute("aria-activedescendant", items[next].id);
  }
  lastRenderedSelectedIndex = next;

  const selected = state.filteredItems[state.selectedIndex];
  if (selected && (selected.type === "file" || selected.type === "dir")) {
    triggerPreview(selected);
  } else {
    hidePreview();
  }
}

export async function executeItemAction(item) {
  try {
    if (item.type === "app") {
      const app = item.data;
      await invoke("launch_app", { path: app.path });
      try {
        const updatedSettings = await invoke("bump_recent_app", {
          path: app.path,
        });
        state.settings = { ...state.settings, ...updatedSettings };
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
