const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  components,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
  powerSaveBlocker,
  shell,
} = require('electron');

const { autoUpdater } = require('electron-updater');

const configStore = require('./config');
const { ViewManager, GRID_LAYOUTS } = require('./views');
const { adblocker } = require('./adblock');
const { cleanEnhance } = require('./enhance');
const { Mpris } = require('./mpris');
const { registerMediaKeys, unregisterMediaKeys } = require('./shortcuts');

// Only one copy of the app may run at a time, and this has to be settled before anything else:
// Chromium's on-disk session storage assumes a single process owns the profile. Two instances
// sharing one userData dir fight over the cookie store, the quota database and the service-worker
// state, and Chromium's recovery from that is to reset the storage it cannot open — which
// presents as being signed out of every service at once, with the logins unrecoverable.
//
// So a second launch never opens a window. It hands its request to the instance already running,
// which surfaces itself (it may be minimised, or hidden in the tray), and then exits. Asked for
// the lock this early so a losing instance quits before it can touch the profile at all.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// Updates are always user-initiated (the settings window's update button), so never
// download in the background — decide first, then fetch.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Where the new build actually landed. Normally it replaces the running file, but a build
// still running under an older, versioned filename gets written beside it under the new name
// (see appImageWillBeRenamed) — and it is the new file we have to restart into, not the path
// we were launched from, which by then no longer exists.
let installedAppImage = null;
autoUpdater.on('appimage-filename-updated', (file) => {
  installedAppImage = file;
});

const REPO = 'pl0xuee/StreamHub'; // for the update check
// Read from package.json directly — app.getVersion() returns Electron's version when the
// app is started as a bare script rather than a packaged app / `electron .`.
// eslint-disable-next-line global-require
const APP_VERSION = require('../package.json').version;

const SIDEBAR_WIDTH = 220;
// Collapsed, the sidebar keeps a narrow rail rather than disappearing: the service view
// is layered over the app chrome, so a zero-width sidebar would leave nothing on screen
// to click to bring it back.
const SIDEBAR_RAIL_WIDTH = 56;

// NOTE: cookies — i.e. the logins — live in <userData>/Partitions/<service>@default/Cookies.
// They are encrypted through the OS secret store (kwallet/gnome-libsecret on Linux), which is
// switched on by the EnableCookieEncryption fuse flipped at package time — see
// build/afterPack.js. It is a property of the binary, so it cannot be turned on from here,
// and neither --password-store nor safeStorage substitutes for it.
//
// Two things this does NOT do:
//   * It does not reach back. Cookies already written in plaintext stay that way until the
//     site rewrites them; "Sign out / clear data" on a service and signing in again is what
//     converts one wholesale.
//   * With no secret store available (a bare WM, a container), Chromium falls back to its
//     "basic" store, which encrypts with a hardcoded key — cosmetic, not protection. A "v10"
//     prefix on the ciphertext means that fallback; "v11" means a real key from the keyring.
//
// The file is mode 0600 either way, so the exposure was always to this user's own processes
// and to anything copying the directory wholesale (backups, cloud sync, disk images).

let baseWindow;
let chromeView; // the app's own UI (sidebar), hosted in its own view
let removedWindow = null; // separate window listing removed services
let settingsWindow = null; // separate window holding the app's settings
let viewManager;
let config = { services: [], removed: [], settings: {} }; // the user's list, loaded from userData
let activeServiceId = null;
// Multi-view grid: whether it is on, and the ordered panes tiled in it (up to four). A pane is
// `{ paneId, serviceId }` rather than a bare id, because one service may be tiled more than once
// — two Twitch streams side by side, say — and each tile browses independently. In grid mode
// `activeServiceId` tracks the primary pane (gridPanes[0]) for single-target controls.
let gridMode = false;
let gridPanes = [];
let gridLayout = 'auto'; // how those panes are arranged — see GRID_LAYOUTS in views.js
const MAX_GRID_PANES = 4; // the most the tiling layout in views.js lays out

// A fresh pane id for a service, unique within the grid. Ids are derived from the service rather
// than a running counter so they stay meaningful in the saved config, and stable across restarts.
//
// A service's first pane is deliberately given the bare service id, because views.js reads that
// key as "the service's ordinary single-mode view" and hands the tile the page the user was
// already on. Later panes get `~2`, `~3`… and views of their own. Note this is a property of the
// *pane id*, not of the pane's position: closing the first of two Twitch tiles must leave the
// second one showing exactly what it was, not promote it onto a different view.
function newPaneId(serviceId) {
  if (!gridPanes.some((p) => p.paneId === serviceId)) return serviceId;
  for (let n = 2; ; n += 1) {
    const id = `${serviceId}~${n}`;
    if (!gridPanes.some((p) => p.paneId === id)) return id;
  }
}
let sidebarCollapsed = false;
let adblockStatsTimer = null;
let pendingUpdate = null; // version string of a newer release we already know about, else null
let tray = null;
let quitting = false; // distinguishes a real quit from a close-to-tray
let sleepBlockerId = null; // powerSaveBlocker id held while something is playing
let mediaPlaying = false; // is any view playing right now — drives the sidebar's house lights
let saveWindowTimer = null;
let mpris = null; // Linux system media controls (KDE panel, lock screen)

function layout() {
  const { width, height } = baseWindow.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  viewManager.layout(width, height);
}

// Hold the display awake while a service is playing. Watching a film is the one time a
// desktop sees no input for two hours, which is exactly when the screensaver fires — the
// sites' own wake locks do not reliably carry through Electron, so hold one ourselves.
// 'prevent-display-sleep' also implies preventing system suspend.
function setPlaybackInhibitor(playing) {
  if (playing) {
    if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    return;
  }
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

// Whatever is playing also drives the system media controls, so the panel and the lock
// screen show the right thing. The page title is the closest we get to a track name — the
// sites do set navigator.mediaSession, but that lives in the page and Electron does not
// surface it to the main process.
async function onPlaybackChange(playing) {
  setPlaybackInhibitor(playing);
  mediaPlaying = playing;
  // Its own channel rather than the full state payload: a video starting or stopping must not
  // re-render the sidebar's service list, which would cancel an in-progress drag. Same reasoning
  // as the ad blocker's tally below.
  sendToUi('playback', playing);
  if (!mpris) return;

  const service = config.services.find((s) => s.id === activeServiceId);
  let title = service ? service.name : 'StreamHub';
  const wc = viewManager.getActiveWebContents();
  if (wc && !wc.isDestroyed()) {
    // Strip the site's own suffix ("… - YouTube") so the panel does not say it twice.
    const raw = wc.getTitle() || '';
    const cleaned = raw.replace(/\s*[-|–]\s*(YouTube|Twitch|Netflix|Hulu|Prime Video)\s*$/i, '');
    if (cleaned.trim()) title = cleaned.trim();
  }
  mpris.update({ playing, title, service: service ? service.name : '' });
}

// Remember the window's geometry. Debounced: resize and move fire continuously while the
// user drags, and this writes a file.
function rememberWindowLater() {
  clearTimeout(saveWindowTimer);
  saveWindowTimer = setTimeout(() => {
    if (!baseWindow || baseWindow.isDestroyed()) return;
    // A maximized/fullscreen window's bounds are the screen's, not the size to restore to,
    // so keep the last normal geometry and record the maximized state separately.
    const maximized = baseWindow.isMaximized();
    if (!maximized && !baseWindow.isFullScreen()) {
      const { x, y, width, height } = baseWindow.getBounds();
      config.window = { ...config.window, x, y, width, height };
    }
    config.window = { ...config.window, maximized };
    persist();
  }, 600);
}

// The single source of truth pushed to every window (main sidebar + removed window).
function statePayload() {
  return {
    services: config.services,
    removed: config.removed,
    activeServiceId,
    sidebarCollapsed,
    version: APP_VERSION,
    adblock: adblocker.status(),
    updateAvailable: pendingUpdate,
    lastServiceId: config.lastServiceId,
    minimizeToTray: config.settings.minimizeToTray === true,
    dimWhilePlaying: config.settings.dimWhilePlaying !== false,
    // Only the opening value — after this it is pushed on the 'playback' channel above.
    playing: mediaPlaying,
    enhance: cleanEnhance(config.settings.enhance),
    gridMode,
    gridPanes,
    gridLayout,
    gridFull: gridPanes.length >= MAX_GRID_PANES,
  };
}

// Every window that renders app state: the sidebar, plus the two secondary windows when open.
function uiWebContents() {
  const out = [];
  if (chromeView && !chromeView.webContents.isDestroyed()) out.push(chromeView.webContents);
  if (removedWindow && !removedWindow.isDestroyed()) out.push(removedWindow.webContents);
  if (settingsWindow && !settingsWindow.isDestroyed()) out.push(settingsWindow.webContents);
  return out;
}

function broadcast() {
  const payload = statePayload();
  for (const wc of uiWebContents()) wc.send('state', payload);
}

// Live counters and progress, which have their own channels rather than riding the full state
// payload. Sent to whichever windows are open — the ad blocker's tally and an update's
// progress are both rendered in the settings window.
function sendToUi(channel, payload) {
  for (const wc of uiWebContents()) wc.send(channel, payload);
}

// The settings window owns the controls that raise these dialogs, so it is the window they
// belong to while it is open — parenting them to the main window would put them behind it.
function uiParent() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
  return baseWindow;
}

function persist() {
  // Fold the live grid state into the config on every save, so the grid is remembered across
  // launches and no individual handler has to remember to copy it over.
  config.gridMode = gridMode;
  config.gridPanes = gridPanes;
  config.gridLayout = gridLayout;
  configStore.save(config);
}

// The blocked-request count moves constantly, so it gets its own channel: pushing the full
// state payload on every tick would re-render the whole service list (and cancel an
// in-progress drag) several times a second for the sake of one number.
function startAdblockStats() {
  if (adblockStatsTimer) return;
  let last = -1;
  adblockStatsTimer = setInterval(() => {
    const { blocked } = adblocker.status();
    if (blocked === last) return;
    last = blocked;
    sendToUi('adblock-stats', blocked);
  }, 2000);
}

function stopAdblockStats() {
  clearInterval(adblockStatsTimer);
  adblockStatsTimer = null;
}

function switchService(serviceId) {
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return;
  // Picking a single service leaves grid mode: this is the way back to one view.
  gridMode = false;
  gridPanes = [];
  activeServiceId = serviceId;
  // Reopen on this service next launch rather than always landing on the first one.
  config.lastServiceId = serviceId;
  persist();
  viewManager.show(service);
  broadcast();
}

// The panes currently tiled in the grid, in order, resolved to their service objects and
// skipping any that no longer names a live service (e.g. one removed while gridded).
function gridTiles() {
  const out = [];
  for (const pane of gridPanes) {
    const service = config.services.find((s) => s.id === pane.serviceId);
    if (!service) continue;
    out.push({ paneId: pane.paneId, service });
  }
  return out;
}

// Drop panes whose service has gone away and re-point activeServiceId at the primary pane.
// Returns the surviving tiles, so callers can hand them straight to the view manager.
function reconcileGrid() {
  const tiles = gridTiles();
  gridPanes = tiles.map((t) => ({ paneId: t.paneId, serviceId: t.service.id }));
  activeServiceId = gridPanes.length ? gridPanes[0].serviceId : null;
  return tiles;
}

// Turn grid mode on or off. Turning it on seeds the grid with the service that was showing;
// turning it off collapses back to the grid's primary pane as the single view.
function setGridMode(on) {
  if (on) {
    gridMode = true;
    if (!gridPanes.length) {
      const seed = activeServiceId || (config.services[0] && config.services[0].id);
      if (seed) gridPanes = [{ paneId: newPaneId(seed), serviceId: seed }];
    }
    const tiles = reconcileGrid();
    if (tiles.length) viewManager.showGrid(tiles);
  } else {
    const primary = (gridPanes[0] && gridPanes[0].serviceId) || activeServiceId;
    gridMode = false;
    gridPanes = [];
    const service = config.services.find((s) => s.id === primary);
    if (service) {
      activeServiceId = service.id;
      config.lastServiceId = service.id;
      viewManager.show(service);
    }
  }
  persist();
  broadcast();
}

function createWindow() {
  const saved = config.window || {};
  baseWindow = new BaseWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    // x/y are absent on a first run; leaving them undefined lets the WM place the window.
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#080a10',
    title: 'StreamHub',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });
  if (saved.maximized) baseWindow.maximize();

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
  // Playing/stopping drives both the display-sleep inhibitor and the system media controls.
  viewManager.onPlaybackChange = onPlaybackChange;

  layout();
  baseWindow.on('resize', layout);
  baseWindow.on('enter-full-screen', layout);
  baseWindow.on('leave-full-screen', layout);

  baseWindow.on('resize', rememberWindowLater);
  baseWindow.on('move', rememberWindowLater);
  baseWindow.on('maximize', rememberWindowLater);
  baseWindow.on('unmaximize', rememberWindowLater);

  // Hold the media keys only while our window is focused, so they pass through to
  // other players (Spotify, etc.) when the app is in the background. The window opens
  // focused, so register now; then track focus/blur.
  const wireMediaKeys = () =>
    registerMediaKeys(() => viewManager.getActiveWebContents(), viewManager);
  wireMediaKeys();
  baseWindow.on('focus', wireMediaKeys);
  baseWindow.on('blur', unregisterMediaKeys);

  // With "minimize to tray" on, closing the window hides it and playback carries on — the
  // point of the setting is to keep a stream running with the window out of the way. Quit
  // still quits: the tray menu and app.quit() set `quitting` first.
  baseWindow.on('close', (e) => {
    if (quitting || !config.settings.minimizeToTray || !tray) return;
    e.preventDefault();
    baseWindow.hide();
  });

  baseWindow.on('closed', () => {
    baseWindow = null;
    if (removedWindow && !removedWindow.isDestroyed()) removedWindow.close();
  });
}

// Tray icon: only useful alongside "minimize to tray", so it exists exactly while that is on
// — a tray icon that does nothing is clutter.
function showWindow() {
  if (!baseWindow || baseWindow.isDestroyed()) return;
  // A minimised window ignores show()/focus() on some window managers, so lift it out of the
  // taskbar first. This is the path a second launch takes to surface the running instance.
  if (baseWindow.isMinimized()) baseWindow.restore();
  baseWindow.show();
  baseWindow.focus();
}

function buildTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('StreamHub');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show StreamHub', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function applyTraySetting() {
  if (config.settings.minimizeToTray) buildTray();
  else destroyTray();
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
    backgroundColor: '#080a10',
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

// Settings live in their own window rather than in the sidebar: the sidebar is 220px wide and
// is covered by the active service's view everywhere else, so there is nowhere in the main
// window to put a panel that isn't the sidebar itself.
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 440,
    height: 580,
    minWidth: 380,
    minHeight: 420,
    backgroundColor: '#080a10',
    title: 'Settings',
    autoHideMenuBar: true,
    parent: baseWindow || undefined,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
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
          {
            label: 'Settings',
            accelerator: 'CmdOrCtrl+,',
            click: () => openSettingsWindow(),
          },
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

// Flip the multi-view grid on or off (the sidebar's grid button).
ipcMain.on('toggle-grid', () => setGridMode(!gridMode));

// While grid mode is on, clicking a sidebar service adds a pane for it. Clicking one already in
// the grid adds *another* pane rather than removing it, so a service can be tiled several times
// over — two Twitch streams at once, say. Removal is per pane, below.
ipcMain.on('add-grid-pane', (_e, serviceId) => {
  if (!gridMode) return;
  if (!config.services.some((s) => s.id === serviceId)) return;
  if (gridPanes.length >= MAX_GRID_PANES) return;
  gridPanes.push({ paneId: newPaneId(serviceId), serviceId });
  viewManager.showGrid(reconcileGrid());
  persist();
  broadcast();
});

// Close one pane, identified by pane id so that closing the first of two Twitch tiles leaves the
// other one exactly as it was. The last pane is kept — the grid toggle is how you leave the mode,
// and an empty grid would show nothing at all.
// Rearrange the panes: packed, stacked one above another, or side by side. Only bounds change,
// so the layout can be switched mid-stream without interrupting anything that is playing.
ipcMain.on('set-grid-layout', (_e, layout) => {
  if (!GRID_LAYOUTS.includes(layout)) return;
  gridLayout = layout;
  viewManager.setGridLayout(layout);
  persist();
  broadcast();
});

// Move panes around the grid. The sidebar sends the pane ids in their new tiling order after a
// drag. Reordering panes rather than services is what makes a tile carry its page with it: each
// pane keeps its own view, so nothing reloads and nothing playing is interrupted — only the
// bounds each view is given change, exactly as with the layout picker.
ipcMain.on('reorder-grid-panes', (_e, orderedIds) => {
  if (!gridMode || !Array.isArray(orderedIds)) return;
  const byId = new Map(gridPanes.map((p) => [p.paneId, p]));
  const next = [];
  for (const id of orderedIds) {
    const pane = byId.get(id);
    if (!pane) continue; // unknown or already taken — a stale id, or the same one listed twice
    next.push(pane);
    byId.delete(id);
  }
  // Anything the sidebar did not name — a pane that appeared between the drag starting and
  // ending — keeps its place at the end rather than being dropped on the floor.
  for (const pane of byId.values()) next.push(pane);
  if (next.every((p, i) => p === gridPanes[i])) return; // a drag that put everything back
  gridPanes = next;
  viewManager.showGrid(reconcileGrid());
  persist();
  broadcast();
});

ipcMain.on('remove-grid-pane', (_e, paneId) => {
  if (!gridMode || gridPanes.length <= 1) return;
  const i = gridPanes.findIndex((p) => p.paneId === paneId);
  if (i === -1) return;
  gridPanes.splice(i, 1);
  viewManager.showGrid(reconcileGrid());
  persist();
  broadcast();
});

ipcMain.on('toggle-sidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  // The service view starts where the sidebar ends, so collapsing widens the video.
  viewManager.setSidebarWidth(sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH);
  config.settings.sidebarCollapsed = sidebarCollapsed;
  persist();
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

  // Drop its panes from the grid if it was tiled there — possibly several of them. A still-
  // populated grid just re-tiles; an emptied one falls through to single-view handling below.
  const wasGridded = gridPanes.some((p) => p.serviceId === serviceId);
  gridPanes = gridPanes.filter((p) => p.serviceId !== serviceId);
  if (gridMode && gridPanes.length) {
    const tiles = reconcileGrid();
    if (wasGridded) viewManager.showGrid(tiles);
  } else {
    gridMode = false;
    if (activeServiceId === serviceId || wasGridded) {
      activeServiceId = null;
      if (config.services[0]) switchService(config.services[0].id);
    }
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
ipcMain.on('open-settings-window', () => openSettingsWindow());

// Toggle ad blocking across every service session. Turning it on for the first time has to
// fetch the filter engine, which can fail (offline, upstream down) — setEnabled reports the
// state it actually reached rather than the one that was asked for, so the checkbox can
// snap back instead of lying.
ipcMain.handle('set-adblock', async (_e, on) => {
  const enabled = await adblocker.setEnabled(on);
  config.settings.adblock = enabled;
  persist();
  if (enabled) startAdblockStats();
  else stopAdblockStats();
  // Blocking only affects requests made from now on, so re-fetch what is already rendered.
  viewManager.reloadAll();
  broadcast();
  return adblocker.status();
});

// Turn blocking off for a single service while leaving it on everywhere else. This is the
// escape hatch when a filter rule breaks one site: it should cost you that site's blocking,
// not all of it.
ipcMain.handle('set-service-adblock', async (_e, serviceId, on) => {
  if (typeof serviceId !== 'string') return adblocker.status();
  await adblocker.setServiceEnabled(serviceId, on !== false);
  config.settings.adblockOff = adblocker.status().excluded;
  persist();
  const service = config.services.find((s) => s.id === serviceId);
  if (service) viewManager.reloadService(service); // blocking only affects new requests
  broadcast();
  return adblocker.status();
});

// Sign out of a service by wiping its cookies/storage/cache. Destructive and easy to hit by
// accident from a context menu, so confirm first and name the service being wiped.
ipcMain.handle('clear-service-data', async (_e, serviceId) => {
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return false;
  const r = await dialog.showMessageBox(baseWindow, {
    type: 'warning',
    message: `Sign out of ${service.name}?`,
    detail:
      `This clears ${service.name}'s cookies, storage and cache, so you will be signed out ` +
      'and it may ask you to verify this device again next time. Nothing else is affected.',
    buttons: ['Sign out', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r.response !== 0) return false;
  await viewManager.clearServiceData(service);
  return true;
});

// Pull fresh filter lists now. The fix for a site's new anti-adblock arrives as a list
// update, so waiting out the weekly refresh is not always acceptable.
ipcMain.handle('refresh-filters', async () => {
  const ok = await adblocker.refresh();
  if (ok) viewManager.reloadAll();
  broadcast();
  return adblocker.status();
});

ipcMain.handle('set-tray', (_e, on) => {
  config.settings.minimizeToTray = on === true;
  persist();
  applyTraySetting();
  broadcast();
  return config.settings.minimizeToTray;
});

ipcMain.handle('set-dim-while-playing', (_e, on) => {
  config.settings.dimWhilePlaying = on === true;
  persist();
  broadcast();
  return config.settings.dimWhilePlaying;
});

ipcMain.handle('set-enhance', (_e, key, on) => {
  // Round-trip through cleanEnhance so an unknown key from the UI cannot write itself into the
  // saved settings, and the stored object always has exactly the keys this build knows about.
  config.settings.enhance = cleanEnhance({ ...config.settings.enhance, [key]: on === true });
  persist();
  viewManager.setEnhance(config.settings.enhance);
  broadcast();
  return config.settings.enhance;
});

ipcMain.on('toggle-fullscreen', () => {
  baseWindow.setFullScreen(!baseWindow.isFullScreen());
});

ipcMain.on('reload-active', () => viewManager.reloadActive());
ipcMain.on('go-back', () => viewManager.goBack());

// Numeric version compare: is `latest` newer than `current`? (e.g. "0.2.0" > "0.1.0")
function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ---- Updates ----
// Whether electron-updater can install a new build in place, as opposed to only pointing the
// user at the download page.
//   * Windows: the packaged NSIS installer does the swap and relaunch itself.
//   * Linux: only the AppImage build can replace itself — it overwrites the file at $APPIMAGE,
//     which the AppImage runtime sets. Started any other way (`npm start`, an unpacked tree, a
//     distro package), there is nothing to swap.
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  return Boolean(process.env.APPIMAGE);
}

function openDownloadPage(url) {
  shell.openExternal(url || `https://github.com/${REPO}/releases/latest`);
}

// Ask GitHub what the newest release is, without downloading anything. Used for the
// fallback path, where we only need a version number and a page to send the user to.
async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StreamHub' },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const data = await res.json();
  return { version: String(data.tag_name || '').replace(/^v/, ''), url: data.html_url };
}

// electron-updater deletes the running AppImage and writes the new one beside it. It keeps
// the SAME path — so desktop entries, docks and pinned icons keep working — only when the
// current filename carries no version number; otherwise it names the new file after the new
// version, and every launcher the user set up points at a file that no longer exists. We
// ship "StreamHub.AppImage" (see build.artifactName) precisely to take the in-place branch.
//
// The one exception is a build still running under an older, versioned name: that update has
// to rename the file once. Detect it so we can say so up front rather than silently breaking
// their launchers again. See AppImageUpdater.doInstall in electron-updater.
function appImageWillBeRenamed() {
  const current = process.env.APPIMAGE;
  return Boolean(current) && /\d+\.\d+\.\d+/.test(path.basename(current));
}

// Ask whether a newer release exists, quietly: no dialogs, no download, and failures
// (offline, GitHub rate-limited, castLabs down) resolve to null rather than throwing. This
// runs unprompted in the background, so it must never interrupt the user — the only thing it
// is allowed to do is light up the sidebar button.
async function checkQuietly() {
  try {
    if (!canSelfUpdate()) {
      const latest = await fetchLatestRelease();
      return isNewerVersion(latest.version, APP_VERSION) ? latest.version : null;
    }
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo && result.updateInfo.version;
    return latest && isNewerVersion(latest, APP_VERSION) ? latest : null;
  } catch {
    return null; // a background check that cannot reach the network is not an error
  }
}

// autoDownload is off, so this only ever fetches release metadata — the ~130MB AppImage is
// still not touched until the user asks for it.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

async function pollForUpdate() {
  const latest = await checkQuietly();
  if (latest === pendingUpdate) return; // nothing changed; don't churn the UI
  pendingUpdate = latest;
  broadcast();
}

// Start the new AppImage once this process is gone.
//
// The obvious ways to do this — electron-updater's own run-after-install, or app.relaunch() —
// both launch the successor from inside a process that is about to disappear, and everything
// this process runs from (the Electron binary, its libraries) lives in the AppImage's mount
// under /tmp/.mount_*, which the runtime tears down the moment we exit. That race is why
// "Restart now" could leave the user with no app running at all.
//
// So the job goes to /bin/sh, which is a real file on the host and outlives us: it waits for
// our pid to disappear, then execs the new build. Its environment is stripped of the old
// mount's variables — they point into a directory that is about to stop existing — and the
// new AppImage's runtime sets its own on the way up.
function relaunchAfterExit(appImagePath) {
  const env = { ...process.env };
  for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) {
    delete env[key];
  }

  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"',
      'streamhub-relaunch', // $0
      String(process.pid), //  $1: wait for us to exit…
      appImagePath, //         $2: …then become the new build
    ],
    {
      detached: true, // its own session, so our exit doesn't take it down with us
      stdio: 'ignore',
      env,
      cwd: os.homedir(), // our cwd may itself be inside the mount that is about to go away
    },
  );
  child.unref();
}

// Download the new build, then restart into it. Progress goes to the update button so a
// 120MB download isn't a silently frozen UI.
async function downloadAndInstall(info) {
  autoUpdater.on('download-progress', (p) =>
    sendToUi('update-progress', Math.round(p.percent)),
  );

  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    sendToUi('update-progress', null);
    throw err;
  }
  sendToUi('update-progress', null);

  // Windows: hand off to the NSIS installer, which swaps the files and relaunches the app
  // itself, so none of the AppImage in-place / manual-relaunch handling below applies.
  if (process.platform === 'win32') {
    const r = await dialog.showMessageBox(uiParent(), {
      type: 'info',
      message: `StreamHub v${info.version} is ready`,
      detail: 'Restart now to finish updating?',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    // "Later" is safe: the download is cached and autoInstallOnAppQuit applies it on the next
    // real quit. isSilent: true runs the installer without its wizard; isForceRunAfter: true
    // relaunches the app once it finishes.
    if (r.response !== 0) return;
    autoUpdater.quitAndInstall(true, true);
    return;
  }

  const renamed = appImageWillBeRenamed();
  const r = await dialog.showMessageBox(uiParent(), {
    type: 'info',
    message: `StreamHub v${info.version} is ready`,
    detail: renamed
      ? 'Restart now to finish updating?\n\nThis update also drops the version number from ' +
        `the AppImage's filename (it becomes "StreamHub.AppImage"), so shortcuts and pinned ` +
        'icons will need pointing at it one last time. From then on the file keeps its name ' +
        'and path, and updates will no longer break them.'
      : 'Restart now to finish updating?',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  // "Later" is safe to take: the download is cached, and autoInstallOnAppQuit applies it the
  // next time the app is closed (without restarting into it, which is what "later" means).
  if (r.response !== 0) return;

  // isSilent: true — there is no installer UI to show on Linux; this just swaps the AppImage.
  // isForceRunAfter: false — we relaunch ourselves, below, rather than letting electron-updater
  // spawn the new build from this dying process.
  //
  // The swap is synchronous (the quit it triggers is not), so once this returns the new file
  // is on disk and we know its final path, including the one-off rename case.
  let installError = null;
  const onError = (err) => {
    installError = err;
  };
  autoUpdater.once('error', onError);
  autoUpdater.quitAndInstall(true, false);
  autoUpdater.off('error', onError);
  if (installError) throw installError; // no new build to restart into; offer the download page

  relaunchAfterExit(installedAppImage || process.env.APPIMAGE);
}

// Check for a newer release and, when we can, install it in place rather than making the
// user download it from a browser. Whatever this learns also settles the sidebar button's
// highlight: finding nothing must clear it, or it would keep flashing at an update the user
// has just been told they do not have.
ipcMain.handle('check-for-updates', async () => {
  const current = APP_VERSION;
  try {
    if (!canSelfUpdate()) {
      const latest = await fetchLatestRelease();
      const newer = Boolean(latest.version) && isNewerVersion(latest.version, current);
      pendingUpdate = newer ? latest.version : null;
      broadcast();
      if (newer) {
        const r = await dialog.showMessageBox(uiParent(), {
          type: 'info',
          message: `Update available: v${latest.version}`,
          detail:
            `You're on v${current}. This copy of StreamHub can't update itself, so the new ` +
            'build has to be downloaded manually.\n\nOpen the download page?',
          buttons: ['Download', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) openDownloadPage(latest.url);
        return { hasUpdate: true, latest: latest.version, current, selfUpdate: false };
      }
      dialog.showMessageBox(uiParent(), {
        type: 'info',
        message: "You're up to date",
        detail: `StreamHub v${current} is the latest version.`,
      });
      return { hasUpdate: false, latest: latest.version, current };
    }

    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const newer = Boolean(latest) && isNewerVersion(latest, current);
    pendingUpdate = newer ? latest : null;
    broadcast();
    if (!newer) {
      dialog.showMessageBox(uiParent(), {
        type: 'info',
        message: "You're up to date",
        detail: `StreamHub v${current} is the latest version.`,
      });
      return { hasUpdate: false, latest, current };
    }

    const r = await dialog.showMessageBox(uiParent(), {
      type: 'info',
      message: `Update available: v${latest}`,
      detail: `You're on v${current}. Download and install it now?`,
      buttons: ['Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) return { hasUpdate: true, latest, current, installing: false };

    await downloadAndInstall(result.updateInfo);
    return { hasUpdate: true, latest, current, installing: true };
  } catch (err) {
    // A failed self-update must not be a dead end (read-only AppImage path, no release
    // metadata, flaky network) — offer the browser download instead.
    const r = await dialog.showMessageBox(uiParent(), {
      type: 'error',
      message: 'Update failed',
      detail: `${err.message}\n\nOpen the download page instead?`,
      buttons: ['Open download page', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) openDownloadPage();
    return { error: err.message };
  }
});

// ---- App lifecycle ----
app.whenReady().then(async () => {
  // A losing instance has already called app.quit() above. Should it get here first anyway, stop
  // before Widevine, the config and the service views — none of the profile may be touched.
  if (!gotInstanceLock) return;
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
  sidebarCollapsed = config.settings.sidebarCollapsed === true;
  gridMode = config.gridMode === true;
  gridPanes = Array.isArray(config.gridPanes) ? config.gridPanes.slice(0, MAX_GRID_PANES) : [];
  gridLayout = GRID_LAYOUTS.includes(config.gridLayout) ? config.gridLayout : 'auto';

  // Restore the per-service exclusions before anything is attached, or a service the user
  // turned blocking off for would get the engine for the first page load and then lose it.
  adblocker.setExcluded(config.settings.adblockOff);

  // Bring the filter engine up *before* the first service view exists. Attaching it after
  // the window opens would race the first page load, letting exactly the requests we mean
  // to block through. Cached, this is a file read; on a first run it is a small download,
  // and if it fails the app still opens — just without blocking.
  if (config.settings.adblock) {
    const enabled = await adblocker.setEnabled(true);
    config.settings.adblock = enabled;
    if (enabled) startAdblockStats();
  }

  buildAppMenu();
  createWindow();
  // The view manager is built by createWindow, so its copy of the enhancement settings is seeded
  // here rather than at load. Injection happens per document load, which is still ahead.
  viewManager.setEnhance(cleanEnhance(config.settings.enhance));
  applyTraySetting();

  // System media controls. Electron gives us none on Linux, so serve MPRIS ourselves — the
  // hardware media keys already work (see shortcuts.js); this is what makes the *panel*,
  // the lock screen and the media applet show and drive what is playing. Absent (not fatal)
  // where there is no session bus.
  //
  // MPRIS is a Linux/D-Bus interface, so it only runs there. On Windows `mpris` stays null;
  // onPlaybackChange already no-ops when it is, and the hardware media keys still work through
  // shortcuts.js. (Windows' own SMTC overlay is a possible future addition, not wired here.)
  if (process.platform === 'linux') {
    mpris = new Mpris({
      playPause: () => viewManager.playPause(),
      seek: (seconds) => {
        const wc = viewManager.getActiveWebContents();
        if (wc) {
          wc.executeJavaScript(
            `(() => { const v = document.querySelector('video'); if (v) v.currentTime += ${seconds}; })()`,
          ).catch(() => {});
        }
      },
      raise: () => showWindow(),
      quit: () => {
        quitting = true;
        app.quit();
      },
    });
    mpris.start();
  }

  // The sidebar starts collapsed if that is how it was left, so the service view has to
  // start at the rail's edge rather than the full sidebar's.
  if (sidebarCollapsed) viewManager.setSidebarWidth(SIDEBAR_RAIL_WIDTH);

  // Restore a grid that was open at last quit. Reconcile the saved panes against the current
  // list first (a service removed since could have fallen out); if nothing survives, drop back
  // to single view and let the sidebar open the last-watched service as usual.
  if (gridMode) {
    // Set the arrangement before tiling, or the restored grid would lay out packed for a frame
    // and then jump into the layout the user actually chose.
    viewManager.setGridLayout(gridLayout);
    const tiles = reconcileGrid();
    if (tiles.length) viewManager.showGrid(tiles);
    else gridMode = false;
  }

  // Look for a new release in the background so the sidebar button can announce one instead
  // of the user having to think to go and ask. Deferred a little: startup is already busy
  // fetching Widevine, the filter engine and the first service, and nothing here is urgent.
  setTimeout(pollForUpdate, 10000);
  setInterval(pollForUpdate, UPDATE_POLL_MS);
});

app.on('window-all-closed', () => {
  // With "minimize to tray" on, closing the window only hides it, so this fires only on a
  // real quit. Without it, closing the window is quitting, as before.
  unregisterMediaKeys();
  app.quit();
});

// Any route to quitting (menu, Ctrl+Q, session logout) has to get past the close-to-tray
// handler, which only stands aside once this is set.
app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  unregisterMediaKeys();
  setPlaybackInhibitor(false); // never leave the display-sleep inhibitor held after we exit
  destroyTray();
  if (mpris) mpris.stop(); // drop the bus name, or the panel keeps a dead player around
});
