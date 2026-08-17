// The bridge for the Jellyfin view, and the only preload in the app that hands a *remote* page
// anything at all.
//
// service-preload.js deliberately bridges nothing, because those are other people's websites.
// This one is an exception on the same grounds the setup page is: the server on the other end is
// the user's own machine, not a third party. The exception is kept narrow — the bridge is only
// installed when the page really is the server the user configured, checked here against the
// origin handed over on the command line, and checked again in main on every call.
//
// What it enables: jellyfin-web asks StreamHub to play through mpv instead of a <video>. The
// contract it implements is jellyfin-web's own `NativeShell`, injected from here rather than on
// dom-ready because the page reads that object while it boots — arriving late means the page has
// already decided it is an ordinary browser.
//
// IMPORTANT: like every service view this one is sandboxed, so nothing local can be `require`d.
// The shell source is fetched over a synchronous message instead, which is also why it is not
// passed on the command line: it is far too big to belong in argv.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const FLAG = '--streamhub-jellyfin=';
const arg = process.argv.find((a) => a.startsWith(FLAG));

let config = null;
try {
  config = arg ? JSON.parse(arg.slice(FLAG.length)) : null;
} catch {
  // Malformed payload: install nothing. jellyfin-web then behaves as it does in any browser,
  // which is the correct failure — the page still works, it just uses its own player.
}

// Only the configured server gets a bridge. A Jellyfin view that has wandered somewhere else —
// a link out, an OAuth hop, an injected iframe — is an ordinary web page again.
function isOurServer() {
  if (!config || !config.origin) return false;
  try {
    return window.location.origin === config.origin;
  } catch {
    return false;
  }
}

if (isOurServer()) {
  // One channel per direction. `invoke` for anything with an answer, and a pushed 'jellyfin-event'
  // for state coming the other way, so the page is not obliged to poll mpv.
  const listeners = new Set();
  ipcRenderer.on('jellyfin-event', (_e, event) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // A throwing subscriber in the page must not take out the others, or us.
      }
    }
  });

  const call = (method, payload) => ipcRenderer.invoke('jellyfin-player', method, payload);

  contextBridge.exposeInMainWorld('__streamhubJellyfin', {
    play: (opts) => call('play', opts),
    pause: () => call('pause'),
    unpause: () => call('unpause'),
    stop: () => call('stop'),
    seek: (seconds) => call('seek', { seconds }),
    setVolume: (volume) => call('setVolume', { volume }),
    setMuted: (muted) => call('setMuted', { muted }),
    setAudioTrack: (id) => call('setAudioTrack', { id }),
    setSubtitleTrack: (id) => call('setSubtitleTrack', { id }),
    getState: () => call('getState'),
    onEvent: (fn) => {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });

  // Now install the shell itself, in the page's own world — an isolated world would put
  // window.NativeShell somewhere jellyfin-web cannot see it. This runs at document start, before
  // any of the page's own scripts, which is the whole point of doing it here.
  //
  // Synchronous on purpose: the source has to be in hand before the page begins executing, and
  // there is no asynchronous point early enough to wait at.
  let source = null;
  try {
    source = ipcRenderer.sendSync('jellyfin-shell-source');
  } catch {
    source = null;
  }
  if (typeof source === 'string' && source) {
    webFrame.executeJavaScript(source).catch(() => {
      // The page keeps its own player. Nothing here is worth breaking Jellyfin over.
    });
  }
}
