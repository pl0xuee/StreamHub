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
];

// Desktop Chrome identity. Several services block the default "Electron/..." UA, so
// every service view presents itself as Chrome instead.
//
// The version is read from the engine we are actually running rather than hardcoded:
// a UA string that disagrees with the Chromium version reported by the User-Agent
// Client Hints API (navigator.userAgentData / Sec-CH-UA) is a bot signal, and it is
// what reCAPTCHA on the streaming sign-in pages trips over. UA and client hints must
// tell the same story — see the header rewrite and preload wired up in views.js.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Brand list Chrome sends; Electron's omits "Google Chrome", which gives the game away.
const CHROME_BRANDS =
  `"Not;A=Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;

const CHROME_FULL_VERSION_LIST =
  `"Not;A=Brand";v="8.0.0.0", "Chromium";v="${CHROME_MAJOR}.0.0.0", ` +
  `"Google Chrome";v="${CHROME_MAJOR}.0.0.0"`;

module.exports = {
  DEFAULT_SERVICES,
  CHROME_UA,
  CHROME_MAJOR,
  CHROME_BRANDS,
  CHROME_FULL_VERSION_LIST,
};
