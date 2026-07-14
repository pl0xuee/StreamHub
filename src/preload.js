const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge exposed to the sidebar UI only (not to the streaming sites).
contextBridge.exposeInMainWorld('shell', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  switchService: (id) => ipcRenderer.send('switch-service', id),
  // Service-list management (drag reorder, remove, restore).
  reorderServices: (orderedIds) => ipcRenderer.send('reorder-services', orderedIds),
  removeService: (id) => ipcRenderer.send('remove-service', id),
  restoreService: (id) => ipcRenderer.send('restore-service', id),
  openRemovedWindow: () => ipcRenderer.send('open-removed-window'),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  togglePip: () => ipcRenderer.send('toggle-pip'),
  reload: () => ipcRenderer.send('reload-active'),
  back: () => ipcRenderer.send('go-back'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
