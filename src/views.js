const path = require('path');
const { WebContentsView, session } = require('electron');
const {
  CHROME_UA,
  CHROME_MAJOR,
  CHROME_BRANDS,
  CHROME_FULL_VERSION_LIST,
  FIREFOX_UA,
  isGoogleAuthHost,
} = require('./services');
const { adblocker } = require('./adblock');

// Rewrite the Sec-CH-* client-hint headers so the wire matches the Chrome UA the view
// presents. Only headers Chromium already decided to send are overwritten — adding ones
// it withheld (it omits them on insecure origins) would itself be an oddity. The JS-side
// half of this lives in service-preload.js.
function alignClientHints(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;

    // On Google's sign-in host we masquerade as Firefox (see services.js): send the Firefox
    // UA and drop every Sec-CH-UA* client hint, since Firefox emits none. The JS-visible half
    // of this identity (navigator.userAgent / userAgentData) is handled in service-preload.js.
    let host = '';
    try {
      host = new URL(details.url).hostname;
    } catch {
      // Non-URL request target (unusual); fall through to the Chrome path.
    }
    if (isGoogleAuthHost(host)) {
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'user-agent') headers[name] = FIREFOX_UA;
        else if (lower.startsWith('sec-ch-ua')) delete headers[name];
      }
      callback({ requestHeaders: headers });
      return;
    }

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

// JS injected to pause every playing <video>/<audio> on a page — run on the service being
// switched away from so it doesn't keep playing in the background. Each element we stop is
// marked, so RESUME_JS can later restart exactly those and leave alone anything the user
// had already paused. Returns true if it actually paused something.
//
// A picture-in-picture video is deliberately left running: it is floating on the user's
// desktop, in plain sight, which is the whole point of having put it there.
const PAUSE_ALL_JS = `(() => {
  let paused = false;
  for (const m of document.querySelectorAll('video, audio')) {
    if (m.paused || m.ended || m === document.pictureInPictureElement) continue;
    m.pause();
    m.__streamhubAutoPaused = true;
    paused = true;
  }
  return paused;
})()`;

// JS injected when returning to a service we auto-paused: restart just the elements
// PAUSE_ALL_JS stopped, so a background trailer we never played doesn't spring to life.
const RESUME_JS = `(() => {
  for (const m of document.querySelectorAll('video, audio')) {
    if (!m.__streamhubAutoPaused) continue;
    m.__streamhubAutoPaused = false;
    const r = m.play();
    if (r && r.catch) r.catch(() => {});
  }
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
    this.playing = new Set(); // views with media playing, for the screen-sleep inhibitor
    this.onPlaybackChange = () => {}; // set by main.js
  }

  // Track which views are playing and tell main.js when that set becomes empty or non-empty,
  // so it can hold or release the display-sleep inhibitor.
  onMediaChange(view, isPlaying) {
    const before = this.playing.size > 0;
    if (isPlaying) this.playing.add(view);
    else this.playing.delete(view);
    const after = this.playing.size > 0;
    if (before !== after) this.onPlaybackChange(after);
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
    // Every service has its own session, so the ad blocker has to be attached to each one.
    // This is a no-op while blocking is off for this service; turning it on later reaches
    // back through the sessions registered here.
    adblocker.register(ses, service.id);

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

    // Blocked requests only identify the webContents that made them, so tie this one to its
    // service to be able to count them per service.
    adblocker.bindWebContents(wc.id, service.id);

    // Chromium tells us when media actually starts and stops, which is what the screen-sleep
    // inhibitor keys off — far better than polling the page for a playing <video>. Note both
    // fire for muted/looping decorative video too; the inhibitor treats any playback as
    // reason enough to keep the display on, which is the safe way round.
    wc.on('media-started-playing', () => {
      this.onMediaChange(view, true);
      if (view !== this.active) this.enforcePaused(view);
    });
    wc.on('media-paused', () => this.onMediaChange(view, false));

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
    // A destroyed view cannot report that it stopped playing, so drop it from the playing
    // set by hand or the display-sleep inhibitor would be held forever.
    this.onMediaChange(view, false);
    if (!view.webContents.isDestroyed()) adblocker.unbindWebContents(view.webContents.id);
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(key);
  }

  // Sign out of a service: wipe its cookies, storage and cache, then reload it so the site
  // comes back logged out. The partition itself stays (it is what makes the service's data
  // separate); only its contents go.
  async clearServiceData(service) {
    const ses = session.fromPartition(`persist:${this.key(service.id)}`);
    await ses.clearStorageData(); // cookies, localStorage, IndexedDB, service workers…
    await ses.clearCache();
    const view = this.views.get(this.key(service.id));
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.loadURL(service.url); // back to the front door, signed out
    }
  }

  setVideoFullscreen(on) {
    this.videoFullscreen = on;
    if (this.win.setFullScreen) this.win.setFullScreen(on);
    this.layout(this.bounds.width, this.bounds.height);
  }

  getActiveWebContents() {
    return this.active ? this.active.webContents : null;
  }

  // Run a snippet in every frame of a view, not just the top one: several services play
  // inside a cross-origin <iframe>, and webContents.executeJavaScript only ever reaches the
  // main frame. Resolves to one result per frame; a frame that has gone away yields
  // undefined rather than rejecting the batch.
  eachFrame(wc, code) {
    if (!wc || wc.isDestroyed()) return Promise.resolve([]);
    let frames;
    try {
      frames = wc.mainFrame.framesInSubtree; // includes the main frame itself
    } catch {
      return Promise.resolve([]);
    }
    return Promise.all(frames.map((f) => f.executeJavaScript(code).catch(() => undefined)));
  }

  pauseView(view) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.eachFrame(wc, PAUSE_ALL_JS)
      .then((results) => {
        if (!results.some(Boolean)) return; // nothing was playing; nothing to restore
        // Injection is async, so the user can be back on this service by the time it lands.
        // Undo it rather than leaving them looking at a video we paused behind their back.
        if (this.active === view) this.resumeView(view);
        else this.autoPaused.add(view);
      })
      .catch(() => {});
  }

  resumeView(view) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.eachFrame(wc, RESUME_JS).catch(() => {});
  }

  // A service we left can start playing without us: an autoplaying trailer on its home
  // page, or a player that quietly resumes itself after our pause. Chromium tells us the
  // moment any media starts, so put a background view straight back to sleep. It is not
  // recorded as auto-paused — we never chose to play it, so there is nothing to resume.
  enforcePaused(view) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.eachFrame(wc, PAUSE_ALL_JS).catch(() => {});
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

  // Reload one service, if it has a live view — used when its ad-blocking setting changes.
  reloadService(service) {
    const view = this.views.get(this.key(service.id));
    const wc = view && view.webContents;
    if (wc && !wc.isDestroyed()) wc.reload();
  }

  // Reload every live service. Toggling the ad blocker only changes how *new* requests are
  // handled, so already-rendered pages have to be re-fetched for it to take effect either
  // way. Views are created lazily, so this only touches services actually visited.
  reloadAll() {
    for (const view of this.views.values()) {
      const wc = view.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    }
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
