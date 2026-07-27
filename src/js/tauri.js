// === Tauri API access with browser-dev mocks ===
// Extracts the injected global API once, then deletes window.__TAURI__ to
// protect against XSS command injection.

let invoke, getCurrentWindow, listen, convertFileSrc;

if (window.__TAURI__) {
  invoke = window.__TAURI__.core.invoke;
  getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  if (window.__TAURI__.event) {
    listen = window.__TAURI__.event.listen.bind(window.__TAURI__.event);
  } else {
    const currentWin = getCurrentWindow();
    listen = currentWin.listen.bind(currentWin);
  }
  convertFileSrc = window.__TAURI__.core.convertFileSrc;

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
    if (cmd === "start_bg_capture") {
      throw new Error("Desktop capture is unavailable in browser preview");
    }
    if (
      cmd === "scan_apps" ||
      cmd === "search_apps" ||
      cmd === "search_files" ||
      cmd === "list_directory"
    )
      return [];
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

const appWindow = getCurrentWindow();

export { invoke, listen, convertFileSrc, appWindow };
