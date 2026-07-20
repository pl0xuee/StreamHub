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
  // How the panes are arranged: 'auto' (packed), 'rows' (stacked) or 'columns' (side by side).
  setGridLayout: (layout) => ipcRenderer.send('set-grid-layout', layout),
  // Service-list management (drag reorder, remove, restore).
  reorderServices: (orderedIds) => ipcRenderer.send('reorder-services', orderedIds),
  removeService: (id) => ipcRenderer.send('remove-service', id),
  restoreService: (id) => ipcRenderer.send('restore-service', id),
  openRemovedWindow: () => ipcRenderer.send('open-removed-window'),
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
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
  setTray: (on) => ipcRenderer.invoke('set-tray', on),
  // Running count of blocked requests, pushed every couple of seconds while blocking is on.
  onAdblockStats: (cb) => ipcRenderer.on('adblock-stats', (_e, blocked) => cb(blocked)),
  // Download percentage while an update is being fetched; null when it finishes or fails.
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, percent) => cb(percent)),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
