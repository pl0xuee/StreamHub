// The shell half of the Jellyfin integration: what jellyfin-web is told about us.
//
// Like enhance-youtube.js, this module runs in the main process but exports no behaviour of its
// own — what it produces is the *source* of a controller that is injected into the Jellyfin view.
// Unlike that one, it is not a cosmetic tweak layered onto someone else's page: it implements an
// extension point jellyfin-web already looks for.
//
// jellyfin-web checks `window.NativeShell` at startup and, if it finds one, folds the plugins it
// returns into its own plugin list and defers to its AppHost for device identity and capabilities.
// That contract exists precisely so a desktop shell can take playback away from the browser; the
// TV and Android webview clients use the same one. So we do not patch or fight the page — we
// answer the questions it was already going to ask, and in return we get all of Jellyfin's UI,
// library browsing and server management unchanged.
//
// Two things are won here, and they are the entire point of the feature:
//
//   * A media player plugin that ranks ahead of jellyfin-web's HTML5 player, so pressing play
//     hands the stream to mpv (via the preload bridge) instead of creating a <video>.
//   * A permissive device profile, so /Items/{id}/PlaybackInfo answers "Direct Play" rather than
//     spinning up a transcode. mpv can take the original file; saying so is what stops the
//     server re-encoding MKV/H.265/TrueHD/PGS for a decoder we are not using.
//
// This code is written from scratch against the documented interface. Jellyfin Desktop and
// jellyfin-web are GPL-2.0 and this repo is MIT: nothing may be copied from either, so what
// follows is our own implementation of the same contract, not an adaptation of theirs.
//
// The page has no IPC of its own. Everything native goes through `window.__streamhubJellyfin`,
// the object the Jellyfin preload puts there. **If that object is absent the script installs
// nothing at all** and jellyfin-web keeps its own HTML5 player — that is the fallback path for
// grid mode, for the setting being off, and for anything that goes wrong before us. Failing
// safe matters more than failing loudly here: a thrown exception during the page's bootstrap
// could take the whole client down, so nothing in the injected source is allowed to escape.
//
// Timing note for whoever wires the injection: jellyfin-web reads window.NativeShell while it
// boots, so the earlier this runs the better. It is a plain expression with no dependencies, so
// the preload can evaluate the same string at document-start; the dom-ready path only works
// because the guard below makes a second run a reconfiguration rather than a second install.

const APP_VERSION = require('../package.json').version;

// Where the preload parks the native bridge, and where we park ourselves. Both are read by the
// injected source only; nothing else in the app should reach for them by name.
const BRIDGE_KEY = '__streamhubJellyfin';
const SHELL_KEY = '__streamhubJellyfinShell';

// jellyfin-web picks a player by sorting the candidates on `priority` and taking the first that
// will accept the item, so a *lower* number wins. Its own HTML5 video player sits at 1; sitting
// below that is how we get asked first, and leaving it in the list is how playback still happens
// if we ever decline an item.
const PLAYER_PRIORITY = -1;

// One tick is 100ns. Jellyfin speaks ticks, mpv and the bridge speak seconds, jellyfin-web's
// player interface speaks milliseconds — all three conversions live in the injected source.
const TICKS_PER_SECOND = 10000000;

// The permissive direct-play profile, and the whole argument of this feature in one object.
//
// A device profile is a promise to the server about what this client can take. jellyfin-web's
// browser profile is an honest account of what Chromium will decode, which is why Jellyfin
// transcodes so much for it. Ours is an account of what mpv will decode, which is very nearly
// everything, so the sensible answer for the server is to send the file untouched.
//
// The bitrate ceilings are deliberately absurd: the stream is coming off the user's own server,
// usually over a LAN, and a low cap is itself a reason for the server to transcode. Codec lists
// are given per container rather than as one blanket entry because that is the shape the server
// matches against, and an entry with no VideoCodec/AudioCodec at all is read as "any", which
// some server versions treat more conservatively than an explicit list.
//
// Subtitles are where the profile earns its keep twice over. Text formats are advertised
// External so the server hands us a URL and mpv loads the real file — no burn-in, no re-encode
// of the video just to stamp words on it. Image formats (PGS, VOBSUB) are the case that forces
// browser clients to transcode the entire video, and are advertised Embed: leave them in the
// container and mpv will render them itself.
const DEVICE_PROFILE = {
  MaxStreamingBitrate: 1000000000,
  MaxStaticBitrate: 1000000000,
  MusicStreamingTranscodingBitrate: 1280000,
  DirectPlayProfiles: [
    {
      Type: 'Video',
      Container: 'mkv,mp4,m4v,mov,avi,ts,m2ts,mpegts,webm,flv,wmv,asf,mpg,mpeg,3gp,ogv',
      VideoCodec: 'h264,hevc,h265,vp8,vp9,av1,mpeg2video,mpeg4,vc1,theora,wmv3,msmpeg4v3',
      AudioCodec:
        'aac,ac3,eac3,dts,dca,truehd,mlp,flac,alac,mp3,mp2,opus,vorbis,pcm,pcm_s16le,pcm_s24le,' +
        'wmav2,wmapro',
    },
    {
      Type: 'Audio',
      Container: 'flac,alac,aac,m4a,mp3,ogg,oga,opus,wav,wma,ape,wv,dsf,dff,mka,aiff',
    },
  ],
  // Kept deliberately thin. These exist so a genuinely exotic file still plays rather than
  // failing outright; every profile above should beat them to it. Remuxing to Matroska rather
  // than HLS keeps the server's work to a copy where it can manage one.
  TranscodingProfiles: [
    {
      Type: 'Video',
      Container: 'mkv',
      Protocol: 'http',
      VideoCodec: 'h264,hevc',
      AudioCodec: 'aac,ac3,eac3,mp3,flac,opus',
      Context: 'Streaming',
      CopyTimestamps: true,
      MaxAudioChannels: '8',
    },
    {
      Type: 'Audio',
      Container: 'mp3',
      Protocol: 'http',
      AudioCodec: 'mp3',
      Context: 'Streaming',
      MaxAudioChannels: '2',
    },
  ],
  // Nothing to say. An empty list is "no constraints"; entries here are how a client asks the
  // server to re-encode things it cannot handle, and we can handle them.
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: [
    { Format: 'srt', Method: 'External' },
    { Format: 'subrip', Method: 'External' },
    { Format: 'ass', Method: 'External' },
    { Format: 'ssa', Method: 'External' },
    { Format: 'vtt', Method: 'External' },
    { Format: 'webvtt', Method: 'External' },
    { Format: 'sub', Method: 'External' },
    { Format: 'idx', Method: 'External' },
    { Format: 'smi', Method: 'External' },
    { Format: 'ttml', Method: 'External' },
    { Format: 'srt', Method: 'Embed' },
    { Format: 'subrip', Method: 'Embed' },
    { Format: 'ass', Method: 'Embed' },
    { Format: 'ssa', Method: 'Embed' },
    { Format: 'mov_text', Method: 'Embed' },
    { Format: 'dvbsub', Method: 'Embed' },
    { Format: 'dvdsub', Method: 'Embed' },
    { Format: 'vobsub', Method: 'Embed' },
    { Format: 'pgs', Method: 'Embed' },
    { Format: 'pgssub', Method: 'Embed' },
  ],
  ResponseProfiles: [],
};

// The controller, as source to be injected into the Jellyfin view.
//
// `options` carries the identity the server will remember this client by: `deviceId` (stable
// across runs, or the page keeps its own — see below), `deviceName` (what shows in the server's
// Devices list and on the Dashboard's active sessions), `appName` and `appVersion`.
//
// Idempotent by design, the same way enhance-youtube.js is: it parks itself on
// window.__streamhubJellyfinShell, so a second injection into the same document reconfigures the
// controller already there rather than registering a second player and a second event
// subscription. A *new* document gets a fresh window and so installs from scratch.
function jellyfinShellJs(options) {
  const opts = options || {};
  const cfg = JSON.stringify({
    deviceId: typeof opts.deviceId === 'string' && opts.deviceId ? opts.deviceId : null,
    deviceName: opts.deviceName || 'StreamHub',
    appName: opts.appName || 'StreamHub',
    appVersion: opts.appVersion || APP_VERSION,
    bridgeKey: BRIDGE_KEY,
    shellKey: SHELL_KEY,
    playerPriority: PLAYER_PRIORITY,
    ticksPerSecond: TICKS_PER_SECOND,
  });
  const profile = JSON.stringify(DEVICE_PROFILE);

  return `(() => {
  'use strict';
  try {
    const CFG = ${cfg};
    const PROFILE = ${profile};

    // No bridge, no shell. The preload only attaches one for the user's own Jellyfin server, and
    // only when mpv playback is meant to be on, so its absence is a decision rather than a fault:
    // leave window.NativeShell untouched and jellyfin-web plays in its own HTML5 player exactly
    // as it does today.
    const bridge = window[CFG.bridgeKey];
    if (!bridge || typeof bridge.play !== 'function') return 'no-bridge';

    // Second injection into a document we have already done. Everything below is already wired,
    // so take the new identity and stop — re-running it would stack a second onEvent subscription
    // on the bridge and emit every event twice.
    const existing = window[CFG.shellKey];
    if (existing && typeof existing.configure === 'function') {
      existing.configure(CFG);
      return 'reconfigured';
    }

    let config = CFG;

    // Nothing this script does is worth breaking the client over: a page that half-loads because
    // our plugin threw is a worse outcome than one that quietly falls back. Every callback the
    // page or the bridge can reach goes through here.
    function safely(fn) {
      try {
        return fn();
      } catch (err) {
        try {
          console.warn('[StreamHub] jellyfin shell:', err);
        } catch (ignored) { /* console is not worth a second failure */ }
        return undefined;
      }
    }

    function num(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }

    // The device the server remembers. A device id that changes between launches shows up as a
    // new entry in the Dashboard's device list every time and loses that device's settings, so
    // if the main process did not supply a stable one the page keeps its own rather than inventing
    // a fresh id per run. localStorage is per-partition and the Jellyfin view has its own, so this
    // is as durable as the login sitting beside it.
    const DEVICE_ID_KEY = 'streamhub-jellyfin-device-id';
    function deviceId() {
      if (config.deviceId) return config.deviceId;
      const stored = safely(() => window.localStorage.getItem(DEVICE_ID_KEY));
      if (stored) return stored;
      const made =
        'streamhub-' +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10);
      safely(() => window.localStorage.setItem(DEVICE_ID_KEY, made));
      return made;
    }

    // A private copy per caller. The profile is handed to jellyfin-web, which merges and mutates
    // profiles on its way to the server; sharing one object would let one playback's edits leak
    // into the next.
    function deviceProfile() {
      return JSON.parse(JSON.stringify(PROFILE));
    }

    // ---- events -------------------------------------------------------------------------
    //
    // jellyfin-web subscribes to its players two different ways depending on how it was built:
    // through a global event helper that parks callbacks on the player object itself, and — for
    // shell-supplied plugins — through the plugin's own on/off. Support both, because which one
    // we get is not ours to choose, and dispatch through exactly one of them per event so a
    // handler registered once is never called twice.
    const listeners = new Map();

    function on(name, fn) {
      if (typeof fn !== 'function') return;
      const list = listeners.get(name) || [];
      list.push(fn);
      listeners.set(name, list);
    }

    function off(name, fn) {
      const list = listeners.get(name);
      if (!list) return;
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    }

    // The host's helper hands handlers an event object first and the extras after, so ours does
    // too — a handler written for one must work when called by the other.
    function emit(name, detail) {
      const event = { type: name };
      const own = listeners.get(name);
      if (own) {
        for (const fn of own.slice()) safely(() => fn(event, detail));
      }

      const host = window.Events || window.events;
      if (host && typeof host.trigger === 'function') {
        safely(() => host.trigger(player, name, detail === undefined ? [] : [detail]));
        return;
      }

      // No helper on the window, so the page attached straight to us. Whatever it parked is a
      // plain map of arrays keyed by event name; some builds prefix the key.
      const parked = player._callbacks;
      if (!parked) return;
      const direct = parked[name] || parked['$' + name];
      if (!direct || typeof direct.slice !== 'function') return;
      for (const fn of direct.slice()) {
        if (typeof fn === 'function') safely(() => fn.call(player, event, detail));
      }
    }

    // ---- playback state -----------------------------------------------------------------
    //
    // Position and duration live over IPC, and jellyfin-web asks for them far more often than a
    // round trip is worth — every progress report, every OSD tick. So the events pushed from
    // main keep a local mirror, and the reads answer from it. currentTime() still asks the bridge
    // (it is the one read where being a second stale is visible), but falls back here.
    const state = {
      started: false,
      paused: true,
      positionMs: 0,
      durationMs: 0,
      volume: 100,
      muted: false,
      src: null,
    };

    // Take whatever a bridge event or getState() happened to include. Both speak seconds; both
    // send only the fields they know, so a missing one must leave the mirror alone rather than
    // zeroing it.
    function absorb(data) {
      if (!data || typeof data !== 'object') return;
      const position = num(data.positionSeconds);
      if (position !== null) state.positionMs = position * 1000;
      const duration = num(data.durationSeconds);
      if (duration !== null && duration > 0) state.durationMs = duration * 1000;
      if (typeof data.paused === 'boolean') state.paused = data.paused;
      const volume = num(data.volume);
      if (volume !== null) state.volume = volume;
      if (typeof data.muted === 'boolean') state.muted = data.muted;
    }

    // One 'stopped' per session, whoever notices first — the bridge pushing the event, or
    // jellyfin-web calling stop(). The position is deliberately left standing: jellyfin-web reads
    // currentTime() *after* the stop to decide the resume point, and a zeroed mirror there would
    // report every stopped item as watched from the beginning.
    function endSession() {
      if (!state.started) return;
      state.started = false;
      state.paused = true;
      state.src = null;
      emit('stopped');
    }

    // ---- the player plugin --------------------------------------------------------------

    // Everything jellyfin-web needs to hand a stream over, dug out of the options object it
    // passes to play(). Which fields are present varies with the version and with how playback
    // was started, so each one is looked for in the places it has been known to be rather than
    // assumed.
    function resolveStream(options) {
      const opts = options || {};
      const source = opts.mediaSource || {};
      const item = opts.item || {};

      const raw = opts.url || source.TranscodingUrl || source.Path || null;
      if (!raw) return null;

      // mpv is a separate process with no notion of the page's location, and the server may sit
      // under a path on a reverse proxy, so every URL leaves here absolute. Same reason
      // AppHost.useFullSubtitleUrls is set: relative subtitle URLs would be unresolvable.
      let url = raw;
      safely(() => {
        url = new URL(raw, document.baseURI).href;
      });

      const startTicks =
        num(opts.playerStartPositionTicks) !== null
          ? opts.playerStartPositionTicks
          : num(opts.startPositionTicks) !== null
            ? opts.startPositionTicks
            : 0;

      // Stream indices as Jellyfin numbers them within the media source. Mapping those onto mpv's
      // own track ids is main's job — it is the side that can see mpv's track list.
      const audioIndex =
        num(opts.audioStreamIndex) !== null
          ? opts.audioStreamIndex
          : num(source.DefaultAudioStreamIndex);
      const subtitleIndex =
        num(opts.subtitleStreamIndex) !== null
          ? opts.subtitleStreamIndex
          : num(source.DefaultSubtitleStreamIndex);

      return {
        url: url,
        // What mpv should call this. Without it mpv falls back to the file name it was handed,
        // which for a Jellyfin stream is the raw /Videos/.../stream.mkv?Static=true... URL —
        // query string and all — displayed across the top of the picture.
        title: item.Name || null,
        itemId: item.Id || opts.itemId || null,
        mediaSourceId: source.Id || opts.mediaSourceId || null,
        startPositionTicks: startTicks,
        audioIndex: audioIndex,
        subtitleIndex: subtitleIndex,
        headers: authHeaders(),
        // Who to report progress to. jellyfin-web does its own reporting for players it drives
        // itself, but playback is happening in another process here and the page cannot see how
        // far mpv has got, so the main process reports instead — and it needs the address, the
        // token and the user to do it. Without this the server never learns a position and the
        // item has no resume point.
        server: serverInfo(),
      };
    }

    // Address, token and user id, read from the client the page is already signed in with. All
    // three come from ApiClient rather than being configured anywhere, so they follow the user
    // switching server or account without StreamHub having to be told.
    function serverInfo() {
      const api = window.ApiClient;
      if (!api) return null;
      const info = {};
      safely(() => {
        info.serverUrl = typeof api.serverAddress === 'function' ? api.serverAddress() : null;
      });
      safely(() => {
        info.token = typeof api.accessToken === 'function' ? api.accessToken() : null;
      });
      safely(() => {
        info.userId = typeof api.getCurrentUserId === 'function' ? api.getCurrentUserId() : null;
      });
      // The same device id this client identifies itself with, so the app's progress reports join
      // the session jellyfin-web already opened rather than opening a second, nameless one. An
      // empty device id is refused by the server outright.
      safely(() => {
        info.deviceId = deviceId();
      });
      return info.serverUrl && info.token ? info : null;
    }

    // Stream URLs built by jellyfin-web usually carry the token as a query parameter already, but
    // subtitle and attachment URLs do not always, and a server behind auth-enforcing middleware
    // wants the header regardless. Cheap to send, and mpv is talking to the user's own server.
    function authHeaders() {
      const headers = {};
      const api = window.ApiClient;
      if (!api) return headers;
      safely(() => {
        const token = typeof api.accessToken === 'function' ? api.accessToken() : null;
        if (token) headers['X-Emby-Token'] = token;
      });
      return headers;
    }

    // A bridge call that must never reject into jellyfin-web. The native side reports real
    // failures as an 'error' event, which is the path the client already knows how to handle.
    function call(name, arg) {
      return new Promise((resolve) => {
        if (typeof bridge[name] !== 'function') {
          resolve(undefined);
          return;
        }
        let result;
        try {
          result = arg === undefined ? bridge[name]() : bridge[name](arg);
        } catch (err) {
          safely(() => console.warn('[StreamHub] jellyfin bridge ' + name + ':', err));
          resolve(undefined);
          return;
        }
        Promise.resolve(result).then(resolve, () => resolve(undefined));
      });
    }

    // The plugin object itself. jellyfin-web's pluginManager accepts either an instance or a
    // constructor from getPlugins(); the factory below covers both, and every call to it hands
    // back this same object so the event wiring stays in one place however many times the manager
    // decides to build one.
    const player = {
      name: 'MPV Video Player',
      id: 'mpvvideoplayer',
      type: 'mediaplayer',
      priority: config.playerPriority,

      // Playing on this machine, not casting to another one — this is what keeps jellyfin-web
      // driving us directly instead of routing through its remote-control paths.
      isLocalPlayer: true,

      // Video only, and on purpose: music is short, always direct-plays in the browser anyway,
      // and routing it through mpv would mean hiding the page (and so the queue and the now-
      // playing bar) to show a black rectangle. jellyfin-web keeps its own audio player.
      canPlayMediaType: function (mediaType) {
        return String(mediaType || '').toLowerCase() === 'video';
      },

      // The media type check above has already run by the time this is asked; anything that gets
      // here is a video item, and the whole point of the profile is that we take all of them.
      canPlayItem: function () {
        return true;
      },

      // Optional player features, none of which we claim. Playback speed, brightness and aspect
      // ratio are all things mpv could do, but the bridge has no call for them yet and jellyfin-
      // web hides the controls for anything answered false — better a missing button than one
      // that does nothing.
      supports: function () {
        return false;
      },

      getDeviceProfile: function () {
        return Promise.resolve(deviceProfile());
      },

      currentSrc: function () {
        return state.src;
      },

      // Hand the stream to mpv. No 'playing' is emitted here: main pushes that once the file is
      // actually open, and emitting it optimistically would have jellyfin-web report playback
      // started for a file that turned out not to open.
      play: function (options) {
        const stream = resolveStream(options);
        if (!stream) return Promise.reject(new Error('No playable URL in play options'));
        state.src = stream.url;
        state.positionMs = (stream.startPositionTicks || 0) / config.ticksPerSecond * 1000;
        state.durationMs = 0;
        state.paused = false;
        return call('play', stream);
      },

      // destroyPlayer is jellyfin-web saying it is finished with this player entirely, not just
      // with this item. There is nothing of ours to tear down — the bridge belongs to the
      // document — so it only decides whether the stop is final.
      stop: function (destroyPlayer) {
        return call('stop').then(function () {
          endSession();
          if (destroyPlayer) player.destroy();
        });
      },

      destroy: function () {
        state.src = null;
      },

      pause: function () {
        state.paused = true;
        return call('pause');
      },

      unpause: function () {
        state.paused = false;
        return call('unpause');
      },

      togglePause: function () {
        return state.paused ? player.unpause() : player.pause();
      },

      paused: function () {
        return state.paused;
      },

      // Getter and setter in one, as jellyfin-web's player interface expects, in milliseconds.
      // The getter returns a promise — AppHost.currentTimeAsync is set for exactly this, because
      // the true position is a round trip away. The setter updates the mirror before the seek
      // lands so a read in between does not answer with the position we just left.
      //
      // Once the session is over the mirror is the only truth there is: jellyfin-web reads this
      // after 'stopped' to work out the resume point, and by then mpv has no position to report.
      currentTime: function (ms) {
        if (ms !== null && ms !== undefined) {
          const seconds = Number(ms) / 1000;
          if (!isFinite(seconds)) return undefined;
          state.positionMs = seconds * 1000;
          call('seek', seconds);
          return undefined;
        }
        if (!state.started) return Promise.resolve(state.positionMs);
        return call('getState').then(function (snapshot) {
          absorb(snapshot);
          return state.positionMs;
        });
      },

      duration: function () {
        return state.durationMs || null;
      },

      volume: function (value) {
        if (value !== null && value !== undefined) {
          player.setVolume(value);
          return undefined;
        }
        return state.volume;
      },

      getVolume: function () {
        return state.volume;
      },

      // Volume changes are echoed straight back rather than waited on: the slider under the
      // pointer has to move now, and main is not going to disagree about a number it was given.
      setVolume: function (value) {
        const wanted = Math.max(0, Math.min(100, Number(value)));
        if (!isFinite(wanted)) return;
        state.volume = wanted;
        call('setVolume', wanted);
        emit('volumechange');
      },

      volumeUp: function () {
        player.setVolume(state.volume + 5);
      },

      volumeDown: function () {
        player.setVolume(state.volume - 5);
      },

      setMute: function (muted) {
        state.muted = Boolean(muted);
        call('setMuted', state.muted);
        emit('volumechange');
      },

      isMuted: function () {
        return state.muted;
      },

      toggleMute: function () {
        player.setMute(!state.muted);
      },

      // Track selection, in Jellyfin's stream indices. The mirrors are kept so jellyfin-web's
      // menus show a tick against the track that is playing without another round trip.
      getAudioStreamIndex: function () {
        return state.audioIndex === undefined ? null : state.audioIndex;
      },

      setAudioStreamIndex: function (index) {
        state.audioIndex = index;
        return call('setAudioTrack', index);
      },

      getSubtitleStreamIndex: function () {
        return state.subtitleIndex === undefined ? null : state.subtitleIndex;
      },

      // -1 is Jellyfin's "no subtitles"; it is passed through rather than translated, because
      // main is the side that knows what mpv calls off.
      setSubtitleStreamIndex: function (index) {
        state.subtitleIndex = index;
        return call('setSubtitleTrack', index);
      },

      on: on,
      off: off,
      once: function (name, fn) {
        const wrapped = function (event, detail) {
          off(name, wrapped);
          fn(event, detail);
        };
        on(name, wrapped);
      },
      addEventListener: on,
      removeEventListener: off,
    };

    state.audioIndex = null;
    state.subtitleIndex = null;

    // What getPlugins() hands over. Returning an object from a constructor is what makes this
    // work whether the plugin manager calls it plainly or with 'new', and either way it is the
    // one player above rather than a fresh one.
    function MpvVideoPlayer() {
      return player;
    }
    MpvVideoPlayer.prototype = player;

    // ---- the bridge's events ------------------------------------------------------------
    //
    // Subscribed once, for the life of the document. main is the authority on what playback is
    // doing — it is the side holding mpv's IPC socket — so these drive the mirror and the
    // outgoing events, and the methods above only ever ask for things to happen.
    if (typeof bridge.onEvent === 'function') {
      safely(function () {
        bridge.onEvent(function (event) {
          if (!event || typeof event !== 'object') return;
          absorb(event);
          switch (event.type) {
            case 'timeupdate':
              if (state.started) emit('timeupdate');
              break;
            // 'playing' arrives both when a file opens and when a paused one resumes; jellyfin-web
            // means two different things by those. Reporting a resume as a start would have it
            // begin a second playback session against the server for the same item.
            case 'playing':
              state.paused = false;
              if (!state.started) {
                state.started = true;
                emit('playing');
              } else {
                emit('unpause');
              }
              break;
            case 'paused':
              state.paused = true;
              emit('pause');
              break;
            case 'stopped':
              endSession();
              break;
            // No 'stopped' alongside this one: jellyfin-web's error handling tears the session
            // down itself, and a second teardown behind it reports the item stopped twice.
            case 'error':
              state.started = false;
              state.paused = true;
              emit('error', event.error || event.message || null);
              break;
            default:
              break;
          }
        });
      });
    }

    // ---- NativeShell --------------------------------------------------------------------
    //
    // The object jellyfin-web goes looking for. Members are individually optional — anything
    // absent falls back to the client's own browser behaviour — so this is deliberately only what
    // StreamHub can actually honour.
    const appHost = {
      // Identity, as the server's Dashboard will show it. Returned plainly rather than as a
      // promise because callers read the fields straight off it.
      init: function () {
        return { deviceId: deviceId(), deviceName: config.deviceName };
      },

      deviceId: deviceId,
      deviceName: function () {
        return config.deviceName;
      },
      appName: function () {
        return config.appName;
      },
      appVersion: function () {
        return config.appVersion;
      },

      // Which layout the client should start in. jellyfin-web calls this during bootstrap and
      // does not guard the call, so leaving it out throws before the app finishes starting and
      // the page sits on the splash screen forever — which is exactly what happened.
      //
      // 'desktop' because that is what this is: a mouse and a keyboard at a normal viewing
      // distance. 'tv' would give the ten-foot layout, which is wrong for a desktop window.
      getDefaultLayout: function () {
        return 'desktop';
      },

      // Screen geometry, used to decide image sizes to request from the server. Reported from
      // the window rather than guessed, and null when there is nothing to report, which is the
      // shape jellyfin-web expects when a shell cannot answer.
      screen: function () {
        try {
          if (!window.screen) return null;
          return {
            width: window.screen.width,
            height: window.screen.height,
          };
        } catch (err) {
          return null;
        }
      },

      // Capabilities, each a claim jellyfin-web will act on by showing or hiding UI. The rule
      // for adding to this list is that the app must genuinely do the thing — an unchecked true
      // here becomes a button that silently does nothing.
      supports: function (command) {
        const name = String(command || '').toLowerCase();
        switch (name) {
          // Links and downloads leave the page: the window-open handler sends them to a real
          // child window, which is where a login or a file save belongs.
          case 'externallinks':
          case 'targetblank':
          case 'filedownload':
            return true;
          // The user's servers are their own business and StreamHub does not pin the view to
          // one, so let them switch.
          case 'multiserver':
          case 'displaylanguage':
            return true;
          // mpv is not gated behind a user gesture the way a browser's <video> is.
          case 'htmlvideoautoplay':
          case 'htmlaudioautoplay':
            return true;
          // Everything else — quitting the app, fullscreen, screensavers, subtitle appearance,
          // physical volume, remote control. Some are StreamHub's own chrome to own rather than
          // the page's; the rest are settings that would not reach mpv.
          default:
            return false;
        }
      },

      // jellyfin-web offers its own profile builder here; ours is a fixed answer, so it is
      // ignored. This is the reply that decides Direct Play versus transcode.
      getDeviceProfile: function () {
        return deviceProfile();
      },

      // Advertised as unsupported above, so nothing should call this. Defined anyway because a
      // missing member on an object the client pokes at is a harder failure than a no-op.
      exit: function () {},

      // mpv loads external subtitles itself and has no page to resolve a relative URL against,
      // so the server must be asked for absolute ones.
      useFullSubtitleUrls: true,

      // Position comes back over IPC, so currentTime() answers with a promise. jellyfin-web
      // needs telling, or it will read the promise object as a number.
      currentTimeAsync: true,
    };

    const nativeShell = {
      AppHost: appHost,

      // Straight to a real window rather than anything native: the app's window-open handler
      // already decides what may open and gives the child the same session, which is what makes
      // an OAuth or a payment flow work.
      openUrl: function (url, target) {
        if (!url) return;
        safely(function () {
          window.open(url, target || '_blank');
        });
      },

      // Same route. Chromium's download handling is what actually saves the file; the page only
      // needs the URL to reach a context that can start one.
      downloadFile: function (info) {
        const url = typeof info === 'string' ? info : info && info.url;
        if (!url) return;
        nativeShell.openUrl(url, '_blank');
      },

      // StreamHub's settings live in its own chrome, not in a dialog raised from inside a
      // service's page. Present but empty, because jellyfin-web offers a client-settings entry
      // whenever a NativeShell exists at all and a missing method there would throw at the click.
      openClientSettings: function () {},

      // NOTE: no backticks anywhere in this comment. It lives inside the template literal that
      // builds the injected source, so one would close that literal and break the whole module.
      //
      // jellyfin-web loads its own plugins by dynamic import of a module path, and then
      // constructs the module's default export. Ours has to arrive looking exactly like that: a
      // Promise resolving to a *module namespace* — an object carrying a default property —
      // whose default is a constructor. Not the function on its own, which fails with "S.default is
      // not a constructor", and not a bare value, which fails with "Plugins have to be a Promise
      // that resolves to a plugin builder function".
      //
      // Both failures are quiet in the worst way: the manager logs a warning, drops our player,
      // and falls back to the HTML5 one — which then hands Chromium an MKV it cannot decode, so
      // the page sits on a loading spinner with nothing to say why.
      getPlugins: function () {
        return [Promise.resolve({ default: MpvVideoPlayer })];
      },
    };

    window.NativeShell = nativeShell;

    // Parked last, so a partial install can never be mistaken for a finished one by the guard at
    // the top. configure() is the whole of what a re-injection is allowed to change: identity,
    // never wiring.
    window[CFG.shellKey] = {
      configure: function (next) {
        if (!next) return;
        config = next;
        player.priority = next.playerPriority;
      },
      player: player,
      nativeShell: nativeShell,
    };

    return 'installed';
  } catch (err) {
    // The last line of defence. jellyfin-web is mid-bootstrap when this runs and an exception
    // escaping into it could take the client down; a Jellyfin that plays in the browser is a far
    // better outcome than one that does not load.
    try {
      console.warn('[StreamHub] jellyfin shell failed to install:', err);
    } catch (ignored) { /* nothing left to try */ }
    return 'failed';
  }
})()`;
}

module.exports = { jellyfinShellJs, DEVICE_PROFILE };
