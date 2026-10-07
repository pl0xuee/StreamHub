const { globalShortcut } = require('electron');

let registered = false;

/**
 * Register OS media keys and forward them to whatever is playing in front — the page, or mpv.
 *
 * globalShortcut is system-wide: while registered, the media keys are captured even
 * when this app is in the background, stealing them from whatever the user is actually
 * playing (Spotify, etc.). So the caller registers these only while the app window is
 * focused and unregisters on blur — see the focus/blur wiring in main.js. Registration
 * is idempotent so repeated focus events are harmless.
 *
 * The keys go to `controls` rather than straight to a page, because what is in front may be mpv,
 * which no page can reach. Most web players have no real "next track", so next and previous seek.
 *
 * @param {{ playPause: () => void, seek: (seconds: number) => void }} controls
 */
function registerMediaKeys(controls) {
  if (registered) return;
  globalShortcut.register('MediaPlayPause', () => controls.playPause());
  globalShortcut.register('MediaNextTrack', () => controls.seek(10));
  globalShortcut.register('MediaPreviousTrack', () => controls.seek(-10));
  registered = true;
}

function unregisterMediaKeys() {
  if (!registered) return;
  globalShortcut.unregisterAll();
  registered = false;
}

module.exports = { registerMediaKeys, unregisterMediaKeys };
