const { globalShortcut } = require('electron');

// JS to nudge the active player forward/back a few seconds, used for the
// next/previous media keys (most web players have no real "next track").
const SEEK_JS = (delta) => `(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find(x => x.readyState > 2) || vids[0];
  if (!v) return 'no-video';
  v.currentTime = Math.max(0, v.currentTime + (${delta}));
  return v.currentTime;
})()`;

let registered = false;

/**
 * Register OS media keys and forward them to the active service view.
 *
 * globalShortcut is system-wide: while registered, the media keys are captured even
 * when this app is in the background, stealing them from whatever the user is actually
 * playing (Spotify, etc.). So the caller registers these only while the app window is
 * focused and unregisters on blur — see the focus/blur wiring in main.js. Registration
 * is idempotent so repeated focus events are harmless.
 *
 * @param {() => import('electron').WebContents | null} getActiveWebContents
 * @param {import('./views').ViewManager} viewManager
 */
function registerMediaKeys(getActiveWebContents, viewManager) {
  if (registered) return;
  const seek = (delta) => {
    const wc = getActiveWebContents();
    if (wc) wc.executeJavaScript(SEEK_JS(delta)).catch(() => {});
  };

  globalShortcut.register('MediaPlayPause', () => viewManager.playPause());
  globalShortcut.register('MediaNextTrack', () => seek(10));
  globalShortcut.register('MediaPreviousTrack', () => seek(-10));
  registered = true;
}

function unregisterMediaKeys() {
  if (!registered) return;
  globalShortcut.unregisterAll();
  registered = false;
}

module.exports = { registerMediaKeys, unregisterMediaKeys };
