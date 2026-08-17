// mpv, driven as a separate process over its JSON IPC socket.
//
// This is the playback engine for Jellyfin, and only for Jellyfin: the user's own server has
// no DRM, so there is nothing stopping us handing the original file to a real player instead
// of asking Chromium to decode it. MKV, H.265, DTS/TrueHD, PGS subtitles and 10-bit video all
// direct-play this way, where the browser player forces the server to transcode them.
//
// Two deliberate choices, both load-bearing:
//
//   * A child process over a socket, not libmpv linked into a native addon. mpv is GPLv2+;
//     spawning it is aggregation, and StreamHub's own code stays MIT. Linking it would make
//     the combined binary GPL. It also means no native module to compile per Electron ABI.
//   * One process per viewing session, kept alive with --idle, rather than one per file.
//     Respawning between episodes would tear the video window down and build it again, which
//     the user sees as a flash of the page behind it.
//
// The window: mpv renders into StreamHub's own window by X11 reparenting (--wid). That is
// proven to work here, and it is also why the Jellyfin web view has to be *hidden* while mpv
// is up rather than layered under it — an X11 child window always draws above its parent's
// content. See the player overlay for what is drawn on top instead.
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// How long to wait for mpv to create its socket before giving up on it.
const CONNECT_TIMEOUT_MS = 5000;
const CONNECT_RETRY_MS = 50;
// A command that never comes back should not leave a promise pending forever.
const COMMAND_TIMEOUT_MS = 10000;
// mpv whose --wid parent window has gone ignores SIGTERM: it is wedged waiting on an X11
// window that no longer exists. Verified. So teardown escalates rather than trusting it.
const KILL_GRACE_MS = 1500;

// Properties worth hearing about unprompted. Everything the OSD, the sleep inhibitor and the
// Jellyfin progress reporting need, and nothing that fires per frame for no reason.
//
// The ids are ours: mpv echoes them back on every change, and they are how a property-change
// event is turned back into a name.
// Note what is deliberately *not* here: `eof-reached`. It only latches while mpv is holding
// the last frame, which is a thing --keep-open=no explicitly stops it doing — verified, it
// never fires for us. "This item finished" is the 'end-file' event with reason 'eof', which is
// what the caller should mark played on.
const OBSERVED = [
  'time-pos',
  'duration',
  'pause',
  'track-list',
  'volume',
  'mute',
  'core-idle',
  'paused-for-cache',
  'media-title',
  // Embedded, mpv cannot take the screen for itself — the window it draws into is not its own.
  // Its fullscreen button and 'f' key still toggle this property though, so watching it is how
  // that intent reaches the app, which *can* do something about it.
  'fullscreen',
];

// Where to put the IPC socket. XDG_RUNTIME_DIR is the right home for one — it is per-user,
// already mode 0700, and cleaned up at logout — and it is short, which matters because a unix
// socket path has a hard length limit far below PATH_MAX. Fall back to the temp dir when it is
// absent (a bare container, some CI).
//
// The socket carries full control of the player, so it must not be world-writable. mpv creates
// it with the process umask; the containing directory is what actually protects it, hence the
// private subdirectory below.
function socketDir() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && path.isAbsolute(runtime) ? runtime : os.tmpdir();
  return path.join(base, 'streamhub');
}

// Resolve the mpv to run: the one packaged inside the app if it is there, otherwise whatever
// the system provides. Task 8 ships a bundled binary so this works on a machine with no mpv
// installed; until then, and when running from source, the system one is used.
//
// `process.resourcesPath` is only meaningful in a packaged app, so guard it.
function resolveBinary() {
  const bundled =
    process.resourcesPath && path.join(process.resourcesPath, 'mpv', 'mpv');
  if (bundled) {
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      // Not packaged, or packaged without mpv: fall through to the system one.
    }
  }
  return 'mpv';
}

// StreamHub's own on-screen controller, if it is there.
//
// mpv's built-in OSC cannot be recoloured — it exposes layout and transparency and nothing else —
// so matching the app's chrome means replacing it with a script of our own. This finds that
// script and, if it exists, hands back a path mpv can actually open.
//
// The copy is the point. mpv is a separate process, and a packaged app keeps its source inside an
// asar archive, which only this process can read: pointing mpv at a path inside the archive gives
// it a file that does not exist as far as it is concerned. Electron's fs can read out of the
// archive, so the script is copied into the runtime directory once and mpv is pointed at the copy.
//
// Returns null when there is no script, and the caller falls back to mpv's own OSC.
function oscScriptPath() {
  const source = path.join(__dirname, 'mpv-osc.lua');
  try {
    fs.accessSync(source, fs.constants.R_OK);
  } catch {
    return null; // not shipped (yet) — mpv's own controller it is
  }
  try {
    const dir = socketDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, 'streamhub-osc.lua');
    fs.copyFileSync(source, dest);
    return dest;
  } catch {
    return null;
  }
}

// Is there an mpv we can actually run? Used to decide whether to offer mpv playback at all,
// so the Jellyfin view can fall back to the browser player instead of failing at play time.
function isAvailable() {
  const bin = resolveBinary();
  if (bin !== 'mpv') return true; // the bundled one, already checked executable
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, 'mpv'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Clear up after a StreamHub that did not exit cleanly.
//
// mpv outlives us if the app is killed rather than closed — the 'closed' handler that would have
// stopped it never runs — and an mpv whose --wid window has been destroyed sits there ignoring
// SIGTERM, holding the GPU and the audio device indefinitely. Verified: one was found still
// running eleven minutes after its parent had gone.
//
// Each socket is named for the app process that created it, so a socket whose owner is no longer
// alive names an mpv nobody is driving. Only a process whose command line contains that exact
// socket path — inside our own runtime directory — is touched, so this cannot reach an mpv the
// user started themselves.
function sweepOrphans() {
  if (process.platform !== 'linux') return;
  const dir = socketDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no directory yet, nothing to clean
  }

  for (const name of names) {
    const match = /^mpv-(\d+)-\d+\.sock$/.exec(name);
    if (!match) continue;
    const owner = Number(match[1]);
    try {
      process.kill(owner, 0);
      continue; // the app that made this socket is still running; leave it alone
    } catch {
      // owner is gone — this socket is stale
    }

    const socketPath = path.join(dir, name);
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let cmdline = '';
        try {
          cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        } catch {
          continue; // process vanished, or not ours to read
        }
        if (!cmdline.includes(socketPath)) continue;
        try {
          // SIGKILL rather than SIGTERM: this is precisely the state mpv refuses to leave politely.
          process.kill(Number(entry), 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* /proc unreadable; the socket is still worth removing */
    }
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* nothing more to do about it */
    }
  }
}

/**
 * One mpv process and the socket that drives it.
 *
 * Emits:
 *   'property'  (name, value) — an observed property changed
 *   'file-loaded'             — a file is open and its tracks are known
 *   'end-file'   (reason)     — playback of one file finished ('eof', 'stop', 'error', …)
 *   'error'      (Error)      — mpv could not be started, or the socket died mid-session
 *   'exit'       (code)       — the process is gone, for any reason
 *
 * Nothing here knows what Jellyfin is: it takes a URL and reports what mpv says about it.
 */
class Mpv extends EventEmitter {
  // `extraArgs` is appended last, so it can override anything above it. It exists for the two
  // cases that genuinely need to differ from the defaults: a harness running without a window
  // (--vo=null), and any per-machine tuning a later setting might expose. It is not a general
  // pass-through for user input — nothing reaches it from a web view.
  constructor({ wid, binary, extraArgs } = {}) {
    super();
    this.wid = wid;
    this.binary = binary || resolveBinary();
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.proc = null;
    this.socket = null;
    this.socketPath = null;
    this.nextRequestId = 1;
    this.pending = new Map(); // request_id -> { resolve, reject, timer }
    this.buffer = '';
    this.stopping = false;
  }

  // Spawn mpv and connect to its socket. Resolves once the socket is answering, so callers can
  // issue commands immediately afterwards.
  async start() {
    if (this.proc) throw new Error('mpv already started');
    this.stopping = false;

    const dir = socketDir();
    // 0o700: the socket inside is the player's full control surface, and the directory is what
    // keeps other users off it.
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Before adding one of our own, clear out any left by an app instance that died.
    sweepOrphans();
    this.socketPath = path.join(dir, `mpv-${process.pid}-${Date.now()}.sock`);
    // A stale socket from a crashed run would make mpv refuse to bind.
    await fs.promises.rm(this.socketPath, { force: true });

    const args = [
      `--input-ipc-server=${this.socketPath}`,
      // Never read the user's ~/.config/mpv. Their own config can set a video output, a
      // profile or a script that breaks playback in here, and they would reasonably blame
      // StreamHub for it. This player is ours; theirs is untouched.
      '--no-config',
      // mpv draws its own controls and takes its own keys.
      //
      // This is the opposite of what it looked like at first. The intent was for StreamHub to
      // draw the player UI in a transparent window over the video, and for mpv to render
      // nothing but frames. That is not possible here: an Electron window cannot be made to
      // composite above the window mpv is rendering into — tested against every combination of
      // parenting, always-on-top and window type. mpv's own OSC is drawn *inside* mpv's window,
      // so it is the one overlay that works by construction.
      '--input-default-bindings',
      '--input-vo-keyboard=yes',
      // Stay alive between files so switching episodes does not tear the window down.
      '--idle=yes',
      // Keep the window up while idle, so there is never a hole where the page shows through.
      '--force-window=yes',
      '--keep-open=no',
      // We are inside another app's window; mpv must not try to own the screen.
      '--no-border',
      '--fullscreen=no',
      // Quiet, but not silent: errors still reach the log, which is how a failed direct play
      // gets diagnosed.
      '--msg-level=all=error',
    ];
    // Under XWayland the X11 EGL context is the one that works; letting mpv autodetect can
    // land it on a Wayland context that cannot reparent into an X11 window id.
    // Whose controls to draw. Ours if we have them — mpv's built-in OSC cannot be given the
    // app's colours — otherwise mpv's, which is a working player rather than no player at all.
    const osc = oscScriptPath();
    if (osc) {
      args.push('--no-osc', `--script=${osc}`);
    } else {
      // mpv's OSC draws a title bar with minimise/maximise/close buttons whenever it believes it
      // owns a borderless window, which it does here because of --no-border above. Inside
      // StreamHub's own window those control a window with no visible edges, and "close" would
      // close our host out from under the video.
      args.push('--osc', '--script-opts=osc-windowcontrols=no');
    }

    if (this.wid !== undefined && this.wid !== null) {
      args.push(`--wid=${this.wid}`, '--gpu-context=x11egl');
    }
    args.push(...this.extraArgs);

    this.proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stderr.on('data', (d) => {
      // Jellyfin's stream URLs carry the access token as a query parameter, and mpv prints the
      // URL it failed to open. That would put a working credential into the journal, so it is
      // taken out on the way past.
      const text = String(d).replace(/([?&](?:api_key|X-Emby-Token)=)[^&\s]+/gi, '$1[redacted]').trim();
      // eslint-disable-next-line no-console
      if (text) console.warn('[mpv]', text);
    });
    this.proc.on('error', (err) => {
      this.emit('error', err);
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.failAllPending(new Error('mpv exited'));
      this.emit('exit', code);
    });

    await this.connect();
    await this.observeAll();
    await this.bindKeys();
  }

  /**
   * Keys that have to mean something different in here than they do in a standalone mpv.
   *
   * While a film is playing mpv has the keyboard and the app's own chrome is hidden, so mpv's
   * idea of "quit" is the user's only way back to the library — and mpv's default for it is to
   * end the process, which would leave nothing to start the next episode with.
   *
   * So both of the keys a person reaches for to get out of something are turned into a message
   * to the app instead. The app decides what leaving means (see the handler in player.js): out of
   * fullscreen if it is fullscreen, otherwise back to the library, with mpv left running and idle.
   */
  bindKeys() {
    return Promise.all([
      this.command('keybind', 'ESC', 'script-message streamhub-escape').catch(() => {}),
      this.command('keybind', 'q', 'script-message streamhub-escape').catch(() => {}),
    ]);
  }

  // mpv creates the socket a moment after it starts, so connecting is a retry loop rather than
  // a single attempt. Bounded, so a binary that dies immediately fails fast instead of hanging.
  async connect() {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    for (;;) {
      if (!this.proc) throw new Error('mpv exited before its socket appeared');
      try {
        this.socket = await this.tryConnectOnce();
        break;
      } catch (err) {
        if (Date.now() >= deadline) {
          throw new Error(`could not connect to mpv: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
      }
    }

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => {
      if (!this.stopping) this.emit('error', err);
    });
    this.socket.on('close', () => {
      this.socket = null;
      this.failAllPending(new Error('mpv socket closed'));
    });
  }

  tryConnectOnce() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const onError = (err) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        resolve(sock);
      });
    });
  }

  // mpv speaks line-delimited JSON in both directions. A read can split mid-line, so hold the
  // remainder until its newline arrives.
  onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON; mpv occasionally writes a stray line, and it is not ours to act on
    }

    // A reply to something we asked.
    if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
      const entry = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      clearTimeout(entry.timer);
      if (msg.error && msg.error !== 'success') {
        entry.reject(new Error(`mpv: ${msg.error}`));
      } else {
        entry.resolve(msg.data);
      }
      return;
    }

    if (!msg.event) return;
    if (msg.event === 'property-change') {
      this.emit('property', msg.name, msg.data);
      return;
    }
    if (msg.event === 'file-loaded') {
      this.emit('file-loaded');
      return;
    }
    if (msg.event === 'end-file') {
      this.emit('end-file', msg.reason);
      return;
    }
    // A key bound to `script-message` arrives as a client-message. It is how mpv, which owns the
    // keyboard while it is on screen, hands an intention back to the app.
    if (msg.event === 'client-message' && Array.isArray(msg.args) && msg.args.length) {
      this.emit('client-message', msg.args[0], msg.args.slice(1));
    }
  }

  // Send a command and wait for its reply. Every command carries a request_id so replies can be
  // matched even though several may be in flight at once.
  command(...args) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('mpv is not connected'));
        return;
      }
      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`mpv command timed out: ${args[0]}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ command: args, request_id: requestId })}\n`);
    });
  }

  observeAll() {
    return Promise.all(
      OBSERVED.map((name, i) => this.command('observe_property', i + 1, name).catch(() => {})),
    );
  }

  getProperty(name) {
    return this.command('get_property', name);
  }

  setProperty(name, value) {
    return this.command('set_property', name, value);
  }

  /**
   * Open a URL.
   *
   * Start position, track selection and HTTP headers are set as properties *before* loadfile
   * rather than passed as its per-file options argument. That is deliberate: mpv changed
   * loadfile's signature (an `index` parameter was inserted before `options` in 0.38), so the
   * positional form means something different depending on the mpv in play. Properties have
   * been stable throughout, and this module has to work against both a bundled mpv and
   * whatever the system happens to have.
   */
  async load(url, { startSeconds = 0, audioId, subtitleId, headers } = {}) {
    // A header list is how the Jellyfin access token reaches the server: the stream URL is
    // authenticated, and mpv is a separate process that knows nothing about the web view's
    // session.
    // Always set this, even to nothing.
    //
    // It is a persistent property, so headers left from the last item are still armed for the
    // next one — after signing into a different account the previous token would ride along with
    // the new stream's own credentials, which some servers answer with a 401.
    //
    // Names and values are filtered rather than trusted. They arrive from a web page and mpv
    // joins them with CRLF into ffmpeg's header option, so a newline in a value writes headers of
    // the page's choosing into the request.
    const fields = [];
    for (const [name, value] of Object.entries(headers || {})) {
      const key = String(name).replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '');
      const val = String(value).replace(/[\r\n]/g, ' ').trim();
      if (key && val) fields.push(`${key}: ${val}`);
    }
    await this.setProperty('http-header-fields', fields).catch(() => {});
    await this.setProperty('start', startSeconds > 0 ? String(startSeconds) : '0').catch(
      () => {},
    );
    // 'auto' rather than 'no': the server's default track is the right one until the user says
    // otherwise, and mpv picks it the same way any player would.
    await this.setProperty('aid', audioId === undefined ? 'auto' : audioId).catch(() => {});
    await this.setProperty('sid', subtitleId === undefined ? 'auto' : subtitleId).catch(
      () => {},
    );
    await this.command('loadfile', url, 'replace');
  }

  play() {
    return this.setProperty('pause', false);
  }

  pause() {
    return this.setProperty('pause', true);
  }

  // Absolute seek, in seconds. 'exact' because a seek bar the user dragged should land where
  // they dropped it rather than at the nearest keyframe.
  seek(seconds) {
    return this.command('seek', seconds, 'absolute+exact');
  }

  setVolume(percent) {
    return this.setProperty('volume', Math.max(0, Math.min(100, percent)));
  }

  setMuted(muted) {
    return this.setProperty('mute', Boolean(muted));
  }

  setAudioTrack(id) {
    return this.setProperty('aid', id === null ? 'no' : id);
  }

  setSubtitleTrack(id) {
    return this.setProperty('sid', id === null ? 'no' : id);
  }

  // Stop playing but leave the process up, so the next item does not pay to start mpv again.
  stopPlayback() {
    return this.command('stop').catch(() => {});
  }

  /**
   * Shut mpv down and clean up after it.
   *
   * Escalates deliberately: 'quit' over the socket is the polite exit, SIGTERM if the socket
   * has already gone, and SIGKILL if neither lands. That last step is not paranoia — an mpv
   * whose --wid parent window has been destroyed sits there ignoring SIGTERM, which would
   * otherwise leave a stray process holding the GPU every time the window closed.
   */
  async stop() {
    this.stopping = true;
    const proc = this.proc;

    if (this.socket) {
      try {
        this.socket.write(`${JSON.stringify({ command: ['quit'] })}\n`);
      } catch {
        // socket already gone; the signals below are the fallback
      }
    }

    if (proc) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(term);
          clearTimeout(hard);
          resolve();
        };
        proc.once('exit', done);
        const term = setTimeout(() => {
          try {
            proc.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS / 2);
        const hard = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          done();
        }, KILL_GRACE_MS);
      });
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.proc = null;
    this.failAllPending(new Error('mpv stopped'));

    if (this.socketPath) {
      await fs.promises.rm(this.socketPath, { force: true }).catch(() => {});
      this.socketPath = null;
    }
  }

  failAllPending(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { Mpv, isAvailable, resolveBinary };
