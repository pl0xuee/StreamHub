const path = require('path');
const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  components,
  ipcMain,
  dialog,
  Menu,
} = require('electron');

const configStore = require('./config');
const { ViewManager } = require('./views');
const { registerMediaKeys, unregisterMediaKeys } = require('./shortcuts');

const SIDEBAR_WIDTH = 220;
// Collapsed, the sidebar keeps a narrow rail rather than disappearing: the service view
// is layered over the app chrome, so a zero-width sidebar would leave nothing on screen
// to click to bring it back.
const SIDEBAR_RAIL_WIDTH = 56;

// NOTE: cookies — i.e. the logins — are stored UNENCRYPTED on disk, in
// <userData>/Partitions/<service>@default/Cookies. Unlike Chrome, Electron does not attach
// a crypto delegate to its cookie store, so the --password-store switch and safeStorage do
// not change this: verified on a fresh profile with kwallet6 active and encryption
// reported available, and every cookie still landed in plaintext. There is no supported way
// to turn it on. The file is mode 0600, so the exposure is to this user's own processes and
// to anything that copies the directory wholesale (backups, cloud sync, disk images).

let baseWindow;
let chromeView; // the app's own UI (sidebar), hosted in its own view
let removedWindow = null; // separate window listing removed services
let viewManager;
let config = { services: [], removed: [] }; // the user's list, loaded from userData
let activeServiceId = null;
let sidebarCollapsed = false;

function layout() {
  const { width, height } = baseWindow.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  viewManager.layout(width, height);
}

// The single source of truth pushed to every window (main sidebar + removed window).
function statePayload() {
  return {
    services: config.services,
    removed: config.removed,
    activeServiceId,
    sidebarCollapsed,
  };
}

function broadcast() {
  const payload = statePayload();
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send('state', payload);
  }
  if (removedWindow && !removedWindow.isDestroyed()) {
    removedWindow.webContents.send('state', payload);
  }
}

function persist() {
  configStore.save(config);
}

function switchService(serviceId) {
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return;
  activeServiceId = serviceId;
  viewManager.show(service);
  broadcast();
}

function createWindow() {
  baseWindow = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'StreamHub',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  baseWindow.contentView.addChildView(chromeView);
  chromeView.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));

  viewManager = new ViewManager(baseWindow, SIDEBAR_WIDTH);

  layout();
  baseWindow.on('resize', layout);
  baseWindow.on('enter-full-screen', layout);
  baseWindow.on('leave-full-screen', layout);

  // Hold the media keys only while our window is focused, so they pass through to
  // other players (Spotify, etc.) when the app is in the background. The window opens
  // focused, so register now; then track focus/blur.
  const wireMediaKeys = () =>
    registerMediaKeys(() => viewManager.getActiveWebContents(), viewManager);
  wireMediaKeys();
  baseWindow.on('focus', wireMediaKeys);
  baseWindow.on('blur', unregisterMediaKeys);

  baseWindow.on('closed', () => {
    baseWindow = null;
    if (removedWindow && !removedWindow.isDestroyed()) removedWindow.close();
  });
}

// Separate window listing removed services; clicking one restores it to the sidebar.
function openRemovedWindow() {
  if (removedWindow && !removedWindow.isDestroyed()) {
    removedWindow.focus();
    return;
  }
  removedWindow = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 300,
    minHeight: 320,
    backgroundColor: '#14161a',
    title: 'Removed services',
    autoHideMenuBar: true,
    parent: baseWindow || undefined,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  removedWindow.loadFile(path.join(__dirname, 'ui', 'removed.html'));
  removedWindow.on('closed', () => {
    removedWindow = null;
  });
}

// A tiny menu that keeps useful accelerators (F11 fullscreen, reload) without the
// sprawling default template. autoHideMenuBar keeps it hidden until Alt is pressed.
function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'togglefullscreen' },
          { role: 'reload' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
    ]),
  );
}

// ---- IPC from the sidebar UI ----
ipcMain.handle('get-config', () => statePayload());

ipcMain.on('switch-service', (_e, serviceId) => switchService(serviceId));

ipcMain.on('toggle-sidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  // The service view starts where the sidebar ends, so collapsing widens the video.
  viewManager.setSidebarWidth(sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH);
  broadcast();
});

// Reorder the enabled list to match the ids the sidebar sends after a drag.
ipcMain.on('reorder-services', (_e, orderedIds) => {
  if (!Array.isArray(orderedIds)) return;
  const byId = new Map(config.services.map((s) => [s.id, s]));
  const next = [];
  for (const id of orderedIds) {
    if (byId.has(id)) {
      next.push(byId.get(id));
      byId.delete(id);
    }
  }
  for (const leftover of byId.values()) next.push(leftover); // keep any not mentioned
  config.services = next;
  persist();
  broadcast();
});

// Remove a service to the "removed" list (its login partition is kept on disk, so
// restoring later keeps the session). If it was active, fall back to another service.
ipcMain.on('remove-service', (_e, serviceId) => {
  const idx = config.services.findIndex((s) => s.id === serviceId);
  if (idx === -1) return;
  const [service] = config.services.splice(idx, 1);
  if (!config.removed.some((s) => s.id === service.id)) config.removed.push(service);
  viewManager.destroyView(serviceId);
  if (activeServiceId === serviceId) {
    activeServiceId = null;
    if (config.services[0]) switchService(config.services[0].id);
  }
  persist();
  broadcast();
});

// Move a service back from the removed list to the end of the enabled list.
ipcMain.on('restore-service', (_e, serviceId) => {
  const idx = config.removed.findIndex((s) => s.id === serviceId);
  if (idx === -1) return;
  const [service] = config.removed.splice(idx, 1);
  if (!config.services.some((s) => s.id === service.id)) config.services.push(service);
  persist();
  // If nothing is currently showing (e.g. the list had been emptied), open the restored
  // one so the content area isn't left blank; otherwise just refresh the lists.
  if (!activeServiceId) switchService(service.id);
  else broadcast();
});

ipcMain.on('open-removed-window', () => openRemovedWindow());

ipcMain.on('toggle-fullscreen', () => {
  baseWindow.setFullScreen(!baseWindow.isFullScreen());
});

ipcMain.on('toggle-pip', () => viewManager.togglePip());
ipcMain.on('reload-active', () => viewManager.reloadActive());
ipcMain.on('go-back', () => viewManager.goBack());

// ---- App lifecycle ----
app.whenReady().then(async () => {
  // Download + verify the Widevine CDM bundled by castLabs ECS before any playback.
  // If it fails (offline, flaky network, castLabs outage) we must still open a window
  // and tell the user, rather than silently never creating one.
  try {
    await components.whenReady();
    // eslint-disable-next-line no-console
    console.log('[widevine] components ready:', components.status());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[widevine] failed to initialize:', err);
    dialog.showErrorBox(
      'Playback component failed to load',
      'The Widevine module could not be downloaded or verified, so protected video ' +
        'may not play. Check your internet connection and restart the app.\n\n' +
        String(err),
    );
  }
  config = configStore.load(); // the user's list, from their userData dir
  buildAppMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  unregisterMediaKeys();
  app.quit();
});

app.on('will-quit', unregisterMediaKeys);
