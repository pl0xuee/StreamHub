// The Jellyfin player: an mpv process and the window it draws into.
//
// Playing is a mode, not a panel. While it is on, an opaque child window covers the content
// area and mpv owns everything inside it — the picture, the controls, the keyboard. While it
// is off, the window is hidden and jellyfin-web is exactly where it was, still on the page the
// user pressed play from.
//
// Why a window of its own, rather than reparenting mpv into the main window: mpv's X11 surface
// and Chromium's are siblings there, and nothing orders siblings — measured, the page won about
// three runs in four, at random. A child window is reliably above its parent's web content, so
// giving mpv one removes the question entirely. The same measurements killed the original idea
// of floating StreamHub's glass chrome over the video: no transparent Electron window can be
// got above mpv, by parenting, always-on-top or window type. mpv's own OSC can, because it is
// drawn inside mpv's window, which is why the controls are its and not ours.
//
// So the chrome cannot float over the film — but it does not have to leave either. The video
// steps aside for it instead: the host window starts where the sidebar ends, and follows it as it
// slides out and back (see `insetLeft`). Only when mpv itself has taken the screen does the chrome
// go, on the same reasoning the app already applies to a site going fullscreen.
const { BrowserWindow, screen } = require('electron');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { Mpv, isAvailable } = require('./mpv');

// How often to tell the server where we are. Jellyfin's own clients report every ten seconds;
// more often is just traffic, less and a crash loses the resume point.
const PROGRESS_INTERVAL_MS = 10000;
// How often to tell the *page*. It is in the same process tree and it reads the position out of
// its own mirror the moment anything asks — so this is what the resume point is rounded to.
const PAGE_TICK_MS = 1000;

// What the host window is called, so it can be told apart from the app's own window — on Hyprland
// both are class "streamhub" and belong to the same process. See undecorateHost().
const HOST_TITLE = 'StreamHub Player';

// The window properties Hyprland is asked to drop from the host, as [name, value].
//
// Hyprland floats the host — it is transient for the main window — and decorates it the way it
// decorates any window: a border, rounded corners, a shadow. Around a picture that is meant to be
// part of the app, that reads as a second window sitting inside the first, and in fullscreen it
// keeps the film off the edges of the screen, with the wallpaper showing in the rounded corners.
// It is animated like any window as well, so as the sidebar slides out the picture trails behind
// it instead of moving with it.
const HOST_HYPRLAND_PROPS = [
  ['border_size', '0'],
  ['rounding', '0'],
  ['decorate', '0'],
  ['no_anim', '1'],
];

// Run hyprctl, resolving to its output or null. Never rejects: failing to undecorate the window
// costs a border, not the film.
function hyprctl(args) {
  return new Promise((resolve) => {
    execFile('hyprctl', args, { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

/**
 * Owns the host window and the mpv talking to it.
 *
 * Emits:
 *   'active'   (bool)                 — playback started / finished, for the chrome and the
 *                                       sleep inhibitor
 *   'position' ({ positionSeconds, durationSeconds, paused }) — every second, for the page
 *   'progress' (same)                 — every ten seconds, for the server
 *   'finished' (reason)               — an item ended; 'eof' means it played to the end
 *   'fullscreen' (bool)               — mpv took the screen, or gave it back
 *   'error'    (Error)
 */
class Player extends EventEmitter {
  /**
   * `paneBounds` is asked, on every layout, where the Jellyfin view currently sits inside the
   * window — as `{x, y, width, height}` relative to the content area, or null for "all of it".
   *
   * It is a callback rather than a value because the answer changes without the player being
   * told: the grid re-tiles when a pane is added, removed or dragged. Asking at layout time is
   * what keeps the video inside its own tile instead of covering the other services.
   *
   * `insetLeft` is asked the same way, for how much of the window's left edge the app's chrome is
   * holding — the strip while the sidebar is stowed, the whole sidebar while it is out. Nothing can
   * be drawn over mpv, so the video starts where that ends; that is what leaves the sidebar
   * reachable while a film plays.
   */
  constructor({ baseWindow, paneBounds, insetLeft, hwdec }) {
    super();
    this.baseWindow = baseWindow;
    this.hwdec = hwdec !== false;
    this.paneBounds = typeof paneBounds === 'function' ? paneBounds : () => null;
    this.insetLeft = typeof insetLeft === 'function' ? insetLeft : () => 0;
    // Why the video is off screen while still loaded, if it is: something the app has to show
    // over it (a sheet, the quick switch), the user having switched to another service, or a site
    // in another grid pane having gone fullscreen. Kept as a set of reasons rather than a flag so
    // that one of them ending cannot put the video back while another still holds.
    this.hiddenFor = new Set();
    // Whether we paused the film when the user switched away, so coming back resumes exactly
    // that and not a film they had paused themselves.
    this.autoPaused = false;
    // Whether mpv asked for the screen (its button, or 'f'). Distinct from the window merely being
    // fullscreen: F11 on a grid fullscreens the grid, with the film staying in its tile, while
    // mpv's own fullscreen means the film and nothing else.
    this.ownsFullscreen = false;
    this.host = null;
    this.mpv = null;
    this.current = null; // what is playing, for the progress reports
    this.progressTimer = null;
    this.tickTimer = null;
    this.state = { positionSeconds: 0, durationSeconds: 0, paused: false };
    // Stream selection asked for before the file was open; applied on 'file-loaded'.
    this.pendingTracks = null;
    // How much larger the real window turns out to be than the size we ask for. See calibrate().
    this.frameInset = { w: 0, h: 0 };
    // Held while a measurement is in flight, so two cannot correct for the same margin.
    this.calibrating = false;
    // Whether the video can go inside the app's own window. null until the first play
    // settles it; false on Wayland, where mpv gets a window of its own instead.
    this.embedded = null;
    this.wid = 0;
  }

  /**
   * Work out the invisible margin this window manager wraps the host in, and take it off.
   *
   * A frameless window is not necessarily the size it was asked to be: the window manager adds
   * margins of its own — a shadow, a resize border — outside the visible edge. mpv renders into
   * the real X window rather than the one Electron reports, so it fills that margin too, and the
   * picture overhangs the app. On a multi-monitor desktop the overhang lands on the screen next
   * door, taking mpv's controls with it.
   *
   * The margin is not a fixed number: it depends on the window manager and its theme. So rather
   * than guess it, ask the one thing that can see the truth. mpv reports its own surface, and the
   * difference between that and the bounds we asked for is exactly the margin. Measured once per
   * session, then subtracted from every layout after.
   */
  async calibrate() {
    if (this.embedded === false) return; // no host being sized, so no margin to measure
    if (!this.mpv || !this.host || this.host.isDestroyed()) return;
    // One at a time. There is a wait in the middle of this, and two callers that can overlap —
    // a file loading, and the delayed re-measure after a fullscreen change. Both would read the
    // same difference and both would apply it, correcting twice for one margin and leaving the
    // picture short by the excess. Pressing 'f' as an item starts is enough to hit it.
    if (this.calibrating) return;
    this.calibrating = true;
    try {
      await this.measureAndApply();
    } finally {
      this.calibrating = false;
    }
  }

  // The measurement itself. Split out so calibrate() above can hold the one-at-a-time lock around
  // it without the guard and the work being tangled together.
  async measureAndApply() {
    // Take a reading twice, a moment apart, and only believe it if both agree.
    //
    // Two ways this goes wrong with a single reading, both seen. Measure while the window is
    // still settling — which is exactly what starting another item does, since the host has just
    // been re-shown — and the correction is against a size that is already stale, so the picture
    // comes back smaller. Measure while the window manager is briefly decorating the window and
    // the margin reads 28px larger, and that title bar's worth of nothing is baked in for good.
    //
    // A settled window gives the same answer twice; a settling one does not. So disagreement is
    // simply not an answer, and it is left for the next attempt rather than guessed at.
    // Measure against where the picture is *meant* to end up, not against the reduced size the
    // window was asked for.
    //
    // This is the whole of the bug that made the video shrink on every replay. The margin is
    // constant: whatever size the window is asked to be, the real one comes back 20px bigger.
    // Comparing mpv's surface with the requested size therefore reads that same 20px every time
    // and adds it again — 20, 40, 60 — even though the very first correction had already made the
    // picture exactly right. Comparing against the target instead reads zero once it fits, which
    // is the answer that makes it stop.
    const read = async () => {
      const target = this.targetSize;
      if (!target) return null;
      const dim = await this.mpv.getProperty('osd-dimensions').catch(() => null);
      if (!dim || !dim.w || !dim.h) return null;
      if (!this.host || this.host.isDestroyed()) return null;
      // Put both sides in the same units before subtracting. mpv measures the real X window, so
      // osd-dimensions is in device pixels; every rectangle Electron hands out or takes back —
      // getContentBounds, the grid's pane bounds, setBounds — is in density-independent ones.
      // The two only coincide at a device scale factor of 1, which is what made this look right
      // everywhere it was tested.
      //
      // Anywhere else the difference is not a margin at all, it is the scale factor: at 1.25 the
      // first reading is a quarter of the pane, and that quarter is subtracted from every layout
      // after. The picture comes back at three-quarter size, shoved down and right by half of
      // what was taken off — which on a compositor that floats this window (Hyprland floats it,
      // being transient for the main window) reads as a player that has come adrift of the app.
      // It creeps back toward the truth over later files, since each one measures again, which
      // is exactly the kind of half-wrong that survives a test.
      const scale = screen.getDisplayMatching(this.host.getBounds()).scaleFactor || 1;
      return { dw: dim.w / scale - target.w, dh: dim.h / scale - target.h };
    };

    const first = await read();
    if (!first) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await read();
    if (!second) return;
    if (Math.abs(first.dw - second.dw) > 1 || Math.abs(first.dh - second.dh) > 1) return;

    // Corrects in both directions. Over-shrinking has to be undone as readily as under-shrinking,
    // because the margin is not constant: a fullscreen window has no resize border, so an inset
    // measured while windowed would leave a band of nothing around the picture. The threshold
    // ignores differences small enough to be rounding from a fractional display scale.
    if (Math.abs(second.dw) < 2 && Math.abs(second.dh) < 2) return;
    this.frameInset = {
      w: Math.max(0, this.frameInset.w + second.dw),
      h: Math.max(0, this.frameInset.h + second.dh),
    };
    this.layout();
  }

  /**
   * mpv asked to go fullscreen — its button, or 'f'.
   *
   * It cannot do this itself: the window it renders into belongs to StreamHub, and mpv has no say
   * over it. So the request is honoured by putting the *app's* window into fullscreen, which the
   * player's window then follows through the ordinary layout path. Without this the button and
   * the key both appear to do nothing at all.
   */
  setFullscreen(on) {
    if (!this.baseWindow || this.baseWindow.isDestroyed()) return;
    const owned = this.ownsFullscreen;
    this.ownsFullscreen = on;
    if (owned !== on) this.emit('fullscreen', on);
    // Already in the state asked for — F11 got there first, say. The window needs nothing, but the
    // picture may: in a grid it goes from its tile to the whole screen, or back.
    if (this.baseWindow.isFullScreen() === on) {
      this.layout();
      return;
    }
    this.baseWindow.setFullScreen(on);
    // The frame changes shape here — a fullscreen window has no resize border — so the measured
    // margin no longer applies. Drop it and let it be measured again for the new shape.
    this.frameInset = { w: 0, h: 0 };
    // Re-place it more than once. Going in or out of fullscreen is not instant, and the bounds
    // Electron reports lag behind it, so a single pass a fixed time later can still read the old
    // size — which leaves the picture covering part of the screen with the page showing through
    // the rest. Laying out repeatedly costs nothing once the size has settled.
    [0, 150, 400, 800].forEach((delay) => {
      setTimeout(() => this.layout(), delay);
    });
    setTimeout(() => this.calibrate().catch(() => {}), 900);
  }

  /**
   * The window left fullscreen without mpv asking — F11, or the compositor's own fullscreen key.
   * mpv still believes it is fullscreen, and its button would then do nothing on the first press.
   */
  windowLeftFullscreen() {
    // In a window of its own, mpv's fullscreen is its own window's, and the app's window leaving
    // fullscreen says nothing about it.
    if (this.embedded === false) {
      this.ownsFullscreen = false;
      return;
    }
    if (!this.ownsFullscreen) return;
    this.ownsFullscreen = false;
    this.emit('fullscreen', false);
    if (this.mpv) this.mpv.setProperty('fullscreen', false).catch(() => {});
    this.frameInset = { w: 0, h: 0 };
    this.layout();
    setTimeout(() => this.calibrate().catch(() => {}), 900);
  }

  // Whether the film fills the whole window, chrome and grid neighbours included.
  coversWindow() {
    return Boolean(
      this.ownsFullscreen &&
        this.baseWindow &&
        !this.baseWindow.isDestroyed() &&
        this.baseWindow.isFullScreen(),
    );
  }

  /**
   * Take the video off screen for `reason`, or put it back once nothing is holding it off.
   * Playback carries on underneath — this is about what is in front, not what is playing.
   *
   * The reason is always recorded, even while nothing is loaded yet: mpv's first start takes a
   * moment, and a service picked in that moment has to be honoured once the film arrives. See
   * applyHidden, which play() runs again when it does.
   */
  setHidden(reason, on) {
    if (on) this.hiddenFor.add(reason);
    else this.hiddenFor.delete(reason);
    this.applyHidden();
  }

  // Bring the host's visibility in line with the reasons. Judged against what the host is actually
  // doing rather than against what changed, so a reason that arrived at an awkward moment is never
  // lost: hidden whenever anything holds it, shown again only with a film loaded to show.
  applyHidden() {
    if (!this.embedded || !this.host || this.host.isDestroyed()) return;
    const visible = this.host.isVisible();
    if (this.hiddenFor.size) {
      if (visible) this.host.hide();
      return;
    }
    if (visible || !this.current) return;
    this.layout();
    this.host.showInactive();
    this.layout();
    this.undecorateHost();
  }

  /**
   * Ask Hyprland not to decorate or animate the host. See HOST_HYPRLAND_PROPS for why.
   *
   * Done every time the host is shown rather than once. Hiding an X window unmaps it, and a window
   * Hyprland maps again can come back as a new window with its defaults, so the properties are
   * re-asserted rather than trusted to have survived; asking again for what is already set costs
   * nothing. A window rule would last, but window rules are the user's config, and this is the
   * app's own window.
   *
   * Both dispatcher syntaxes are tried: Hyprland with a Lua config (0.56 here) takes
   * hl.dsp.window.set_prop and answers the classic `setprop` with "unknown request"; older
   * releases only know the classic one. The window is found by process and title, and is looked
   * for a few times, because a window shown a moment ago may not have been mapped yet.
   */
  async undecorateHost(attempt = 0) {
    if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
    if (!this.embedded || !this.host || this.host.isDestroyed() || !this.host.isVisible()) return;
    let clients = null;
    try {
      clients = JSON.parse((await hyprctl(['clients', '-j'])) || 'null');
    } catch {
      clients = null;
    }
    const me = Array.isArray(clients)
      ? clients.find((c) => c && c.pid === process.pid && c.title === HOST_TITLE)
      : null;
    if (!me || !me.address) {
      if (attempt < 4) setTimeout(() => this.undecorateHost(attempt + 1), 150);
      return;
    }
    const target = `address:${me.address}`;
    for (const [prop, value] of HOST_HYPRLAND_PROPS) {
      const lua = `hl.dsp.window.set_prop({ window = "${target}", prop = "${prop}", value = "${value}" })`;
      const answer = await hyprctl(['dispatch', lua]);
      if (!answer || !/^ok\b/i.test(answer.trim())) {
        await hyprctl(['dispatch', 'setprop', target, prop, value]);
      }
    }
  }

  /**
   * The Jellyfin view went off screen (another service was picked) or came back. Leaving pauses
   * the film, the way leaving any service pauses its video; coming back resumes it, but only if it
   * was us that paused it.
   *
   * Only for a film inside the app. One in a window of its own (Wayland) is still in plain sight
   * whatever the app's window is showing, so it is left alone.
   */
  setAway(away) {
    if (this.embedded === false) {
      this.hiddenFor.delete('away');
      return;
    }
    const was = this.hiddenFor.has('away');
    this.setHidden('away', away);
    if (was === away) return;
    this.applyAwayPause();
  }

  // Pause for 'away', or resume from it. Split out because a film that started while the user was
  // already elsewhere needs the same treatment once it is loaded — see play().
  applyAwayPause() {
    if (!this.mpv || !this.current) return;
    const away = this.hiddenFor.has('away');
    if (away && !this.state.paused) {
      this.autoPaused = true;
      this.mpv.pause().catch(() => {});
    } else if (!away && this.autoPaused) {
      this.autoPaused = false;
      this.mpv.play().catch(() => {});
    }
  }

  // Whether the film is what the user is looking at — loaded, its page not left for another
  // service, and not covered by a site fullscreen in another pane. That is when the media keys and
  // the desktop's play/pause belong to mpv. A film in a window of its own is always in front.
  inFront() {
    if (!this.isActive()) return false;
    if (this.embedded === false) return true;
    return !this.hiddenFor.has('away') && !this.hiddenFor.has('covered');
  }

  // Play (true), pause (false) or toggle (null), for the media keys and the desktop's controls.
  // A deliberate press is the user's own choice, so it also cancels any resume we were holding.
  async setPlaying(want = null) {
    if (!this.mpv || !this.current) return;
    const play = want === null ? this.state.paused : want;
    this.autoPaused = false;
    if (play && this.state.paused) await this.mpv.play();
    else if (!play && !this.state.paused) await this.mpv.pause();
  }

  // Hand the keyboard to mpv, when its picture is actually on screen to take it.
  focusVideo() {
    if (!this.embedded || !this.host || this.host.isDestroyed() || !this.host.isVisible()) return;
    this.host.focus();
  }

  async seekBy(seconds) {
    if (!this.mpv || !this.current) return;
    await this.mpv.command('seek', Number(seconds) || 0, 'relative');
  }

  static available() {
    return isAvailable();
  }

  // mpv is kept alive and idle between items, so its mere existence is not playback — what is
  // loaded is. Not the host window's visibility either: it is hidden while a sheet is open over it,
  // or the user is on another service, and the film is still very much in progress then.
  isActive() {
    return Boolean(this.mpv && this.current);
  }

  // The host window is made once and reused. Destroying it between items would take its X11
  // window id with it, and mpv is holding that id.
  ensureHost() {
    if (this.host && !this.host.isDestroyed()) return this.host;
    this.host = new BrowserWindow({
      parent: this.baseWindow,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      // No shadow. A shadow is drawn as an invisible margin *around* the window, which makes the
      // real X window larger than the bounds asked for — measured, 32px wider and 42px taller.
      // mpv reads that X window rather than what Electron believes, so it renders into the
      // margin too: the picture overhangs the app and, on a multi-monitor desktop, the controls
      // at the bottom spill onto the screen next door.
      hasShadow: false,
      // Opaque black: this window is a backdrop for mpv, and a transparent one would let the
      // page show through in the letterbox bars.
      backgroundColor: '#000000',
      title: HOST_TITLE,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // Nothing is ever displayed by this window's own web contents — mpv covers it — but it
    // still needs a document for the window to be realised. The <title> is there because the
    // page's title replaces the window's, and the window has to keep its name. See HOST_TITLE.
    this.host.loadURL(
      `data:text/html,<title>${encodeURIComponent(HOST_TITLE)}</title>` +
        '<body style="margin:0;background:#000"></body>',
    );
    this.host.on('closed', () => {
      this.host = null;
    });
    return this.host;
  }

  // Put the host over the main window's content area. Read the bounds now rather than trusting
  // anything cached: the window manager is free to place a window somewhere other than where it
  // was asked, and a stale rectangle leaves the video sitting over empty desktop.
  layout() {
    // Nothing of ours to place when mpv has a window of its own.
    if (this.embedded === false) return;
    if (!this.host || this.host.isDestroyed()) return;
    if (!this.baseWindow || this.baseWindow.isDestroyed()) return;
    const content = this.baseWindow.getContentBounds();
    // Which part of the window the video belongs in. Normally the whole content area; in a grid,
    // only the tile Jellyfin is showing in, so the other services stay visible beside it. When mpv
    // has taken the screen it is the whole window regardless — that is what its fullscreen means.
    const covers = this.coversWindow();
    const pane = covers ? null : this.paneBounds();
    let b = pane
      ? {
          x: content.x + pane.x,
          y: content.y + pane.y,
          width: pane.width,
          height: pane.height,
        }
      : content;
    // Leave the chrome its edge. Only a tile that actually reaches under the sidebar is trimmed;
    // one further right is already clear of it.
    const edge = covers ? 0 : Math.max(0, Math.round(this.insetLeft() || 0));
    const clearOf = content.x + edge;
    if (b.x < clearOf) {
      const cut = Math.min(b.width - 1, clearOf - b.x);
      b = { x: b.x + cut, y: b.y, width: b.width - cut, height: b.height };
    }
    // The size the picture should end up. Remembered because that — not the smaller size actually
    // requested below — is what a measurement has to be judged against. See calibrate().
    this.targetSize = { w: b.width, h: b.height };
    // Take off whatever invisible margin this window manager wraps the window in. See calibrate().
    const inset = this.frameInset;

    // The rectangle asked for, and nothing cleverer than that.
    //
    // The margin sits on every side, so half of it lies above and to the left of where Electron
    // reports the window to be. Shrinking alone gets the size right and leaves the picture offset
    // up and left by that half, so the origin moves down and right by the same amount.
    //
    // Resist the urge to clamp this to the display: an earlier version did, to stop mpv's
    // controls falling off the bottom of the screen, and it was the wrong fix twice over. Those
    // controls were off screen because the window's bounds were stale after maximising, which
    // belongs where it is now fixed; and on a multi-monitor desktop getDisplayMatching can name a
    // display the window is not really on, which moves the video off the app altogether.
    const asked = {
      x: b.x + Math.round(inset.w / 2),
      y: b.y + Math.round(inset.h / 2),
      width: Math.max(1, b.width - inset.w),
      height: Math.max(1, b.height - inset.h),
    };
    this.host.setBounds(asked);
    if (process.env.STREAMHUB_DEBUG_JELLYFIN) {
      // eslint-disable-next-line no-console
      console.log(
        `[player] target=${JSON.stringify(b)} inset=${JSON.stringify(inset)}` +
          ` asked=${JSON.stringify(asked)} got=${JSON.stringify(this.host.getBounds())}` +
          `${pane ? ' (grid pane)' : ''}`,
      );
    }
  }

  // Apply the layout again, and again shortly after, so a host that settled at the wrong size is
  // put right. Cheap: setBounds on an already-correct window does nothing.
  reassertBounds() {
    this.layout();
    setTimeout(() => this.layout(), 100);
    setTimeout(() => this.layout(), 500);
  }

  /**
   * Start playing a URL. `meta` is carried back out with progress events so the caller can
   * report to Jellyfin without keeping its own copy.
   */
  async play(
    url,
    {
      startSeconds = 0,
      headers,
      audioIndex,
      subtitleIndex,
      externalSubtitles = [],
      streams = [],
      title,
      meta,
    } = {},
  ) {
    // Which play this is. A second play can arrive while the first is still waiting on mpv to
    // start; whichever was asked for last is the one that goes ahead, and the earlier one stands
    // down at its next wait rather than loading its item over the newer one.
    this.playGen = (this.playGen || 0) + 1;
    const gen = this.playGen;
    const host = this.ensureHost();

    // Can the video go inside the app at all? Settled once, on the first play.
    //
    // The window id mpv would draw into only exists on X11. On Wayland the handle comes back
    // empty, because mpv has no way to render inside another application's window there. Rather
    // than refuse — which is what this used to do, and what the 0.5.1 AppImage did to anyone who
    // launched it by double-clicking instead of from a menu — mpv is given a window of its own
    // instead. Not embedded, no app chrome around it, but the film plays.
    if (this.embedded === null) {
      const handle = host.getNativeWindowHandle();
      this.wid = handle && handle.length >= 4 ? handle.readUInt32LE(0) : 0;
      // The handle is not the test. On Wayland it comes back non-zero anyway — a value that is
      // simply not an X window — and handing that to mpv as --wid kills it outright with
      // "BadWindow (invalid Window parameter)", which is how this failed the first time.
      //
      // So ask what backend is actually in use. Either the X11 platform was asked for explicitly,
      // or there is no Wayland session to be on in the first place.
      const askedForX11 = process.argv.some((a) => a === '--ozone-platform=x11');
      const sessionIsX11 = !process.env.WAYLAND_DISPLAY && Boolean(process.env.DISPLAY);
      this.embedded = Boolean(this.wid) && (askedForX11 || sessionIsX11);
      if (!this.embedded) {
        // eslint-disable-next-line no-console
        console.warn("[jellyfin] no X11 window to embed into — mpv will open its own window");
      }
    }

    // Only put the host on screen when something is going to be drawn into it, and only *before*
    // mpv starts: it reparents into a window that is already mapped.
    // Not while something is holding it off screen, though — a sheet open over the page, say — and
    // it goes up when that lets go (see applyHidden). The exception is mpv's very first start: it
    // has to be handed a window that is already mapped, so the host goes up for that and is taken
    // down again once the film is loaded.
    if (this.embedded && (!this.hiddenFor.size || !this.mpv)) {
      this.layout();
      host.showInactive();
      this.layout(); // again after mapping: the WM may have adjusted it
      host.focus();
      this.undecorateHost();
    }

    if (!this.mpv) {
      const mpv = this.embedded
        ? new Mpv({ wid: this.wid, hwdec: this.hwdec })
        : new Mpv({ hwdec: this.hwdec, extraArgs: ['--fullscreen=yes'] });
      this.mpv = mpv;
      this.wireMpv();
      this.starting = mpv.start();
      try {
        await this.starting;
      } catch (err) {
        // Reap it, and cut it loose from this Player.
        //
        // start() spawns the process before it connects, so a connection failure leaves a live
        // mpv behind. Merely dropping the reference is not enough on two counts: the process goes
        // on holding the GPU and the audio device until the next launch sweeps it, and — worse —
        // its handlers were wired a moment ago and still close over this Player. When the
        // abandoned process eventually died it would run teardown() here, hiding the window and
        // restoring the sidebar part-way through a *later*, working film.
        this.mpv = null;
        mpv.removeAllListeners();
        await mpv.stop().catch(() => {});
        host.hide();
        this.emit('error', err);
        return false;
      } finally {
        this.starting = null;
      }
    } else if (this.starting) {
      // mpv exists but is still connecting — a play that arrived during the first one's start.
      // Commands sent now would fail with "not connected"; wait for it like the first play does.
      try {
        await this.starting;
      } catch {
        return false; // the first play reported the failure
      }
    }
    if (gen !== this.playGen || !this.mpv) return false;

    // Never null while something is loaded, metadata or not: isActive() and the hide reasons
    // both key off it.
    this.current = meta || {};
    this.state = { positionSeconds: startSeconds, durationSeconds: 0, paused: false };
    // Held until the file is open and mpv has a track list to match these against.
    this.pendingTracks = { audioIndex, subtitleIndex, externalSubtitles };
    // Jellyfin stream index -> the URL mpv was given for it. Set now, not when the files are
    // added, so a subtitle change during the film maps through it too.
    this.externalSubtitles = new Map(externalSubtitles.map((s) => [s.index, s.url]));
    // And how Jellyfin numbers the rest. See trackIdForStreamIndex.
    this.streamLayout = Array.isArray(streams) ? streams : [];
    if (title) await this.mpv.setProperty('force-media-title', title).catch(() => {});

    // If the file will not open, put the window away again.
    //
    // The host was shown before mpv was asked for anything, so that the video has somewhere to
    // appear the moment it arrives. That means a failure here leaves an opaque black window
    // covering Jellyfin with nothing in it and no way to tell why — the 'active' event that
    // would eventually hide it is never reached.
    try {
      await this.mpv.load(url, {
        startSeconds,
        headers,
        transcoding: Boolean(meta && meta.playMethod === 'Transcode'),
      });
    } catch (err) {
      this.current = null;
      this.pendingTracks = null;
      if (this.host && !this.host.isDestroyed()) this.host.hide();
      this.emit('error', err);
      return false;
    }

    this.emit('active', true);
    this.startProgress();
    // Anything that asked for the film to be off screen, or paused, while it was still starting —
    // or before it was asked for at all, as when another service is showing — applies now.
    this.applyHidden();
    this.applyAwayPause();
    return true;
  }

  /**
   * Turn a Jellyfin stream index into an mpv track id.
   *
   * The two number tracks differently. Jellyfin's `Index` counts every stream of the media source
   * together, external files included — and it numbers the external files *first*, then the
   * file's own streams after them. mpv numbers each kind from 1, and exposes the container's own
   * position as `ff-index`. So the two only line up when there is no external file at all;
   * with a sidecar .srt, matching Index against ff-index picked the stream one along, which is
   * how the Japanese audio played when English was asked for.
   *
   * What does line up is order. The file's own audio streams are in the same order in both lists,
   * and so are its subtitles, so the third embedded audio stream in Jellyfin's list is the third
   * non-external audio track in mpv's. External subtitle files are matched by the URL mpv loaded
   * them from instead, since they have no place in the file's order. Without a layout from the
   * page (an older shell), ff-index is still the best guess there is.
   *
   * This holds because the file mpv opened is the file Jellyfin described — which is exactly the
   * direct-play case this feature exists for. A transcode rewrites the stream layout; a stream
   * the mapping cannot find returns null, which leaves mpv on its own default rather than a
   * confidently wrong track.
   */
  async trackIdForStreamIndex(type, index) {
    if (!this.mpv) return null;
    const wanted = Number(index);
    if (!Number.isInteger(wanted) || wanted < 0) return null;
    const list = await this.mpv.getProperty('track-list').catch(() => null);
    if (!Array.isArray(list)) return null;
    // A subtitle file beside the film has no place in the container's numbering — its ff-index
    // is its position within its own file, usually 0 — so it is found by the URL it came from.
    // Which is also why container tracks are matched only among tracks that are not external.
    const externalUrl =
      type === 'sub' && this.externalSubtitles ? this.externalSubtitles.get(wanted) : undefined;
    if (externalUrl) {
      const file = list.find(
        (t) => t && t.type === type && t.external && t['external-filename'] === externalUrl,
      );
      return file ? file.id : null;
    }
    const layout = (this.streamLayout || []).filter((s) => s.type === type);
    if (layout.length) {
      const own = layout.filter((s) => !s.external).sort((a, b) => a.index - b.index);
      const position = own.findIndex((s) => s.index === wanted);
      if (position < 0) return null; // an external stream with no file loaded, or not this kind
      const tracks = list
        .filter((t) => t && t.type === type && !t.external)
        .sort((a, b) => (a['ff-index'] ?? a.id) - (b['ff-index'] ?? b.id));
      return tracks[position] ? tracks[position].id : null;
    }
    const match = list.find(
      (t) => t && t.type === type && !t.external && t['ff-index'] === wanted,
    );
    return match ? match.id : null;
  }

  // Apply the audio and subtitle streams jellyfin-web asked for. Deferred until the file is
  // open, because until then there is no track list to match against.
  async applyPendingTracks() {
    const pending = this.pendingTracks;
    this.pendingTracks = null;
    if (!pending || !this.mpv) return;

    // Sidecar subtitle files first, so they are in the track list to be matched below. 'auto'
    // adds without selecting; which subtitle shows is decided below, the same as for any other.
    // One at a time, so the menu lists them in the server's order. A file that will not load
    // costs only itself.
    for (const sub of pending.externalSubtitles || []) {
      if (!this.mpv) return;
      await this.mpv
        .command('sub-add', sub.url, 'auto', sub.title || '', sub.language || '')
        .catch(() => {});
    }

    if (pending.audioIndex !== undefined && pending.audioIndex !== null) {
      const id = await this.trackIdForStreamIndex('audio', pending.audioIndex);
      if (id !== null) await this.mpv.setAudioTrack(id).catch(() => {});
    }
    // A negative index is Jellyfin's way of saying "no subtitles", which is a real choice rather
    // than an absent one, so it is honoured instead of being left to mpv's default.
    if (pending.subtitleIndex !== undefined && pending.subtitleIndex !== null) {
      if (Number(pending.subtitleIndex) < 0) {
        await this.mpv.setSubtitleTrack(null).catch(() => {});
      } else {
        const id = await this.trackIdForStreamIndex('sub', pending.subtitleIndex);
        if (id !== null) await this.mpv.setSubtitleTrack(id).catch(() => {});
      }
    }
  }

  wireMpv() {
    this.mpv.on('file-loaded', () => {
      this.applyPendingTracks().catch(() => {});
      // Re-assert the size once there is actually a video in the window.
      //
      // Setting the bounds before playback is not enough on its own: the host is a child window
      // being shown, sized and given to another process all at once, and it can settle at a
      // size other than the one it was asked for. mpv then tracks *that* — it reads the real X
      // geometry, not what Electron believes — and anything wider than the display spills onto
      // the monitor next door, which is where its controls end up.
      this.reassertBounds();
      // Once there is a picture, mpv can tell us how big its window really is.
      this.calibrate().catch(() => {});
      // Not embedded: make sure the window mpv opened for itself is actually filling the screen.
      // Asking for it at startup is not enough — mpv opens its window while idle, before there is
      // any video, and it can settle at its default size and stay there, which leaves a small
      // black rectangle sitting over the page with the controls in it.
      if (!this.embedded && this.mpv) {
        this.mpv.setProperty('fullscreen', true).catch(() => {});
      }
      // Nothing is said about how to leave. It used to be — a line of mpv's own OSD text naming
      // Escape — from before the controls had a way out of their own. The X on the bar is that
      // way out now, and it is visible whenever the bar is, so the text was only a second banner
      // over the opening of every film saying what the button already says.
    });

    this.mpv.on('property', (name, value) => {
      if (name === 'time-pos' && typeof value === 'number') {
        this.state.positionSeconds = value;
      } else if (name === 'duration' && typeof value === 'number') {
        this.state.durationSeconds = value;
      } else if (name === 'pause') {
        const paused = Boolean(value);
        const changed = paused !== this.state.paused;
        this.state.paused = paused;
        // Say so straight away rather than waiting for the ten-second progress tick. mpv owns the
        // controls, so pausing there is invisible to the Jellyfin page otherwise, and its own
        // transport goes on claiming the item is playing.
        if (changed && this.current) this.emit('paused', paused, this.current);
      } else if (name === 'fullscreen') {
        // Only for a film inside the app. In a window of its own (Wayland) mpv's fullscreen is
        // that window's, and it starts fullscreen — following it here put the app's own window
        // into fullscreen as mpv started, and left it there after the film.
        if (this.embedded) this.setFullscreen(Boolean(value));
      }
    });

    // 'eof' is the only reason that means "played to the end" — 'stop' is us replacing the
    // file, and mpv never latches eof-reached under --keep-open=no. See src/mpv.js.
    this.mpv.on('end-file', (reason) => {
      this.emit('finished', reason, this.current);
      // 'stop' is us — stopping deliberately, or replacing the file with the next item — and the
      // caller that asked for it is responsible for what happens next.
      //
      // Anything else means playback is over whether we wanted it or not, and the window must not
      // be left covering the page. 'error' in particular is the ordinary failure: the server
      // answered 401, the container is unreadable, the network went away. Without this the
      // sidebar stays hidden and the content area stays black indefinitely, with the only way out
      // a key nobody has been told about — the hint that names it is shown on 'file-loaded',
      // which by definition never arrived.
      if (reason === 'eof' || reason === 'error') {
        if (reason === 'error') {
          this.emit('error', new Error('mpv could not play this item'));
        }
        this.endReason = reason;
        this.stop().catch(() => {});
      }
    });

    // The user pressed q, or mpv fell over. Either way the window must not be left covering the
    // page with nothing drawing into it.
    this.mpv.on('exit', () => {
      this.mpv = null;
      this.endReason = 'exit';
      this.teardown();
    });

    // Escape, or q. Both mean "get me out of this", but out of what depends on where you are:
    // out of fullscreen first if you are in it, and only then back to the library. Anything else
    // makes leaving fullscreen also abandon the film, which is not what either key means anywhere
    // else. Stopping leaves mpv running and idle, so the next episode starts without paying to
    // spawn it again.
    this.mpv.on('client-message', (name) => {
      if (name !== 'streamhub-escape') return;
      if (this.baseWindow && !this.baseWindow.isDestroyed() && this.baseWindow.isFullScreen()) {
        this.setFullscreen(false);
        if (this.mpv) this.mpv.setProperty('fullscreen', false).catch(() => {});
        return;
      }
      this.stop().catch(() => {});
    });

    this.mpv.on('error', (err) => this.emit('error', err));
  }

  startProgress() {
    this.stopProgress();
    // Two rates, because the two listeners want different things. The page holds a mirror of the
    // position that it reads *synchronously* whenever it reports playback to the server, so a
    // stale mirror is a wrong resume point — and a stop is never on a tick boundary. Telling a
    // window in the same process costs nothing, so it is told every second. The server keeps the
    // ten, which is what Jellyfin's own clients send.
    this.tickTimer = setInterval(() => {
      if (!this.isActive()) return;
      this.emit('position', { ...this.state }, this.current);
    }, PAGE_TICK_MS);
    this.progressTimer = setInterval(() => {
      if (!this.isActive()) return;
      this.emit('progress', { ...this.state }, this.current);
    }, PROGRESS_INTERVAL_MS);
  }

  stopProgress() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // Stop playing and give the window back to the page. The mpv process is kept alive and idle,
  // so starting the next episode does not pay to spawn it again.
  async stop() {
    if (this.mpv) await this.mpv.stopPlayback();
    this.teardown();
  }

  teardown() {
    this.stopProgress();
    const showing = Boolean(this.host && !this.host.isDestroyed() && this.host.isVisible());
    if (showing) this.host.hide();
    const was = this.current;
    this.current = null;
    // A film that is over has nothing to resume. The hide reasons stay: they describe the app
    // (a sheet is open, another service is showing), and the next item has to respect them too.
    this.autoPaused = false;
    // Only say playback ended if it had actually begun. A stop that arrives when nothing was
    // playing — jellyfin-web sends one on navigation — would otherwise announce itself, and the
    // listener that restores the sidebar would put it back over a site that is in fullscreen.
    //
    // Why it ended goes along: only a film played to its end ('eof') may be followed by the next
    // episode. Anything else — the user leaving, an error, mpv going away — is a stop.
    const reason = this.endReason || 'stop';
    this.endReason = null;
    if (showing || was) this.emit('active', false, was, reason);
  }

  // Full shutdown, for quitting the app or leaving Jellyfin entirely.
  //
  // The object stays usable afterwards — it is built once at startup and the mpv setting can be
  // turned back on — so everything that was measured against the window being destroyed here has
  // to go with it. The window id above all: it names an X window that is about to stop existing,
  // and holding on to it meant the next play handed mpv `--wid=<a window that is gone>`, which mpv
  // answers by dying outright with "BadWindow". That is the whole of why turning mpv playback off
  // and back on left Jellyfin unable to play anything until the app was restarted.
  async destroy() {
    // Say playback has ended now, while what was playing and how far it got are still here to be
    // reported. Left to mpv's exit, it came after the app had already let go of this player, and
    // closing the window mid-film lost the resume point.
    this.teardown();
    if (this.mpv) {
      const mpv = this.mpv;
      this.mpv = null;
      // Its handlers are deliberately left attached: the exit this is about to cause is what runs
      // teardown(), and teardown() is what emits the final 'active' — the event main.js turns into
      // the stop report that writes the resume point. Cutting them loose here would make closing
      // the film by turning mpv off lose the place it was left at.
      await mpv.stop().catch(() => {});
    }
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
    // Measured against a window that no longer exists — all of it has to be found out again.
    this.embedded = null;
    this.wid = 0;
    this.frameInset = { w: 0, h: 0 };
    this.targetSize = null;
    this.current = null;
    this.pendingTracks = null;
    this.autoPaused = false;
    this.ownsFullscreen = false;
  }
}

module.exports = { Player };
