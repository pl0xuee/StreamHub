// Built-in default catalog. Each entry is loaded as the official website inside its own
// persistent, isolated WebContentsView (see views.js); `color` tints the sidebar icon.
//
// This is only the SHIPPED starting list. The user's actual list — reordered, with sites
// added or removed — is stored per-user on their own machine (see config.js), never in
// this source file. Logins likewise live only in that per-user data dir.
const DEFAULT_SERVICES = [
  { id: 'netflix',     name: 'Netflix',     url: 'https://www.netflix.com',       color: '#e50914' },
  { id: 'prime',       name: 'Prime Video', url: 'https://www.primevideo.com',    color: '#1399ff' },
  { id: 'disney',      name: 'Disney+',     url: 'https://www.disneyplus.com',    color: '#1f80e0' },
  { id: 'max',         name: 'Max',         url: 'https://play.max.com',          color: '#3b5bff' },
  { id: 'hulu',        name: 'Hulu',        url: 'https://www.hulu.com',          color: '#1ce783' },
  { id: 'youtube',     name: 'YouTube',     url: 'https://www.youtube.com',       color: '#ff0033' },
  { id: 'youtubetv',   name: 'YouTube TV',  url: 'https://tv.youtube.com',        color: '#cc0000' },
  { id: 'appletv',     name: 'Apple TV+',   url: 'https://tv.apple.com',          color: '#457fe6' },
  { id: 'paramount',   name: 'Paramount+',  url: 'https://www.paramountplus.com', color: '#0064ff' },
  { id: 'peacock',     name: 'Peacock',     url: 'https://www.peacocktv.com',     color: '#8b5cf6' },
  { id: 'crunchyroll', name: 'Crunchyroll', url: 'https://www.crunchyroll.com',   color: '#f47521' },
  { id: 'twitch',      name: 'Twitch',      url: 'https://www.twitch.tv',         color: '#9146ff' },
  { id: 'tubi',        name: 'Tubi',        url: 'https://tubitv.com',            color: '#fa382f' },
  // Jellyfin is the one entry here that is not a website: it is the user's own server, so there
  // is no address to ship with the app. `selfHosted` says exactly that — the entry starts with
  // no url, and its view shows the built-in setup page (src/ui/setup.html) asking where the
  // server is until the user has said. See needsSetup below.
  { id: 'jellyfin',    name: 'Jellyfin',    url: '',                              color: '#aa5cc3', selfHosted: true },
];

// A self-hosted service that has not been pointed at a server yet. Its view loads the setup
// page instead of a site (views.js), and the address the user gives there is saved onto the
// entry as its `url` (main.js), after which it behaves like every other service.
function needsSetup(service) {
  return Boolean(service && service.selfHosted && !service.url);
}

// Turn what someone types on the setup page into a base URL the app can load, or null if it
// cannot be read as an address at all.
//
// Three things are forgiven, because all three are what people actually type or paste:
//   * no scheme — a bare `192.168.1.10:8096` is assumed to be http, which is what a server on
//     the local network speaks;
//   * a trailing slash;
//   * the web client's own entry point. Copying the address out of a browser gives you
//     `…/web/index.html#/home.html`, while the server (and its API) sits at the root above it.
// A path is otherwise kept, since a server behind a reverse proxy often lives under one —
// `https://media.example.com/jellyfin`.
function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/web(\/index\.html)?$/i, '');
  return `${url.origin}${basePath}`;
}

// Desktop Chrome identity. Several services block the default "Electron/..." UA, so
// every service view presents itself as Chrome instead.
//
// The version is read from the engine we are actually running rather than hardcoded:
// a UA string that disagrees with the Chromium version reported by the User-Agent
// Client Hints API (navigator.userAgentData / Sec-CH-UA) is a bot signal, and it is
// what reCAPTCHA on the streaming sign-in pages trips over. UA and client hints must
// tell the same story — see the header rewrite and preload wired up in views.js.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];

// Present the host OS honestly. On Windows the app really is Chromium-on-Windows, and — unlike
// Linux — Windows has Widevine L1, so a Windows identity is also what lets the DRM services
// offer their higher-quality tiers rather than the ~720p Linux ceiling. The UA string, the
// Sec-CH-UA-Platform header (views.js) and navigator.userAgentData (service-preload.js) all
// read from these, so the three never disagree about which platform this is.
const IS_WIN = process.platform === 'win32';
const UA_OS = IS_WIN ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
// Sec-CH-UA-Platform / navigator.userAgentData.platform.
const CH_PLATFORM = IS_WIN ? 'Windows' : 'Linux';
// High-entropy platformVersion. UA-CH reports Windows 10/11 as "15.0.0" (they share NT 10.0);
// Linux keeps a plausible kernel-ish value.
const CH_PLATFORM_VERSION = IS_WIN ? '15.0.0' : '6.1.0';
const CH_ARCH = 'x86';
const CH_BITNESS = '64';

const CHROME_UA =
  `Mozilla/5.0 (${UA_OS}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Brand list Chrome sends; Electron's omits "Google Chrome", which gives the game away.
const CHROME_BRANDS =
  `"Not;A=Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;

const CHROME_FULL_VERSION_LIST =
  `"Not;A=Brand";v="8.0.0.0", "Chromium";v="${CHROME_MAJOR}.0.0.0", ` +
  `"Google Chrome";v="${CHROME_MAJOR}.0.0.0"`;

// Google refuses to accept a password when it decides sign-in is happening inside an
// embedded Chromium browser — "This browser or app may not be secure" — which is exactly
// what every service view is. The block is aimed at embedded Chromium specifically, so on
// Google's sign-in host alone we drop the Chrome disguise above and present Firefox, a
// browser Google's check waves through. Everywhere else stays Chrome, which the streaming
// sites' reCAPTCHA and DRM want. Firefox sends no Sec-CH-UA client hints and no
// navigator.userAgentData, so those are stripped alongside the UA swap (see views.js and
// service-preload.js); a Firefox UA carrying Chrome hints would be its own automation tell.
const FIREFOX_UA =
  `Mozilla/5.0 (${UA_OS}; rv:140.0) Gecko/20100101 Firefox/140.0`;

// Only the account/sign-in host wears the Firefox disguise, so it never touches playback.
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);

function isGoogleAuthHost(hostname) {
  return GOOGLE_AUTH_HOSTS.has(hostname);
}

// Everything service-preload.js needs to patch the JS-visible identity, as a command-line
// argument for it to parse.
//
// It is handed over this way rather than imported because service views are sandboxed — worth
// keeping for sites we do not control — and a sandboxed preload cannot `require` a local module.
// The constants above stay the single source of truth for the UA string, the Sec-CH-* headers
// (views.js) and navigator.userAgentData alike, so the three cannot drift apart.
function identityArg() {
  return `--streamhub-identity=${JSON.stringify({
    chromeMajor: CHROME_MAJOR,
    firefoxUa: FIREFOX_UA,
    chPlatform: CH_PLATFORM,
    chPlatformVersion: CH_PLATFORM_VERSION,
    chArch: CH_ARCH,
    chBitness: CH_BITNESS,
    authHosts: Array.from(GOOGLE_AUTH_HOSTS),
  })}`;
}

// What the Jellyfin preload needs to decide whether to bridge anything: the origin of the server
// the user actually configured.
//
// Handed over the same way as identityArg, and for the same reason — that view is sandboxed and
// cannot require a local module. The origin rather than the full URL because that is what the
// check is against: a server under a reverse-proxy path still serves its client from one origin,
// and a page that has wandered off it is no longer the server we agreed to trust.
function jellyfinArg(serverUrl) {
  let origin = '';
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    origin = '';
  }
  return `--streamhub-jellyfin=${JSON.stringify({ origin })}`;
}

module.exports = {
  DEFAULT_SERVICES,
  needsSetup,
  normalizeServerUrl,
  identityArg,
  jellyfinArg,
  CHROME_UA,
  CHROME_MAJOR,
  CHROME_BRANDS,
  CHROME_FULL_VERSION_LIST,
  FIREFOX_UA,
  CH_PLATFORM,
  CH_PLATFORM_VERSION,
  CH_ARCH,
  CH_BITNESS,
  isGoogleAuthHost,
};
