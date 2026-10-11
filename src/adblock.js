// Ad/tracker blocking for the service views.
//
// uBlock Origin Lite itself cannot be used here: it is a Manifest V3 extension built on
// declarativeNetRequest, and Electron implements neither. So we run the same class of
// engine in-process instead — @ghostery/adblocker speaks uBO/EasyList filter syntax and
// does network blocking, cosmetic filtering and scriptlet injection directly against an
// Electron session. The filter set is the prebuilt "ads + tracking" engine (EasyList,
// EasyPrivacy, Peter Lowe, uBO's own lists and resources).
//
// Blocking is off by default and per-session: StreamHub gives every service its own
// partition, so the engine has to be attached to each one individually.
const fs = require('fs/promises');
const path = require('path');
const { app, ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { parse: parseHost } = require('tldts-experimental');

// The cosmetic-filtering half of the blocker registers these two ipcMain handlers *every*
// time it is enabled in a session. ipcMain.handle throws on a duplicate channel, and we
// have one session per service — so the second service would take the app down. Both
// handlers are bound to the blocker rather than to any one session, so a single live
// registration correctly serves every session: we drop the pair and let the next enable()
// put it straight back. See BlockingContext.enable() in @ghostery/adblocker-electron.
//
// The library's disable() removes the pair just as globally, so taking blocking off one service
// would leave every other service without cosmetic filtering or scriptlets. So after any attach
// or detach the pair is put back for whatever is still attached — see registerHandlers().
const INJECT_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const OBSERVER_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';
const COSMETIC_CHANNELS = [INJECT_CHANNEL, OBSERVER_CHANNEL];

// Why we take the blocker's cosmetic handler off it (see injectCosmetics below).
//
// A page gets many scriptlets — YouTube alone gets 28 — and the library runs each one with
// its own executeJavaScript call. Every scriptlet ships the same uBO helper preamble, which
// declares things like `JSONPath` at top level, and executeJavaScript evaluates its argument
// as a *program*: top-level declarations land in the frame's global lexical scope and stay
// there. So scriptlet #1 defines JSONPath, and #2 onwards all die with "Identifier
// 'JSONPath' has already been declared" — 27 of the 28 never run.
//
// That is why ads came through: the scriptlets that strip YouTube's ad payload are among the
// ones that never executed. It also explains the broken players — the surviving fragments
// left window.fetch wrapped around itself, so calling fetch recursed until it blew the stack
// ("Maximum call stack size exceeded"), which took out Netflix's browse page, Twitch's module
// loader and YouTube's player.
//
// A browser extension gets this for free by running each scriptlet as its own script element.
// We get it by giving each one its own function scope, so their declarations are local and
// cannot collide. They are also run in the frame that asked for them rather than in the top
// frame, which is where the library sent them regardless of origin.
function scoped(script) {
  // Trailing newline first: a scriptlet ending in a // comment would otherwise swallow the
  // closing brace.
  return `(function(){\n${script}\n})();`;
}

function injectInto(frame, scripts) {
  if (!frame || frame.detached) return;
  for (const script of scripts) {
    // executeJavaScript returns a promise; a frame can go away mid-navigation, and an
    // unhandled rejection per dead frame would bury real errors.
    Promise.resolve(frame.executeJavaScript(scoped(script), true)).catch(() => {});
  }
}

// Filter lists go stale, and the cached engine is just a serialized snapshot of them, so
// re-fetch it once a week. Upstream rebuilds it on roughly that cadence.
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// How long one list download may take. Startup waits on the engine whenever there is no cache to
// read (see load), and Node's fetch has no deadline of its own worth the name — a stalled
// connection would otherwise hold the window back for minutes.
const FETCH_TIMEOUT_MS = 15000;

// How long after a start from a stale cache to fetch fresh lists. Not straight away: the first
// moments are when the services are loading, and the rebuild is a burst of work on this thread.
const STALE_REFRESH_DELAY_MS = 60 * 1000;

// Brave's "Experimental ad blocker" list (its catalog calls the row exactly that, and
// describes it as "Brave Experimental Adblock Rules"). It is a supplement, not a blocklist:
// a couple of dozen risky rules Brave trials before promoting them, aimed largely at
// YouTube and Twitch. So it is layered ON TOP of the EasyList/EasyPrivacy engine below,
// which is what does the bulk of the blocking.
const BRAVE_EXPERIMENTAL_URL =
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/experimental.txt';

// Exception rules for filter rules that break a service. A general-purpose blocklist assumes
// a browser, where a broken site is a tab you close; here it is the whole product, so a
// service a rule breaks is worse than an ad that slips through.
//
// Empty, and worth keeping that way. Netflix, Twitch and YouTube each used to need an entry
// here — the browse page, the module loader and the player respectively — and every one of
// those turned out to be the scriptlet-scoping bug above rather than a bad rule. Fixing the
// injection fixed all three, so the exceptions came back out: each one had been quietly
// giving up real blocking (Twitch's was disabling an ad-blocking scriptlet outright).
//
// Add to this list only with a reproduction, and only after ruling out the injection path —
// an exception that is not needed is blocking silently given away.
const UNBREAK_RULES = [];

function enginePath() {
  return path.join(app.getPath('userData'), 'adblock-engine.bin');
}

function braveListPath() {
  return path.join(app.getPath('userData'), 'brave-experimental.txt');
}

// fetch with a deadline, and one that treats an error page as the error it is. The library reads
// whatever body comes back as the list, so a 429 or a 503 from the list host would otherwise be
// parsed as filter rules and cached for a week with that list missing.
async function fetchChecked(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res;
}

// Whether a cached file is older than the refresh interval. Missing counts as stale.
async function isStale(file) {
  try {
    const { mtimeMs } = await fs.stat(file);
    return Date.now() - mtimeMs > MAX_CACHE_AGE_MS;
  } catch {
    return true;
  }
}

// Replace a cache file in one step, so a write cut short leaves the previous copy rather than half
// of a new one.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// The cached engine, or null if there is none or it cannot be read (an engine serialized by an
// older library version throws here, which just means a fresh download).
async function readCachedEngine() {
  try {
    return ElectronBlocker.deserialize(await fs.readFile(enginePath()));
  } catch {
    return null;
  }
}

// A freshly built engine, written to the cache only once it has been built in full.
async function downloadEngine() {
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchChecked);
  await writeAtomic(enginePath(), blocker.serialize());
  return blocker;
}

// Brave's experimental rules. `fresh` fetches them anew and falls back to the cached copy if that
// fails; otherwise the cached copy is used when there is one. Returns the filter lines, comments
// and blanks stripped.
async function fetchBraveRules(fresh) {
  const file = braveListPath();
  let text = fresh ? null : await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    try {
      const res = await fetchChecked(BRAVE_EXPERIMENTAL_URL);
      text = await res.text();
      await writeAtomic(file, text);
    } catch (err) {
      text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) throw err;
    }
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('!'));
}

class AdBlocker {
  constructor() {
    this.blocker = null;
    this.enabled = false; // the global switch
    this.loading = null; // in-flight engine load, so concurrent toggles share one download
    this.refreshing = null; // in-flight refresh, likewise
    this.error = null;
    this.blocked = 0; // every service's blocks added up
    this.braveRules = 0; // how many of Brave's experimental rules were merged in
    this.lastUpdated = null; // when the filter engine on disk was last written
    this.sessions = new Map(); // serviceId -> session
    this.active = new Set(); // the sessions the engine is currently attached to
    this.off = new Set(); // services excluded while the blocker is globally on
    this.counts = new Map(); // serviceId -> blocked requests
    this.owners = new Map(); // webContents id -> serviceId, to attribute each block
  }

  // A service is blocked when the global switch is on and it has not been excluded.
  isOnFor(serviceId) {
    return this.enabled && !this.off.has(serviceId);
  }

  // Fetch (or read from cache) the prebuilt engine. Resolves to null if it cannot be
  // obtained — offline on a first run, say — which leaves the app working, just unblocked.
  async load() {
    if (this.blocker) return this.blocker;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      // A cached engine is used whatever its age. One past the refresh interval is still a working
      // blocker, and deleting it before a replacement had arrived is how one offline start used to
      // turn blocking off for good. It is refreshed in the background instead, once things settle.
      const stale = await isStale(enginePath());
      let blocker = await readCachedEngine();
      const fromCache = blocker !== null;
      if (!blocker) blocker = await downloadEngine();
      await this.prepare(blocker, !fromCache);
      this.blocker = blocker;
      this.error = null;
      if (fromCache && stale) {
        setTimeout(() => this.refresh().catch(() => {}), STALE_REFRESH_DELAY_MS);
      }
      return blocker;
    })();

    try {
      return await this.loading;
    } catch (err) {
      this.error = err.message;
      // eslint-disable-next-line no-console
      console.error('[adblock] could not load filter engine:', err);
      return null;
    } finally {
      this.loading = null;
    }
  }

  // Everything an engine needs on top of the base lists before it is put to work. `fresh` fetches
  // Brave's rules anew rather than reading the cached copy.
  async prepare(blocker, fresh) {
    // Every session shares one engine, so a block only says which *webContents* made the
    // request. Map that back to the service (see owners) to get a per-service count; a
    // request from something we do not own still counts toward the total.
    blocker.on('request-blocked', (request) => {
      this.blocked += 1;
      const serviceId = this.owners.get(request.tabId);
      if (serviceId) this.counts.set(serviceId, (this.counts.get(serviceId) || 0) + 1);
    });

    // Layer Brave's experimental rules over the base engine. Best-effort: they are a
    // small supplement, so if the list cannot be fetched we still have a working blocker
    // and say so in the status rather than failing the whole load.
    try {
      const rules = await fetchBraveRules(fresh);
      blocker.updateFromDiff({ added: rules });
      this.braveRules = rules.length;
    } catch (err) {
      this.braveRules = 0;
      // eslint-disable-next-line no-console
      console.warn('[adblock] Brave experimental rules unavailable:', err.message);
    }

    // Applied last, and never over the network: an exception that failed to download would
    // mean a silently broken service, which is exactly what these exist to prevent.
    blocker.updateFromDiff({ added: UNBREAK_RULES });

    // The engine file's mtime is when these rules were actually fetched — which is what
    // the user wants to know when YouTube starts showing ads again.
    try {
      this.lastUpdated = (await fs.stat(enginePath())).mtimeMs;
    } catch {
      this.lastUpdated = null;
    }
  }

  attach(ses) {
    if (!this.blocker || this.active.has(ses)) return;
    // Clear the shared cosmetic handlers so the library can register its own (see
    // COSMETIC_CHANNELS)...
    for (const channel of COSMETIC_CHANNELS) ipcMain.removeHandler(channel);
    this.blocker.enableBlockingInSession(ses);
    this.narrowHeaderListener(ses);
    this.active.add(ses);
    // ...then put ours in their place.
    this.registerHandlers();
  }

  // The two cosmetic handlers, for as long as any session is attached. Ours rather than the
  // library's: the scriptlet one is injectCosmetics (see injectInto), and both read the current
  // engine at call time, so they never answer for one that has been replaced.
  registerHandlers() {
    for (const channel of COSMETIC_CHANNELS) ipcMain.removeHandler(channel);
    if (!this.blocker || this.active.size === 0) return;
    ipcMain.handle(INJECT_CHANNEL, (event, url, msg) => this.injectCosmetics(event, url, msg));
    ipcMain.handle(OBSERVER_CHANNEL, (event) =>
      this.blocker ? this.blocker.onIsMutationObserverEnabled(event) : false,
    );
  }

  // The library listens to the response headers of *every* request, and each one is held while
  // the main process — the thread that also runs the app — is asked about it. It only ever acts on
  // documents (it adds CSP directives to pages and frames) and hands everything else straight back
  // untouched, so the rest was a round trip through this thread per response for nothing: every
  // video segment, every image, every API call a streaming site makes. Re-registered here for
  // documents only; Electron keeps one listener per event, so this replaces the library's own and
  // the library's disable still clears it.
  narrowHeaderListener(ses) {
    if (!this.blocker || this.blocker.config.loadNetworkFilters !== true) return;
    ses.webRequest.onHeadersReceived(
      { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] },
      this.blocker.onHeadersReceived,
    );
  }

  // Stands in for the library's cosmetic handler. Same rule lookup — only the scriptlets are
  // run in the frame that asked for them rather than in the top frame.
  injectCosmetics(event, url, msg) {
    if (!this.blocker) return;
    // Only for a service that is being blocked. A page that loaded while its service was still
    // attached keeps asking after the service is switched off.
    if (!event.sender || !this.active.has(event.sender.session)) return;
    const { hostname, domain } = parseHost(url);
    const isFirstRun = msg === undefined; // updates carry DOM info; the first call does not
    const { active, styles, scripts } = this.blocker.getCosmeticsFilters({
      domain: domain || '',
      hostname: hostname || '',
      url,
      classes: msg && msg.classes,
      hrefs: msg && msg.hrefs,
      ids: msg && msg.ids,
      getBaseRules: isFirstRun,
      getInjectionRules: isFirstRun,
      getExtendedRules: false,
      getRulesFromHostname: isFirstRun,
      getRulesFromDOM: !isFirstRun,
      callerContext: {
        frameId: event.frameId,
        processId: event.processId,
        lifecycle: msg && msg.lifecycle,
      },
    });
    if (active === false) return;
    if (styles && styles.length > 0) {
      event.sender.insertCSS(styles, { cssOrigin: 'user' });
    }
    if (scripts && scripts.length > 0) {
      injectInto(event.senderFrame, scripts);
    }
  }

  detach(ses) {
    if (!this.blocker || !this.active.has(ses)) return;
    // This also clears any onBeforeRequest/onHeadersReceived listener on the session —
    // Electron allows only one per event, so the blocker's only way off is to remove them
    // all. Nothing else in the app uses those two events; the Chrome client-hint rewrite
    // in views.js sits on onBeforeSendHeaders and is unaffected.
    this.blocker.disableBlockingInSession(ses);
    this.active.delete(ses);
    this.registerHandlers();
  }

  // Called for every service session as its view is created, so a session opened while
  // blocking is on gets the engine immediately.
  register(ses, serviceId) {
    this.sessions.set(serviceId, ses);
    if (this.isOnFor(serviceId)) this.attach(ses);
  }

  // Which service a webContents belongs to, so its blocked requests can be counted against
  // the right one. Views are recreated (remove/restore, reload), so ids are re-bound.
  bindWebContents(webContentsId, serviceId) {
    this.owners.set(webContentsId, serviceId);
  }

  unbindWebContents(webContentsId) {
    this.owners.delete(webContentsId);
  }

  // Bring every session in line with the current settings.
  applyAll() {
    for (const [serviceId, ses] of this.sessions) {
      if (this.isOnFor(serviceId)) this.attach(ses);
      else this.detach(ses);
    }
  }

  // Turn blocking on/off globally. Returns true if the requested state was actually reached
  // — flipping it on with no engine and no network does not.
  async setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) {
      for (const ses of [...this.active]) this.detach(ses);
      return false;
    }
    if (!(await this.load())) {
      this.enabled = false;
      return false;
    }
    // Switched off again while the engine was downloading: that is the state to honour.
    if (!this.enabled) return false;
    this.applyAll();
    return true;
  }

  // Exclude (or re-include) one service while the blocker stays on globally. This is the
  // escape hatch for a service a filter rule breaks: switch it off there, not everywhere.
  async setServiceEnabled(serviceId, on) {
    if (on) this.off.delete(serviceId);
    else this.off.add(serviceId);
    if (this.enabled && !(await this.load())) return;
    this.applyAll();
  }

  // Restore the excluded set from the saved config, before anything is attached.
  setExcluded(serviceIds) {
    this.off = new Set(Array.isArray(serviceIds) ? serviceIds : []);
  }

  // Pull fresh filter lists now rather than waiting out the weekly refresh — the fix for a
  // site's new anti-adblock arrives as a list update, not as an app update. Builds the new engine
  // alongside the old one, and only swaps them once it is complete; the cache is replaced only
  // then too. If the fetch fails the old engine stays attached, so "update" can never leave the
  // user with less blocking than they started with.
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const next = await downloadEngine();
        await this.prepare(next, true);
        // Take every session off the old engine before attaching the new one. Each attach
        // registers a preload in the session, and one left behind by the old engine would go on
        // injecting a second copy of everything — and would survive the service being switched off.
        const previous = this.blocker;
        if (previous) {
          for (const ses of this.active) {
            try {
              previous.disableBlockingInSession(ses);
            } catch {
              /* never attached to that one */
            }
          }
        }
        this.active.clear();
        this.blocker = next;
        this.error = null;
        this.applyAll();
        this.registerHandlers();
        return true;
      } catch (err) {
        this.error = err.message;
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  status() {
    return {
      enabled: this.enabled,
      ready: this.blocker !== null,
      error: this.error,
      blocked: this.blocked,
      braveRules: this.braveRules,
      lastUpdated: this.lastUpdated,
      excluded: [...this.off],
      counts: Object.fromEntries(this.counts),
    };
  }
}

module.exports = { adblocker: new AdBlocker() };
