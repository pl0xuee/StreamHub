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
function defaultSettings() {
  return { adblock: false };
}

function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return { adblock: s.adblock === true };
}

function defaults() {
  return {
    services: DEFAULT_SERVICES.map((s) => ({ ...s })),
    removed: [],
    settings: defaultSettings(),
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
  };
  // An empty list means a corrupt or hand-emptied file: reset the catalog, but keep the
  // settings the user chose — they are independent of which services are listed.
  if (cfg.services.length === 0 && cfg.removed.length === 0) {
    return { ...defaults(), settings: cfg.settings };
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
