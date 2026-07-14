const path = require('path');
const { WebContentsView, session } = require('electron');
const {
  CHROME_UA,
  CHROME_MAJOR,
  CHROME_BRANDS,
  CHROME_FULL_VERSION_LIST,
} = require('./services');

// Rewrite the Sec-CH-* client-hint headers so the wire matches the Chrome UA the view
// presents. Only headers Chromium already decided to send are overwritten — adding ones
// it withheld (it omits them on insecure origins) would itself be an oddity. The JS-side
// half of this lives in service-preload.js.
function alignClientHints(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      switch (name.toLowerCase()) {
        case 'sec-ch-ua':
          headers[name] = CHROME_BRANDS;
          break;
        case 'sec-ch-ua-full-version-list':
          headers[name] = CHROME_FULL_VERSION_LIST;
          break;
        case 'sec-ch-ua-full-version':
          headers[name] = `"${CHROME_MAJOR}.0.0.0"`;
          break;
        case 'sec-ch-ua-platform':
          headers[name] = '"Linux"';
          break;
        case 'sec-ch-ua-mobile':
          headers[name] = '?0';
          break;
        default:
          break;
      }
    }
    callback({ requestHeaders: headers });
  });
}

// Schemes a service view is allowed to navigate to. Anything else (custom app-bridge
// schemes like sslocal:, intent:, tiktok:, … that ad/analytics SDKs on these sites poke
// at) is dropped: Chromium treats an unknown scheme as an *external protocol* and hands
// it to the OS handler, which on KDE opens a "Could not read file" KIO dialog per event.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'blob:', 'data:']);

function isNavigable(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// JS injected into the active service to toggle picture-in-picture on its <video>.
const PIP_JS = `(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find(x => !x.paused && x.readyState > 2) || vids.find(x => x.readyState > 2) || vids[0];
  if (!v) return 'no-video';
  if (document.pictureInPictureElement) { document.exitPictureInPicture(); return 'exit'; }
  if (document.pictureInPictureEnabled && !v.disablePictureInPicture) {
    v.requestPictureInPicture().catch(() => {});
    return 'enter';
  }
  return 'unsupported';
})()`;

// JS injected to play/pause the currently visible <video>.
const PLAYPAUSE_JS = `(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find(x => x.readyState > 2) || vids[0];
  if (!v) return 'no-video';
  v.paused ? v.play() : v.pause();
  return v.paused ? 'paused' : 'playing';
})()`;

// JS injected to pause every playing <video> on a page — run on the service being
// switched away from so it doesn't keep playing in the background. Returns true if it
// actually paused something, so we know whether to auto-resume on switch-back (a video
// the user had already paused returns false and is left alone).
const PAUSE_ALL_JS = `(() => {
  let paused = false;
  for (const v of document.querySelectorAll('video')) { if (!v.paused) { v.pause(); paused = true; } }
  return paused;
})()`;

// JS injected to resume the main <video> when returning to a service we auto-paused.
const RESUME_JS = `(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find(x => x.readyState > 2) || vids[0];
  if (v) { const r = v.play(); if (r && r.catch) r.catch(() => {}); }
})()`;

/**
 * Owns one WebContentsView per service and manages which one is attached/visible in the
 * window. The app-chrome view (sidebar) sits underneath and is always visible on the
 * left; the active service view covers the area to its right.
 */
class ViewManager {
  constructor(baseWindow, sidebarWidth) {
    this.win = baseWindow;
    this.sidebarWidth = sidebarWidth;
    this.views = new Map(); // serviceId -> WebContentsView
    this.active = null;
    this.autoPaused = new Set(); // views we paused on switch-away, to resume on return
    this.videoFullscreen = false;
    this.bounds = { width: 0, height: 0 };
  }

  // The "@default" suffix is a leftover from a removed multi-profile feature. It is
  // kept because it names the on-disk partition holding every service's cookies:
  // renaming it would hand each site an empty cookie jar, logging the user out and
  // making them re-verify this machine as a new device.
  key(serviceId) {
    return `${serviceId}@default`;
  }

  ensureView(service) {
    const key = this.key(service.id);
    const existing = this.views.get(key);
    if (existing) return existing;

    const partition = `persist:${key}`;
    // Set the spoofed UA at the session level so sub-resource requests match too.
    const ses = session.fromPartition(partition);
    ses.setUserAgent(CHROME_UA);
    alignClientHints(ses);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        // The only preload on a service view: it makes navigator.userAgentData match
        // CHROME_UA (see service-preload.js). It bridges nothing to the page, so these
        // untrusted remote sites stay isolated; they are still driven from the main
        // process via executeJavaScript.
        preload: path.join(__dirname, 'service-preload.js'),
        additionalArguments: [`--lvs-chrome-major=${CHROME_MAJOR}`],
      },
    });

    const wc = view.webContents;
    wc.setUserAgent(CHROME_UA);

    // Let genuine popups open as real child windows so window.opener/postMessage-based
    // sign-in ("Sign in with Google/Apple", etc.) works — loading them in-place would
    // sever the opener and break the flow. The child carries the same session partition
    // and Chrome identity (UA + client hints via the shared session, userAgentData via
    // the preload), so the popup looks like the same browser. Non-web schemes are denied.
    wc.setWindowOpenHandler(({ url }) => {
      if (!isNavigable(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            partition,
            preload: path.join(__dirname, 'service-preload.js'),
            additionalArguments: [`--lvs-chrome-major=${CHROME_MAJOR}`],
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    });

    // Drop navigations to non-web schemes, in any frame, before Chromium can punt them
    // to the OS external-protocol handler. See ALLOWED_PROTOCOLS above.
    wc.on('will-frame-navigate', (details) => {
      if (!isNavigable(details.url)) details.preventDefault();
    });

    // When a site enters/exits HTML5 fullscreen, let the service view own the whole
    // window (hiding the sidebar) and put the OS window into fullscreen too.
    wc.on('enter-html-full-screen', () => this.setVideoFullscreen(true));
    wc.on('leave-html-full-screen', () => this.setVideoFullscreen(false));

    view.setVisible(false);
    this.win.contentView.addChildView(view);
    wc.loadURL(service.url);

    this.views.set(key, view);
    return view;
  }

  show(service) {
    const view = this.ensureView(service);
    if (this.active && this.active !== view) {
      this.pauseView(this.active); // stop the outgoing service playing in the background
      this.active.setVisible(false);
    }
    this.active = view;
    view.setVisible(true);
    // Re-adding an existing child view moves it to the top of the stacking order.
    this.win.contentView.addChildView(view);
    this.layout(this.bounds.width, this.bounds.height);
    // Resume playback only if we were the ones who paused it on a previous switch-away.
    if (this.autoPaused.has(view)) {
      this.autoPaused.delete(view);
      this.resumeView(view);
    }
    return view;
  }

  layout(width, height) {
    this.bounds = { width, height };
    if (!this.active || !width || !height) return;
    if (this.videoFullscreen) {
      this.active.setBounds({ x: 0, y: 0, width, height });
    } else {
      const x = this.sidebarWidth;
      this.active.setBounds({ x, y: 0, width: Math.max(0, width - x), height });
    }
  }

  setSidebarWidth(width) {
    this.sidebarWidth = width;
    this.layout(this.bounds.width, this.bounds.height);
  }

  // Tear down a service's view when it is removed from the list. The persistent
  // partition (its cookies/login) stays on disk, so re-adding the service later
  // recreates the view already signed in.
  destroyView(serviceId) {
    const key = this.key(serviceId);
    const view = this.views.get(key);
    if (!view) return;
    if (this.active === view) this.active = null;
    this.autoPaused.delete(view);
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(key);
  }

  setVideoFullscreen(on) {
    this.videoFullscreen = on;
    if (this.win.setFullScreen) this.win.setFullScreen(on);
    this.layout(this.bounds.width, this.bounds.height);
  }

  getActiveWebContents() {
    return this.active ? this.active.webContents : null;
  }

  pauseView(view) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(PAUSE_ALL_JS)
      .then((paused) => {
        if (paused) this.autoPaused.add(view);
      })
      .catch(() => {});
  }

  resumeView(view) {
    const wc = view && view.webContents;
    if (wc && !wc.isDestroyed()) wc.executeJavaScript(RESUME_JS).catch(() => {});
  }

  togglePip() {
    const wc = this.getActiveWebContents();
    if (wc) wc.executeJavaScript(PIP_JS).catch(() => {});
  }

  playPause() {
    const wc = this.getActiveWebContents();
    if (wc) wc.executeJavaScript(PLAYPAUSE_JS).catch(() => {});
  }

  reloadActive() {
    const wc = this.getActiveWebContents();
    if (wc) wc.reload();
  }

  goBack() {
    const wc = this.getActiveWebContents();
    if (wc && wc.navigationHistory && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    } else if (wc && wc.canGoBack && wc.canGoBack()) {
      wc.goBack();
    }
  }
}

module.exports = { ViewManager };
