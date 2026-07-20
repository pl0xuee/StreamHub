const path = require('path');
const { WebContentsView, session } = require('electron');
const {
  CHROME_UA,
  CHROME_MAJOR,
  CHROME_BRANDS,
  CHROME_FULL_VERSION_LIST,
  FIREFOX_UA,
  CH_PLATFORM,
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
          headers[name] = `"${CH_PLATFORM}"`;
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
// A video the site itself put into picture-in-picture is deliberately left running: it is
// floating on the user's desktop, in plain sight, which is the point of having put it there.
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

// A thin dark gutter between grid panes, so tiled services read as separate rather than
// bleeding into one another. The window's background colour shows through it.
const GRID_GAP = 6;

// How the panes are arranged. 'auto' packs them into a square-ish block; 'rows' stacks them all
// vertically (two panes become one above the other, which suits two 16:9 videos far better than
// two half-width columns); 'columns' lays them all out side by side.
const GRID_LAYOUTS = ['auto', 'rows', 'columns'];

// Split `total` pixels into n integer spans separated by `gap`. The last span absorbs the
// rounding remainder, so the panes always meet the far edge exactly rather than leaving a
// stray pixel of background showing.
function splitSpans(total, n, gap) {
  const avail = Math.max(0, total - gap * (n - 1));
  const base = Math.floor(avail / n);
  const spans = [];
  for (let i = 0; i < n; i += 1) spans.push(i === n - 1 ? avail - base * (n - 1) : base);
  return spans;
}

// Lay n panes out along one axis: stacked top-to-bottom ('rows') or left-to-right ('columns').
function stripRects(n, x, y, w, h, gap, vertical) {
  const spans = splitSpans(vertical ? h : w, n, gap);
  const rects = [];
  let offset = 0;
  for (const span of spans) {
    rects.push(
      vertical
        ? { x, y: y + offset, width: w, height: span }
        : { x: x + offset, y, width: span, height: h },
    );
    offset += span + gap;
  }
  return rects;
}

// Rectangles for tiling n views (1–4) inside the area (x, y, w, h), left-to-right, top-to-
// bottom. Under 'auto': two columns once there is more than one pane, and three panes put the
// odd one across the full bottom row rather than leaving a hole. Integer pixels, since
// setBounds wants them.
function gridRects(n, x, y, w, h, gap, layout = 'auto') {
  if (n === 1) return [{ x, y, width: w, height: h }];
  if (layout === 'rows') return stripRects(n, x, y, w, h, gap, true);
  if (layout === 'columns') return stripRects(n, x, y, w, h, gap, false);
  const leftW = Math.floor((w - gap) / 2);
  const rightW = w - gap - leftW; // absorbs the rounding remainder, so the panes meet exactly
  const topH = Math.floor((h - gap) / 2);
  const botH = h - gap - topH;
  const x2 = x + leftW + gap;
  const y2 = y + topH + gap;
  switch (n) {
    case 2:
      return [
        { x, y, width: leftW, height: h },
        { x: x2, y, width: rightW, height: h },
      ];
    case 3:
      return [
        { x, y, width: leftW, height: topH },
        { x: x2, y, width: rightW, height: topH },
        { x, y: y2, width: w, height: botH },
      ];
    default: // 4 (callers cap the grid at four)
      return [
        { x, y, width: leftW, height: topH },
        { x: x2, y, width: rightW, height: topH },
        { x, y: y2, width: leftW, height: botH },
        { x: x2, y: y2, width: rightW, height: botH },
      ];
  }
}

/**
 * Owns one WebContentsView per *pane* and manages which one(s) are attached/visible in the
 * window. The app-chrome view (sidebar) sits underneath and is always visible on the left; the
 * visible service view(s) cover the area to its right — one filling it in single mode, or up to
 * four tiled in a grid. `active` is the primary pane that single-target controls (media keys,
 * back/reload) act on.
 *
 * A pane is not the same thing as a service: the grid may tile one service more than once (two
 * Twitch streams, say), and each such tile needs its own WebContentsView browsing independently.
 * So `views` is keyed by *view key* — the service id for the single-mode view, or a pane id for
 * an extra grid tile — while the session partition is still derived from the service id alone.
 * Every pane of a service therefore shares one cookie jar, and so one login.
 */
class ViewManager {
  constructor(baseWindow, sidebarWidth) {
    this.win = baseWindow;
    this.sidebarWidth = sidebarWidth;
    this.views = new Map(); // viewKey -> WebContentsView
    this.active = null; // primary pane, for single-target controls (media keys, back)
    this.visible = new Set(); // every view currently shown — one in single mode, up to four in a grid
    this.grid = []; // ordered views when tiling more than one; empty in single mode
    this.gridLayout = 'auto'; // how those panes are arranged — see GRID_LAYOUTS
    this.fullscreenView = null; // the pane a site took HTML-fullscreen, so it alone covers the window
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

  // `viewKey` names the pane: the plain service id for the single-mode view, or a pane id for an
  // extra grid tile of the same service. The partition below is keyed off service.id regardless,
  // so extra panes open already signed in and share the one login.
  ensureView(service, viewKey = service.id) {
    const existing = this.views.get(viewKey);
    if (existing) return existing;

    const partition = `persist:${this.key(service.id)}`;
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
    wc.on('enter-html-full-screen', () => this.setVideoFullscreen(true, view));
    wc.on('leave-html-full-screen', () => this.setVideoFullscreen(false, view));

    // Blocked requests only identify the webContents that made them, so tie this one to its
    // service to be able to count them per service.
    adblocker.bindWebContents(wc.id, service.id);

    // Chromium tells us when media actually starts and stops, which is what the screen-sleep
    // inhibitor keys off — far better than polling the page for a playing <video>. Note both
    // fire for muted/looping decorative video too; the inhibitor treats any playback as
    // reason enough to keep the display on, which is the safe way round.
    wc.on('media-started-playing', () => {
      this.onMediaChange(view, true);
      // Only a view that is not on screen gets put back to sleep. A visible pane is meant to
      // play — that includes every pane of a grid, not just the primary one.
      if (!this.visible.has(view)) this.enforcePaused(view);
    });
    wc.on('media-paused', () => this.onMediaChange(view, false));

    view.setVisible(false);
    this.win.contentView.addChildView(view);
    wc.loadURL(service.url);

    // Remember what this view is, so the service-wide operations below (destroy on removal,
    // sign-out, reload-on-adblock-change) can find every pane belonging to one service.
    view.__serviceId = service.id;
    view.__viewKey = viewKey;
    this.views.set(viewKey, view);
    return view;
  }

  // Every live view of one service — normally just the single-mode view, but more when the grid
  // is tiling that service several times.
  viewsForService(serviceId) {
    return Array.from(this.views.values()).filter((v) => v.__serviceId === serviceId);
  }

  // Make exactly `views` visible, with `primary` as the active pane. Anything currently shown
  // that is not in the new set is paused and hidden; anything entering is shown, brought to the
  // top of the stack, and resumed if it was one we auto-paused earlier. This is the single point
  // both single-view (one view) and grid (up to four) go through, so the two can never disagree
  // about what is on screen.
  setVisibleSet(views, primary) {
    const next = new Set(views);
    for (const v of this.visible) {
      if (!next.has(v)) {
        this.pauseView(v); // stop it playing in the background
        v.setVisible(false);
      }
    }
    for (const v of views) {
      v.setVisible(true);
      // Re-adding an existing child view moves it to the top of the stacking order, above the
      // sidebar chrome; grid panes do not overlap, so their order among themselves is moot.
      this.win.contentView.addChildView(v);
      if (this.autoPaused.has(v)) {
        this.autoPaused.delete(v);
        this.resumeView(v);
      }
    }
    this.visible = next;
    // An extra pane's view exists only to fill a grid tile, so once it is off screen — the tile
    // was closed, or the grid was left entirely — nothing can ever bring it back, and it would
    // otherwise sit there invisibly holding a stream open. Free it. A service's single-mode view
    // is deliberately kept when hidden: switching back to it should stay instant, as it always has.
    for (const v of this.views.values()) {
      if (v.__viewKey !== v.__serviceId && !next.has(v)) this.destroyByKey(v.__viewKey);
    }
    this.grid = views.length > 1 ? views.slice() : [];
    this.active = primary || views[0] || null;
    // Leaving grid mode drops any lingering per-pane fullscreen so the single view lays out normally.
    if (this.videoFullscreen && !next.has(this.fullscreenView)) {
      this.videoFullscreen = false;
      this.fullscreenView = null;
    }
    this.layout(this.bounds.width, this.bounds.height);
  }

  show(service) {
    const view = this.ensureView(service);
    this.setVisibleSet([view], view);
    return view;
  }

  // Tile up to four panes at once, each `{ paneId, service }`. The same service may appear in
  // more than one pane; each gets its own view (and so browses independently) while sharing the
  // service's session. All panes stay live (and, by design, audible); the primary pane — the
  // first — is what single-target controls act on.
  showGrid(panes) {
    // A pane id doubles as its view key. main.js gives a service's first pane the bare service
    // id, so that tile reuses the single-mode view (and the page already loaded in it); extra
    // tiles carry a suffixed id and so get views of their own.
    const views = panes.slice(0, 4).map((p) => this.ensureView(p.service, p.paneId));
    this.setVisibleSet(views, views[0]);
  }

  layout(width, height) {
    this.bounds = { width, height };
    if (!width || !height) return;
    // A site in HTML fullscreen owns the whole window, sidebar included — even mid-grid, where
    // its pane covers the others (which keep playing underneath).
    if (this.videoFullscreen && this.fullscreenView) {
      this.fullscreenView.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const x = this.sidebarWidth;
    const areaW = Math.max(0, width - x);
    const views = this.grid.length ? this.grid : this.active ? [this.active] : [];
    if (!views.length) return;
    const rects = gridRects(views.length, x, 0, areaW, height, GRID_GAP, this.gridLayout);
    views.forEach((v, i) => v.setBounds(rects[i]));
  }

  // Re-tile the existing panes in a different arrangement. Nothing is reloaded — only the bounds
  // change — so switching layout mid-stream does not interrupt playback.
  setGridLayout(layout) {
    this.gridLayout = GRID_LAYOUTS.includes(layout) ? layout : 'auto';
    this.layout(this.bounds.width, this.bounds.height);
  }

  setSidebarWidth(width) {
    this.sidebarWidth = width;
    this.layout(this.bounds.width, this.bounds.height);
  }

  // Tear down every view of a service when it is removed from the list — it may hold several
  // grid panes, not just one. The persistent partition (its cookies/login) stays on disk, so
  // re-adding the service later recreates the view already signed in.
  destroyView(serviceId) {
    for (const view of this.viewsForService(serviceId)) this.destroyByKey(view.__viewKey);
  }

  // Tear down one pane's view.
  destroyByKey(key) {
    const view = this.views.get(key);
    if (!view) return;
    if (this.active === view) this.active = null;
    if (this.fullscreenView === view) {
      this.fullscreenView = null;
      this.videoFullscreen = false;
    }
    this.visible.delete(view);
    this.grid = this.grid.filter((v) => v !== view);
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
    // Every pane of this service shared the cookie jar we just wiped, so every one of them has
    // to go back to the front door — leaving a sibling pane on a signed-in page would be showing
    // a session that no longer exists.
    for (const view of this.viewsForService(service.id)) {
      if (!view.webContents.isDestroyed()) view.webContents.loadURL(service.url);
    }
  }

  setVideoFullscreen(on, view) {
    // Ignore a stale "leave" from a pane that is not the one currently filling the screen — in a
    // grid, several panes can fire these, and only the one that took over should end it.
    if (!on && this.fullscreenView && view && view !== this.fullscreenView) return;
    this.videoFullscreen = on;
    this.fullscreenView = on ? view || this.active : null;
    // Bring the fullscreen pane to the top so it covers its grid neighbours while it owns the window.
    if (on && this.fullscreenView) this.win.contentView.addChildView(this.fullscreenView);
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

  playPause() {
    const wc = this.getActiveWebContents();
    if (wc) wc.executeJavaScript(PLAYPAUSE_JS).catch(() => {});
  }

  reloadActive() {
    const wc = this.getActiveWebContents();
    if (wc) wc.reload();
  }

  // Reload a service's live views — used when its ad-blocking setting changes, which applies to
  // the whole session and so to every pane showing it.
  reloadService(service) {
    for (const view of this.viewsForService(service.id)) {
      const wc = view.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    }
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

module.exports = { ViewManager, GRID_LAYOUTS };
