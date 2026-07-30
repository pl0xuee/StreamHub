const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge exposed to the sidebar UI only (not to the streaming sites).
contextBridge.exposeInMainWorld('shell', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  switchService: (id) => ipcRenderer.send('switch-service', id),
  // Multi-view grid: toggle the mode, and (while on) add a pane for a service or close one by
  // pane id. Adding is per click, so the same service can be tiled into several panes at once.
  toggleGrid: () => ipcRenderer.send('toggle-grid'),
  addGridPane: (serviceId) => ipcRenderer.send('add-grid-pane', serviceId),
  removeGridPane: (paneId) => ipcRenderer.send('remove-grid-pane', paneId),
  // Move panes around the grid: the pane ids in their new tiling order.
  reorderGridPanes: (paneIds) => ipcRenderer.send('reorder-grid-panes', paneIds),
  // How the panes are arranged: 'auto' (packed), 'rows' (stacked) or 'columns' (side by side).
  setGridLayout: (layout) => ipcRenderer.send('set-grid-layout', layout),
  // Service-list management (drag reorder, remove, restore).
  reorderServices: (orderedIds) => ipcRenderer.send('reorder-services', orderedIds),
  removeService: (id) => ipcRenderer.send('remove-service', id),
  restoreService: (id) => ipcRenderer.send('restore-service', id),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  // Which slice of the window the chrome view occupies: 'peek' | 'rail' | 'sidebar' | 'full'.
  // A native view eats mouse events across its whole rect, so the chrome is only ever as wide as
  // the part of it that is meant to be clickable. `inset` is the same measure minus the overlays —
  // how much the sidebar itself is holding — which is what the docked layout insets the page by.
  setChromeRegion: (region, inset) => ipcRenderer.send('set-chrome-region', region, inset),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  reload: () => ipcRenderer.send('reload-active'),
  back: () => ipcRenderer.send('go-back'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // Resolves to the blocker's real state, which is not always the one that was asked for
  // (turning it on can fail if the filter engine cannot be fetched).
  setAdblock: (on) => ipcRenderer.invoke('set-adblock', on),
  // Per-service: turn blocking off for one site without losing it everywhere else.
  setServiceAdblock: (id, on) => ipcRenderer.invoke('set-service-adblock', id, on),
  // Wipes one service's cookies/storage/cache. Confirmed in the main process first.
  clearServiceData: (id) => ipcRenderer.invoke('clear-service-data', id),
  refreshFilters: () => ipcRenderer.invoke('refresh-filters'),
  // Per-site cosmetic enhancements (see enhance.js), one key at a time.
  setEnhance: (key, on) => ipcRenderer.invoke('set-enhance', key, on),
  setTray: (on) => ipcRenderer.invoke('set-tray', on),
  // Whether the sidebar slides out of the window while something is playing.
  setAutoHideSidebar: (on) => ipcRenderer.invoke('set-auto-hide-sidebar', on),
  // Whether the sidebar is tinted glass over the page, or docked opaque beside it.
  setGlassSidebar: (on) => ipcRenderer.invoke('set-glass-sidebar', on),
  // The grid HUD is only as big as it is drawn, so it asks to be grown before it expands — and
  // tells the main process the height it measured, rather than both ends keeping their own guess.
  setHudExpanded: (on, height) => ipcRenderer.send('set-hud-expanded', on, height),
  // Ctrl+, from the app menu and Ctrl+K from inside a service view: both are keystrokes the
  // renderer could never have seen for itself, forwarded by the main process.
  onOpenSheet: (cb) => ipcRenderer.on('open-sheet', (_e, name) => cb(name)),
  onOpenPalette: (cb) => ipcRenderer.on('open-palette', () => cb()),
  // Running count of blocked requests, pushed every couple of seconds while blocking is on.
  onAdblockStats: (cb) => ipcRenderer.on('adblock-stats', (_e, blocked) => cb(blocked)),
  // Download percentage while an update is being fetched; null when it finishes or fails.
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, percent) => cb(percent)),
  // Whether anything is playing. Its own channel rather than the state payload, so the sidebar
  // can dim and lift without re-rendering the service list mid-drag.
  onPlayback: (cb) => ipcRenderer.on('playback', (_e, playing) => cb(playing)),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
