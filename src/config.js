// Persists the user's service list (order, additions, removals) to their own machine.
//
// The file lives under app.getPath('userData') — i.e. ~/.config/streamhub/services.json
// on Linux — NOT in the source tree and never committed. This is the only place the
// customised list is stored, alongside the per-service logins in the same userData dir.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULT_SERVICES } = require('./services');

function configPath() {
  return path.join(app.getPath('userData'), 'services.json');
}

// App settings, as opposed to the service list. Ad blocking ships off: it is experimental,
// and an over-broad filter rule breaking playback should be something the user opts into.
//
// `adblockOff` lists the services the blocker is NOT applied to while it is globally on.
// A deny-list rather than an allow-list, so that a service added later inherits the setting
// instead of silently going unblocked.
function defaultSettings() {
  return {
    adblock: false,
    adblockOff: [],
    sidebarCollapsed: false,
    minimizeToTray: false,
  };
}

function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    adblock: s.adblock === true,
    adblockOff: Array.isArray(s.adblockOff) ? s.adblockOff.filter((x) => typeof x === 'string') : [],
    sidebarCollapsed: s.sidebarCollapsed === true,
    minimizeToTray: s.minimizeToTray === true,
  };
}

// Where the window was last time. Position is allowed to be absent (let the WM place it),
// but a size is always returned so the caller never has to special-case a first run.
function defaultWindow() {
  return { width: 1280, height: 800, maximized: false };
}

function cleanWindow(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min) => (Number.isFinite(v) && v >= min ? Math.round(v) : undefined);
  const out = {
    width: num(w.width, 940) || 1280,
    height: num(w.height, 600) || 800,
    maximized: w.maximized === true,
  };
  // Only carry a position if both halves are there — half a position is not a position.
  const x = num(w.x, -32000);
  const y = num(w.y, -32000);
  if (x !== undefined && y !== undefined) {
    out.x = x;
    out.y = y;
  }
  return out;
}

function defaults() {
  return {
    services: DEFAULT_SERVICES.map((s) => ({ ...s })),
    removed: [],
    settings: defaultSettings(),
    window: defaultWindow(),
    lastServiceId: null,
  };
}

// A service entry is only trusted if it has an id, a name, and an http(s) url.
function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { id, name, url, color } = entry;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof url !== 'string') return null;
  try {
    const p = new URL(url).protocol;
    if (p !== 'http:' && p !== 'https:') return null;
  } catch {
    return null;
  }
  return { id, name, url, color: typeof color === 'string' ? color : '#5aa9c9' };
}

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = sanitize(raw);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

// Load the saved config, falling back to defaults, and fold in any newly shipped
// built-in services the user has not already seen (so app updates that add sites show
// them) without resurrecting ones the user deliberately removed.
function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return defaults();
  }
  const cfg = {
    services: cleanList(raw && raw.services),
    removed: cleanList(raw && raw.removed),
    settings: cleanSettings(raw && raw.settings),
    window: cleanWindow(raw && raw.window),
    lastServiceId: typeof (raw && raw.lastServiceId) === 'string' ? raw.lastServiceId : null,
  };
  // An empty list means a corrupt or hand-emptied file: reset the catalog, but keep the
  // settings and window the user chose — they are independent of which services are listed.
  if (cfg.services.length === 0 && cfg.removed.length === 0) {
    return { ...defaults(), settings: cfg.settings, window: cfg.window };
  }

  const known = new Set([...cfg.services, ...cfg.removed].map((s) => s.id));
  for (const d of DEFAULT_SERVICES) {
    if (!known.has(d.id)) cfg.services.push({ ...d });
  }
  return cfg;
}

function save(cfg) {
  try {
    fs.writeFileSync(
      configPath(),
      JSON.stringify(
        {
          services: cfg.services,
          removed: cfg.removed,
          settings: cleanSettings(cfg.settings),
          window: cleanWindow(cfg.window),
          lastServiceId: typeof cfg.lastServiceId === 'string' ? cfg.lastServiceId : null,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[config] failed to save services.json:', err);
  }
}

module.exports = { load, save, sanitize, configPath };
