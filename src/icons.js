// Each service's own logo, for the sidebar.
//
// The sidebar used to mark every service with a coloured initial, which says "N" where the eye is
// looking for Netflix's N. The sites already publish the real thing — every page names its icons
// — so the first time a service is shown, its page is asked which icons it has, the best of them
// is fetched through that service's own session, and a small copy is kept here. A service never
// visited keeps its initial, which is still the right fallback.
//
// Kept beside services.json rather than in it: that file is the user's list and settings, and a
// cache of pictures has no business making it unreadable.
//
// Every image is decoded and re-encoded through nativeImage before it is kept, so what the chrome
// is finally handed is a PNG this process drew, never bytes a website chose. PNG and JPEG decode
// directly, .ico through the small reader below; an .svg is passed over, and a site with nothing
// else keeps its initial.
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const { parse: parseHost } = require('tldts-experimental');

const FILE = 'icons.json';
const PNG_DATA_URL = 'data:image/png;base64,';
const SIZE = 64; // drawn at 28px in the sidebar; twice that and a little for a 2x monitor
const MIN_SOURCE = 24; // smaller than this would only be blown up into mush
const MAX_CANDIDATES = 8;
const FETCH_TIMEOUT_MS = 6000;
// Every picture here is a website's, decoded in the app's own process, so nothing is decoded until
// it has been measured. An icon is a few kilobytes and a few hundred pixels; a file or a declared
// size far beyond that is not an icon, and decoding it could freeze or exhaust the app.
const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 1024;
// A service that offered nothing usable is not asked again on every page load for the rest of the
// session — only after this long.
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
// Sites redesign their marks now and then. A month is often enough to follow that and rare enough
// to cost nothing.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cache = null; // serviceId -> { data, full, at }
const inFlight = new Set();
const failedAt = new Map(); // serviceId -> when its icons last came to nothing (this session only)
// Bumped by forget(), so a fetch that was already under way for the old address cannot write the
// old server's icon back once it lands.
const generation = new Map();

function filePath() {
  return path.join(app.getPath('userData'), FILE);
}

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    for (const [id, entry] of Object.entries(raw || {})) {
      const png = entry && typeof entry.data === 'string' && entry.data.startsWith(PNG_DATA_URL);
      if (png) {
        cache[id] = { data: entry.data, full: entry.full === true, at: Number(entry.at) || 0 };
      }
    }
  } catch {
    /* no cache yet */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(cache));
  } catch {
    /* a lost cache only costs a fetch next time */
  }
}

// What the chrome needs: one picture per service, and whether it is a full-bleed tile (an app-style
// touch icon) or a mark that wants a tile drawn behind it.
function all() {
  const out = {};
  for (const [id, entry] of Object.entries(load())) {
    out[id] = { data: entry.data, full: entry.full };
  }
  return out;
}

// Whether a service still needs a logo: none yet, or one old enough to look again.
function wants(serviceId) {
  const failed = failedAt.get(serviceId);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return false;
  const known = load()[serviceId];
  return !known || Date.now() - known.at >= MAX_AGE_MS;
}

function forget(serviceId) {
  generation.set(serviceId, (generation.get(serviceId) || 0) + 1);
  failedAt.delete(serviceId);
  if (load()[serviceId]) {
    delete cache[serviceId];
    save();
  }
}

function siteOf(url) {
  const h = parseHost(url);
  return h.domain || h.hostname || '';
}

// Sign-in hosts, by the names they are conventionally given. A service whose very first load is
// sent to one of these has not landed on its own site yet, so that is not whose icon to learn.
const AUTH_HOST = /^(accounts?|login|auth|signin|sso|id|idp|oauth)\./i;

// Where an icon may be fetched from. The page's own site, over anything; anywhere else only over
// https and only by name — never an address, never this machine. The fetch goes out from the main
// process with the service's cookies and none of a browser's cross-origin rules, so a page must
// not be able to point it at the local network.
function fetchable(iconUrl, pageUrl) {
  let u;
  try {
    u = new URL(iconUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (siteOf(iconUrl) && siteOf(iconUrl) === siteOf(pageUrl)) return true;
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  return true;
}

// The page has to be the service's own site. A view passes through other people's pages — Google's
// sign-in, an OAuth hop — and their icon is not this service's.
function sameSite(pageUrl, serviceUrl) {
  try {
    const a = parseHost(pageUrl);
    const b = parseHost(serviceUrl);
    const siteA = a.domain || a.hostname;
    const siteB = b.domain || b.hostname;
    return Boolean(siteA) && siteA === siteB;
  } catch {
    return false;
  }
}

// The largest picture in a Windows .ico, which nativeImage cannot open on Linux — and which is the
// only icon some sites publish (Netflix among them). An entry is either a PNG, handed straight to
// nativeImage, or a bottom-up bitmap; only the 32-bit kind is read, which is what any icon drawn
// this century carries. Anything else in the file is skipped rather than guessed at.
// The declared size of a PNG or JPEG, read from its header without decoding it; null for anything
// else, which is then not decoded at all.
function declaredSize(buf) {
  const png = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
  if (png && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { kind: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) return null;
      const marker = buf[at + 1];
      const length = buf.readUInt16BE(at + 2);
      // Any start-of-frame except the DHT, JPG and DAC markers that share the range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { kind: 'jpeg', height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
  }
  return null;
}

// Decode a PNG or JPEG only once its header has said it is a reasonable size.
function decodeSmall(buf) {
  const size = declaredSize(buf);
  if (!size || !size.width || !size.height) return null;
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) return null;
  const img = nativeImage.createFromBuffer(buf);
  return img.isEmpty() ? null : img;
}

function decodeIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count && 6 + i * 16 + 16 <= buf.length; i += 1) {
    const at = 6 + i * 16;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + size > buf.length) continue;
    entries.push({ side: buf[at] || 256, data: buf.subarray(offset, offset + size) });
  }
  entries.sort((a, b) => b.side - a.side);
  for (const { data } of entries) {
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) {
      const img = decodeSmall(data);
      if (img) return img;
      continue;
    }
    if (data.length < 40 || data.readUInt32LE(0) < 40) continue;
    const width = data.readInt32LE(4);
    const height = Math.abs(data.readInt32LE(8)) / 2; // the height counts the mask as well
    const bpp = data.readUInt16LE(14);
    const compression = data.readUInt32LE(16);
    if (bpp !== 32 || compression !== 0 || width <= 0 || height <= 0) continue;
    if (width > MAX_SIDE || height > MAX_SIDE) continue;
    const start = data.readUInt32LE(0);
    const row = width * 4;
    if (start + row * height > data.length) continue;
    const out = Buffer.alloc(row * height);
    let anyAlpha = false;
    for (let y = 0; y < height; y += 1) {
      data.copy(out, y * row, start + (height - 1 - y) * row, start + (height - y) * row);
    }
    for (let i = 3; i < out.length; i += 4) if (out[i]) anyAlpha = true;
    // Old-style icons leave the alpha channel empty and say what is transparent in the mask that
    // follows instead; treated as opaque rather than invisible.
    if (!anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
    const img = nativeImage.createFromBitmap(out, { width, height });
    if (!img.isEmpty()) return img;
  }
  return null;
}

// The body, or null once it runs past `MAX_BYTES` — read in pieces so an oversized answer is
// abandoned as it arrives rather than held whole first.
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchImage(ses, url) {
  const res = await ses.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = await readCapped(res);
  if (!buf || !buf.length) return null;
  const ico = buf.length > 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1;
  return ico ? decodeIco(buf) : decodeSmall(buf);
}

// Does the picture fill its square, or is it a mark on transparency? Judged on the corners, which
// is where a full-bleed tile and a free-standing logo differ.
function isFullBleed(img) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const alphaAt = (x, y) => bmp[(y * width + x) * 4 + 3];
  const inset = Math.max(1, Math.round(width * 0.06));
  const corners = [
    [inset, inset],
    [width - 1 - inset, inset],
    [inset, height - 1 - inset],
    [width - 1 - inset, height - 1 - inset],
  ];
  return corners.every(([x, y]) => alphaAt(x, y) > 240);
}

/**
 * The page in a service's view listed these icons. Fetch the best and keep it. Resolves true if a
 * new picture was kept — the caller then has something to broadcast. `homeUrl` is where the
 * service's view first landed, which is the site the icon has to come from.
 */
async function learn(service, ses, pageUrl, homeUrl, urls) {
  if (!service || !ses || !Array.isArray(urls) || !urls.length) return false;
  if (inFlight.has(service.id)) return false;
  if (!wants(service.id)) return false;
  // The page has to be on the site the service's address landed on (see views.js), or on the
  // address's own site — before anything has landed, or when what it landed on was a sign-in page.
  let home = homeUrl || service.url;
  try {
    if (AUTH_HOST.test(new URL(home).hostname)) home = service.url;
  } catch {
    home = service.url;
  }
  if (!service.url || !sameSite(pageUrl, home)) return false;

  const gen = generation.get(service.id) || 0;
  inFlight.add(service.id);
  try {
    const candidates = Array.from(new Set(urls))
      .filter((u) => fetchable(u, pageUrl))
      // nativeImage cannot draw SVG, so fetching one would only cost a request to find that out.
      .filter((u) => !/\.svg(\?|#|$)/i.test(u))
      .slice(0, MAX_CANDIDATES);
    let best = null;
    for (const url of candidates) {
      const img = await fetchImage(ses, url).catch(() => null);
      if (!img) continue;
      const { width, height } = img.getSize();
      const side = Math.min(width, height);
      if (side < MIN_SOURCE) continue;
      // Square, or near it: a wide wordmark squashed into a tile reads worse than the initial.
      if (Math.max(width, height) / side > 1.15) continue;
      if (!best || side > best.side) best = { img, side };
    }
    // The address was changed while this was out; what was fetched belongs to the old one.
    if ((generation.get(service.id) || 0) !== gen) return false;
    if (!best) {
      failedAt.set(service.id, Date.now());
      return false;
    }
    const scaled =
      best.side > SIZE ? best.img.resize({ width: SIZE, height: SIZE, quality: 'best' }) : best.img;
    cache[service.id] = { data: scaled.toDataURL(), full: isFullBleed(scaled), at: Date.now() };
    save();
    return true;
  } finally {
    inFlight.delete(service.id);
  }
}

module.exports = { all, learn, wants, forget };
