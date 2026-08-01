// Optional per-site enhancements: cosmetic changes StreamHub makes to a service's own page, on
// top of loading that page otherwise untouched.
//
// Each one is switchable on its own, because they are layout tweaks aimed at a site we do not
// control. When YouTube next moves its DOM around, the remedy should be "untick the one that
// broke" rather than "stop using the app". Nothing here goes near playback, DRM or the network:
// the entire surface is a stylesheet plus a class on <html> (see enhance-youtube.js).
//
// The shape lives in this file because both ends need it — the main process persists it
// (config.js) and hands it out (main.js), and the service preload is what applies it.

// The features, by key. Adding one means: a key here, code to honour it in the site's controller
// (enhance-youtube.js, enhance-twitch.js), and a checkbox in ui/index.html.
//
// One key per site rather than one "theater mode" key for both, because that is what makes the
// remedy for a site moving its DOM around "untick the one that broke". `theater` is YouTube's and
// keeps its original name: renaming it to match `twitchTheater` would make every settings file
// written by an older build look like it has no opinion, quietly switching the feature back on for
// anyone who had turned it off.
//
// Both ship on. Unlike the ad blocker — which is off by default because an over-broad filter rule
// can stop a video playing — the worst these can do is make a page look wrong, and someone who
// installed the app to get a bigger player should not have to go hunting for them.
const ENHANCE_DEFAULTS = {
  theater: true,
  twitchTheater: true,
};

function defaultEnhance() {
  return { ...ENHANCE_DEFAULTS };
}

// Read back only the keys we know about, as booleans. An unrecognised key in the file — left by a
// newer build, or hand-editing — is dropped rather than carried along, and a missing one falls
// back to its default, so a feature added in a later version arrives switched on as intended.
function cleanEnhance(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(ENHANCE_DEFAULTS)) {
    out[key] = typeof r[key] === 'boolean' ? r[key] : fallback;
  }
  return out;
}

// Which hosts the YouTube enhancements apply to. Deliberately not tv.youtube.com: YouTube TV is a
// separate app with its own layout, and its player already fills the window.
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);

function isYouTubeHost(hostname) {
  return YOUTUBE_HOSTS.has(hostname);
}

// Which hosts the Twitch enhancement applies to. Deliberately not player.twitch.tv (the bare embed
// has no theatre mode to turn on) or dashboard.twitch.tv (a broadcaster's own console, not a place
// anyone is watching a stream from).
const TWITCH_HOSTS = new Set(['www.twitch.tv', 'twitch.tv', 'm.twitch.tv']);

function isTwitchHost(hostname) {
  return TWITCH_HOSTS.has(hostname);
}

module.exports = { ENHANCE_DEFAULTS, defaultEnhance, cleanEnhance, isYouTubeHost, isTwitchHost };
