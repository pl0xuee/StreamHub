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
  Tray,
  nativeImage,
  powerSaveBlocker,
  shell,
} = require('electron');

const { autoUpdater } = require('electron-updater');

const configStore = require('./config');
const { ViewManager } = require('./views');
const { adblocker } = require('./adblock');
const { registerMediaKeys, unregisterMediaKeys } = require('./shortcuts');

// Updates are always user-initiated (the sidebar's "Check for updates" button), so never
// download in the background — decide first, then fetch.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

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
let config = { services: [], removed: [], settings: {} }; // the user's list, loaded from userData
let activeServiceId = null;
let sidebarCollapsed = false;
let adblockStatsTimer = null;
let pendingUpdate = null; // version string of a newer release we already know about, else null
let tray = null;
let quitting = false; // distinguishes a real quit from a close-to-tray
let sleepBlockerId = null; // powerSaveBlocker id held while something is playing
let saveWindowTimer = null;

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
    if (chromeView && !chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send('adblock-stats', blocked);
    }
  }, 2000);
}

function stopAdblockStats() {
  clearInterval(adblockStatsTimer);
  adblockStatsTimer = null;
}

function switchService(serviceId) {
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return;
  activeServiceId = serviceId;
  // Reopen on this service next launch rather than always landing on the first one.
  if (config.lastServiceId !== serviceId) {
    config.lastServiceId = serviceId;
    persist();
  }
  viewManager.show(service);
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
    backgroundColor: '#0b0d10',
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
  // Keep the display awake whenever any service is playing (see setPlaybackInhibitor).
  viewManager.onPlaybackChange = setPlaybackInhibitor;

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
    backgroundColor: '#0b0d10',
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

ipcMain.on('toggle-fullscreen', () => {
  baseWindow.setFullScreen(!baseWindow.isFullScreen());
});

ipcMain.on('toggle-pip', () => viewManager.togglePip());
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
// electron-updater can only swap the binary in place when we're running as the AppImage:
// it replaces the file at $APPIMAGE, which the AppImage runtime sets. Started any other way
// (`npm start`, an unpacked tree, a distro package), there is nothing to swap, so we fall
// back to sending the user to the download page.
function canSelfUpdate() {
  return app.isPackaged && Boolean(process.env.APPIMAGE);
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

// Download the new AppImage in place, then restart into it. Progress goes to the sidebar
// button so a 120MB download isn't a silently frozen UI.
async function downloadAndInstall(info) {
  const send = (channel, payload) => {
    if (chromeView && !chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(channel, payload);
    }
  };

  autoUpdater.on('download-progress', (p) => send('update-progress', Math.round(p.percent)));

  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    send('update-progress', null);
    throw err;
  }
  send('update-progress', null);

  const renamed = appImageWillBeRenamed();
  const r = await dialog.showMessageBox(baseWindow, {
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
  // isSilent: true — there is no installer to show on Linux; this just swaps the AppImage.
  // Deferring is safe: the download is cached and applies on the next quit.
  if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
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
        const r = await dialog.showMessageBox(baseWindow, {
          type: 'info',
          message: `Update available: v${latest.version}`,
          detail:
            `You're on v${current}. StreamHub can only update itself when run as the ` +
            'AppImage, so this build has to be downloaded manually.\n\nOpen the download page?',
          buttons: ['Download', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) openDownloadPage(latest.url);
        return { hasUpdate: true, latest: latest.version, current, selfUpdate: false };
      }
      dialog.showMessageBox(baseWindow, {
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
      dialog.showMessageBox(baseWindow, {
        type: 'info',
        message: "You're up to date",
        detail: `StreamHub v${current} is the latest version.`,
      });
      return { hasUpdate: false, latest, current };
    }

    const r = await dialog.showMessageBox(baseWindow, {
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
    const r = await dialog.showMessageBox(baseWindow, {
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
  applyTraySetting();

  // The sidebar starts collapsed if that is how it was left, so the service view has to
  // start at the rail's edge rather than the full sidebar's.
  if (sidebarCollapsed) viewManager.setSidebarWidth(SIDEBAR_RAIL_WIDTH);

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
});
