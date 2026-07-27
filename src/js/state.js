// === Shared mutable app state ===
// Kept in one object so every module reads/writes the same live values
// (ES module live bindings can't be reassigned from importers).

// NOTE: Keep in sync with version in Cargo.toml, tauri.conf.json, and package.json
export const APP_VERSION = "v0.2.7";

export const state = {
  appItems: [],
  filteredItems: [],
  selectedIndex: 0,
  settings: {},

  // Search debounce and query race condition tracking
  lastSearchId: 0,
  searchDebounceTimeout: null,

  // IME Composition state tracking
  isComposing: false,

  // File explorer state
  currentDirPath: null,
};
