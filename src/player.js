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
// The chrome is therefore hidden for the duration, on the same reasoning the app already
// applies to a site going fullscreen: a strip of sidebar over the film is the one thing left on
// screen that is not the film.
const { BrowserWindow } = require('electron');
const { EventEmitter } = require('events');
const { Mpv, isAvailable } = require('./mpv');

// How often to tell the server where we are. Jellyfin's own clients report every ten seconds;
// more often is just traffic, less and a crash loses the resume point.
const PROGRESS_INTERVAL_MS = 10000;

/**
 * Owns the host window and the mpv talking to it.
 *
 * Emits:
 *   'active'   (bool)                 — playback started / finished, for the chrome and the
 *                                       sleep inhibitor
 *   'position' ({ positionSeconds, durationSeconds, paused }) — throttled progress
 *   'finished' (reason)               — an item ended; 'eof' means it played to the end
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
   */
  constructor({ baseWindow, paneBounds }) {
    super();
    this.baseWindow = baseWindow;
    this.paneBounds = typeof paneBounds === 'function' ? paneBounds : () => null;
    this.host = null;
    this.mpv = null;
    this.current = null; // what is playing, for the progress reports
    this.progressTimer = null;
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
      return { dw: dim.w - target.w, dh: dim.h - target.h };
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
    if (this.baseWindow.isFullScreen() === on) return;
    this.baseWindow.setFullScreen(on);
    // The frame changes shape here — a fullscreen window has no resize border — so the measured
    // margin no longer applies. Drop it and let it be measured again for the new shape.
    this.frameInset = { w: 0, h: 0 };
    setTimeout(() => {
      this.layout();
      this.calibrate().catch(() => {});
    }, 300);
  }

  static available() {
    return isAvailable();
  }

  isActive() {
    if (!this.mpv) return false;
    // Not embedded, so there is no host window whose visibility answers this. mpv is kept alive
    // and idle between items, so its mere existence is not playback — what is loaded is.
    if (!this.embedded) return Boolean(this.current);
    return Boolean(this.host && !this.host.isDestroyed() && this.host.isVisible());
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
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // Nothing is ever displayed by this window's own web contents — mpv covers it — but it
    // still needs a document for the window to be realised.
    this.host.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
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
    // only the tile Jellyfin is showing in, so the other services stay visible beside it.
    const pane = this.paneBounds();
    const b = pane
      ? {
          x: content.x + pane.x,
          y: content.y + pane.y,
          width: pane.width,
          height: pane.height,
        }
      : content;
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
    { startSeconds = 0, headers, audioIndex, subtitleIndex, title, meta } = {},
  ) {
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
    if (this.embedded) {
      this.layout();
      host.showInactive();
      this.layout(); // again after mapping: the WM may have adjusted it
      host.focus();
    }

    if (!this.mpv) {
      const mpv = this.embedded
        ? new Mpv({ wid: this.wid })
        : new Mpv({ extraArgs: ['--fullscreen=yes'] });
      this.mpv = mpv;
      this.wireMpv();
      try {
        await mpv.start();
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
      }
    }

    this.current = meta || null;
    this.state = { positionSeconds: startSeconds, durationSeconds: 0, paused: false };
    // Held until the file is open and mpv has a track list to match these against.
    this.pendingTracks = { audioIndex, subtitleIndex };
    if (title) await this.mpv.setProperty('force-media-title', title).catch(() => {});

    // If the file will not open, put the window away again.
    //
    // The host was shown before mpv was asked for anything, so that the video has somewhere to
    // appear the moment it arrives. That means a failure here leaves an opaque black window
    // covering Jellyfin with nothing in it and no way to tell why — the 'active' event that
    // would eventually hide it is never reached.
    try {
      await this.mpv.load(url, { startSeconds, headers });
    } catch (err) {
      this.current = null;
      this.pendingTracks = null;
      if (this.host && !this.host.isDestroyed()) this.host.hide();
      this.emit('error', err);
      return false;
    }

    this.emit('active', true);
    this.startProgress();
    return true;
  }

  /**
   * Turn a Jellyfin stream index into an mpv track id.
   *
   * The two number tracks differently. Jellyfin's `Index` counts every stream in the media
   * source together — video, audio and subtitle in container order — while mpv numbers each kind
   * from 1 and exposes the container's own position separately as `ff-index`. So `ff-index` is
   * the common ground, and matching on it is what makes "the audio track Jellyfin picked" and
   * "the audio track mpv is playing" the same one.
   *
   * This holds because the file mpv opened is the file Jellyfin described — which is exactly the
   * direct-play case this feature exists for. If the server ever transcodes, it rewrites the
   * stream layout and no mapping survives; returning null then leaves mpv on its own default,
   * which is the right answer rather than a confidently wrong one.
   */
  async trackIdForStreamIndex(type, index) {
    if (!this.mpv) return null;
    const wanted = Number(index);
    if (!Number.isInteger(wanted) || wanted < 0) return null;
    const list = await this.mpv.getProperty('track-list').catch(() => null);
    if (!Array.isArray(list)) return null;
    const match = list.find((t) => t && t.type === type && t['ff-index'] === wanted);
    return match ? match.id : null;
  }

  // Apply the audio and subtitle streams jellyfin-web asked for. Deferred until the file is
  // open, because until then there is no track list to match against.
  async applyPendingTracks() {
    const pending = this.pendingTracks;
    this.pendingTracks = null;
    if (!pending || !this.mpv) return;

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
      // Say how to leave. While a film is playing mpv covers the content area and the sidebar is
      // hidden, so there is nothing on screen suggesting a way back — and the key that does it is
      // not one anybody would guess at. Shown once, briefly, as playback starts.
      if (this.mpv) {
        this.mpv.command('show-text', 'Esc — back to Jellyfin', 4000).catch(() => {});
      }
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
        this.setFullscreen(Boolean(value));
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
        this.stop().catch(() => {});
      }
    });

    // The user pressed q, or mpv fell over. Either way the window must not be left covering the
    // page with nothing drawing into it.
    this.mpv.on('exit', () => {
      this.mpv = null;
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
    this.progressTimer = setInterval(() => {
      if (!this.isActive()) return;
      this.emit('position', { ...this.state }, this.current);
    }, PROGRESS_INTERVAL_MS);
  }

  stopProgress() {
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
    // Only say playback ended if it had actually begun. A stop that arrives when nothing was
    // playing — jellyfin-web sends one on navigation — would otherwise announce itself, and the
    // listener that restores the sidebar would put it back over a site that is in fullscreen.
    if (showing || was) this.emit('active', false, was);
  }

  // Full shutdown, for quitting the app or leaving Jellyfin entirely.
  async destroy() {
    this.stopProgress();
    if (this.mpv) {
      const mpv = this.mpv;
      this.mpv = null;
      await mpv.stop().catch(() => {});
    }
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.host = null;
  }
}

module.exports = { Player };
