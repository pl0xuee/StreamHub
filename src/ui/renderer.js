// Renders the sidebar and wires it to the main process via the `shell` bridge exposed
// in preload.js. This script never touches the streaming sites themselves. The user's
// list lives in the main process (persisted to their userData); the sidebar just
// reflects the state it is sent and reports user actions back.

const listEl = document.getElementById('service-list');
const removedCountEl = document.getElementById('removed-count');
const settingsBtn = document.getElementById('btn-settings');
const gridBtn = document.getElementById('btn-grid');
const menuEl = document.getElementById('service-menu');
const menuTitleEl = document.getElementById('menu-title');
const menuAdblockEl = document.getElementById('menu-adblock');
const menuSignoutEl = document.getElementById('menu-signout');

let state = {
  services: [],
  removed: [],
  activeServiceId: null,
  sidebarCollapsed: false,
  gridMode: false,
  gridPanes: [],
};
const edgeStripEl = document.getElementById('edge-strip');
const sidebarEl = document.getElementById('sidebar');

let menuServiceId = null; // the service the context menu is currently open for
let menuWanted = null; // where that menu was asked for, so it can be re-placed when the view resizes
// Whether a service is playing right now. It arrives on its own channel rather than in the state
// payload (see 'playback' in main.js) so that starting or stopping a video does not re-render the
// service list — which would cancel an in-progress drag.
let playing = false;
// Whether the sidebar has slid out of the window, and whether the pointer is currently holding it
// back in. Kept out of `state` because they change on hover and on playback, neither of which is a
// reason to re-render the service list — that would cancel an in-progress drag.
let stowed = false;
// Starts held open: the app opens with the sidebar out and it leaves the first time the pointer
// moves off it, so the gesture is learned by watching it happen once.
let peeking = true;

// The grid panes showing this service, as {paneId, position} — position being the pane's 1-based
// place in the whole grid, which is what the on-screen tiling order is. A service can hold more
// than one, so this returns a list rather than a single index.
function panesFor(serviceId) {
  const panes = state.gridPanes || [];
  return panes
    .map((p, i) => ({ paneId: p.paneId, serviceId: p.serviceId, position: i + 1 }))
    .filter((p) => p.serviceId === serviceId);
}

// Which rows read as "on". In single mode that is the one active service; in grid mode it is
// every service holding at least one pane.
function isSelected(id) {
  return state.gridMode ? panesFor(id).length > 0 : id === state.activeServiceId;
}

// Is the blocker on for this service? Globally on, and not in the excluded list.
function adblockOnFor(id) {
  const ab = state.adblock;
  return Boolean(ab && ab.enabled && !(ab.excluded || []).includes(id));
}

function initial(name) {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
}

function makeServiceEl(svc) {
  const li = document.createElement('li');
  li.className = 'service' + (isSelected(svc.id) ? ' active' : '');
  li.dataset.id = svc.id;
  li.draggable = true;
  // The label is dropped in the collapsed rail, which leaves only a coloured initial —
  // and two services can share one (YouTube and YouTube TV both give "Y").
  li.title = svc.name;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.style.background = svc.color;
  icon.textContent = initial(svc.name);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = svc.name;

  // How many requests the blocker has stopped on THIS service. Only shown once it has
  // actually stopped something — a "0" on every row is noise, not information.
  const counts = (state.adblock && state.adblock.counts) || {};
  const blocked = counts[svc.id] || 0;
  const shield = document.createElement('span');
  shield.className = 'shield';
  if (adblockOnFor(svc.id) && blocked > 0) {
    shield.textContent = blocked > 999 ? `${Math.floor(blocked / 1000)}k` : String(blocked);
    shield.title = `${blocked.toLocaleString()} requests blocked on ${svc.name}`;
  } else if (state.adblock && state.adblock.enabled && !adblockOnFor(svc.id)) {
    // Blocking is on everywhere else but deliberately off here — say so, or the user will
    // wonder why this one service is full of ads.
    shield.textContent = '⊘';
    shield.classList.add('off');
    shield.title = `Ad blocking is off for ${svc.name}`;
  }

  const del = document.createElement('button');
  del.className = 'del';
  del.title = `Remove ${svc.name}`;
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    window.shell.removeService(svc.id);
  });

  li.append(icon, label, shield, del);

  // In grid mode a tiled service shows a numbered badge per pane it occupies, so the sidebar
  // mirrors the on-screen layout even when one service holds several tiles. Clicking a badge
  // closes that one pane; clicking the row itself adds another.
  if (state.gridMode) {
    const panes = panesFor(svc.id);
    const last = panes.length === (state.gridPanes || []).length && panes.length === 1;
    for (const pane of panes) {
      const num = document.createElement('button');
      num.className = 'grid-num';
      num.textContent = String(pane.position);
      // The sole remaining pane cannot be closed — an empty grid would show nothing, and the
      // grid toggle is the way out of the mode. Say so rather than offering a dead button.
      num.disabled = last;
      num.title = last
        ? 'The last pane — turn grid view off to leave it'
        : `Close pane ${pane.position} (${svc.name})`;
      num.addEventListener('click', (e) => {
        e.stopPropagation(); // or the row's own handler would add a pane right back
        window.shell.removeGridPane(pane.paneId);
      });
      // Before the delete button, so the badges sit where the shield does rather than past the
      // row's right edge — they are flex items now, not absolutely positioned.
      li.insertBefore(num, del);
    }
  }

  li.addEventListener('click', () => {
    if (state.gridMode) window.shell.addGridPane(svc.id);
    else window.shell.switchService(svc.id);
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openServiceMenu(svc, e.clientX, e.clientY);
  });

  li.addEventListener('dragstart', () => {
    // Defer so the class lands after the drag image is captured.
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    // Commit whatever order the DOM ended up in.
    const ids = Array.from(listEl.children).map((c) => c.dataset.id);
    window.shell.reorderServices(ids);
  });

  return li;
}

// During a drag, find the sibling the pointer is currently above.
function afterElement(y) {
  const items = Array.from(listEl.querySelectorAll('.service:not(.dragging)'));
  let closest = { offset: -Infinity, el: null };
  for (const el of items) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el };
  }
  return closest.el;
}

listEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = listEl.querySelector('.dragging');
  if (!dragging) return;
  const after = afterElement(e.clientY);
  if (after == null) listEl.appendChild(dragging);
  else listEl.insertBefore(dragging, after);
});

// ---- Per-service context menu (right-click a row) ----
function closeServiceMenu() {
  menuEl.hidden = true;
  menuServiceId = null;
  menuWanted = null;
  // The menu sits outside the sidebar, so while it is open the pointer is not hovering the
  // sidebar and the house lights would go down under it. See .menu-open in styles.css.
  document.body.classList.remove('menu-open');
  syncChromeRegion();
}

function openServiceMenu(svc, x, y) {
  menuServiceId = svc.id;
  menuTitleEl.textContent = svc.name;

  const globallyOn = Boolean(state.adblock && state.adblock.enabled);
  const onHere = adblockOnFor(svc.id);
  menuAdblockEl.textContent = onHere ? 'Stop blocking ads here' : 'Block ads here';
  // With the blocker off globally there is nothing to turn on for one service, so say why
  // rather than offer a control that would do nothing.
  menuAdblockEl.disabled = !globallyOn;
  menuAdblockEl.title = globallyOn ? '' : 'Turn the ad blocker on first';

  menuEl.hidden = false;
  document.body.classList.add('menu-open');
  menuWanted = { x, y };
  // The chrome is only as wide as the sidebar until it is asked for more, so the menu needs the
  // whole window before it can be placed — a menu wider than the sidebar would otherwise be
  // clamped into it. The request lands a frame or two later, hence the reposition on resize.
  syncChromeRegion();
  positionMenu();
}

// Keep the menu on screen when the row is near an edge. Re-run whenever the chrome view's own
// width changes, since that is what `window.innerWidth` is measuring.
function positionMenu() {
  if (!menuWanted) return;
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(menuWanted.x, window.innerWidth - width - 6)}px`;
  menuEl.style.top = `${Math.min(menuWanted.y, window.innerHeight - height - 6)}px`;
}

window.addEventListener('resize', positionMenu);

menuAdblockEl.addEventListener('click', async () => {
  const id = menuServiceId;
  if (!id) return;
  const on = !adblockOnFor(id);
  closeServiceMenu();
  applyState({ ...state, adblock: await window.shell.setServiceAdblock(id, on) });
});

menuSignoutEl.addEventListener('click', () => {
  const id = menuServiceId;
  closeServiceMenu();
  if (id) window.shell.clearServiceData(id); // the main process confirms before wiping
});

// Any click or Escape elsewhere dismisses the menu.
window.addEventListener('click', closeServiceMenu);
window.addEventListener('blur', closeServiceMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Innermost first: the menu sits on top of a sheet, and a sheet on top of the sidebar.
    if (!menuEl.hidden) closeServiceMenu();
    else if (paletteOpen) closePalette();
    else if (openSheetName) closeSheet();
    return;
  }

  // Ctrl+K from inside our own chrome. The same chord pressed in a service view belongs to the
  // page, so main.js takes it back there and forwards it — see onOpenPalette in init().
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key || '').toLowerCase() === 'k') {
    e.preventDefault();
    if (paletteOpen) closePalette();
    else openPalette();
    return;
  }

  if (!paletteOpen) return;
  const matches = paletteMatches();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteIndex = Math.min(paletteIndex + 1, matches.length - 1);
    renderPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choosePalette(matches[paletteIndex], e.shiftKey);
  }
});
menuEl.addEventListener('click', (e) => e.stopPropagation());

function renderServices() {
  listEl.innerHTML = '';
  for (const svc of state.services) listEl.appendChild(makeServiceEl(svc));
}

function setCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', Boolean(collapsed));
  const btn = document.getElementById('btn-collapse');
  btn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
  btn.setAttribute('aria-label', btn.title);
}

// An update is announced here but installed in the settings window, so the sidebar's job is
// only to say that one is waiting: the gear picks up an accent dot and names the version it
// would take you to install.
function renderUpdateBadge() {
  const version = state.updateAvailable;
  settingsBtn.classList.toggle('has-update', Boolean(version));
  settingsBtn.title = version ? `Settings — update to v${version} available` : 'Settings';
  // The gear's label is dropped in the collapsed rail, so mark the body too: that lets the
  // rail put the dot on the version instead, rather than leaving the update unmentioned
  // until the sidebar is opened again.
  document.body.classList.toggle('update-available', Boolean(version));
}

// Reflect grid mode on its toolbar button (pressed look) and on the body, which switches the
// sidebar into "pick panes" mode — rows that read as add/remove targets. The preview, the
// arrangement picker and the hint line live in the HUD now (see hud.js); the sidebar's job in grid
// mode is the list, and the numbered badges saying which panes a service holds.
function renderGridToggle() {
  const on = Boolean(state.gridMode);
  gridBtn.classList.toggle('active', on);
  gridBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  gridBtn.title = on
    ? 'Grid view on — click a service to add a pane, a number to close one'
    : 'Grid view — watch up to 4 at once';
  document.body.classList.toggle('grid-mode', on);
  // With four panes tiled there is nothing more to add, so the rows stop reading as add targets.
  document.body.classList.toggle('grid-full', on && Boolean(state.gridFull));
}

// The chrome sits on the picture now, so its resting state is "away": the sidebar lives off the
// left edge and main.js shrinks the chrome view to the strip, which hands the entire window —
// clicks included — to the page. Reaching for that strip slides it back over the top.
//
// Away all the time rather than only while something is playing. Tying it to playback meant the
// sidebar appeared and disappeared on its own while you were picking something to watch, and it
// still covered the page whenever nothing happened to be playing. One gesture, always the same one,
// is easier to learn than a rule about when the gesture applies.
//
// The on-air signal is separate and stays on the seam — the edge where the chrome stops and the
// picture starts. There is no lamp to show or hide, only a state for styles.css to light that edge
// from, and the strip is that same edge, so it goes on saying "playing" with the sidebar gone.
function renderStow() {
  const away = state.autoHideSidebar !== false;
  if (away !== stowed) {
    stowed = away;
    clearTimeout(peekTimer);
    // Pinned open, nothing is peeking; newly stowed, the sidebar is left out until the pointer
    // moves off it, which is what teaches the gesture without a tooltip explaining it.
    peeking = away;
    document.body.classList.toggle('peeking', peeking);
  }
  document.body.classList.toggle('playing', playing);
  document.body.classList.toggle('stowed', stowed);
  edgeStripEl.hidden = !stowed;
  syncChromeRegion();
}

// How wide each region is, for comparing one against another. The real widths live in main.js;
// these only have to sort. 'full' is whatever the window is, so it beats everything.
const REGION_ORDER = { peek: 0, rail: 1, sidebar: 2, full: 3 };
// Must match the sidebar's transform transition in styles.css.
const SLIDE_MS = 220;
// A small overshoot off the sidebar should not slam it shut.
const LEAVE_GRACE_MS = 180;

// Declared here because chromeRegion() below has to know about them, and it is defined before
// either has anything to say. See the sheet and palette sections further down.
let openSheetName = null;
let paletteOpen = false;

let region = 'sidebar'; // the chrome-view region main.js was last asked for
let dockInset = 'sidebar'; // …and how much of the window the sidebar itself was holding
let regionTimer = null; // a pending shrink, held until the slide it would clip has finished
let peekTimer = null; // a pending un-peek, cancelled if the pointer comes back

// How much of the window the sidebar itself is occupying — never the whole thing, whatever is
// drawn over the page on top of it. This is what the docked layout insets the page by, so a
// stowed sidebar has to report the strip: reserving its full width for a sidebar that has left is
// what leaves a bare band of window background down the side of the page.
function sidebarRegion() {
  if (stowed && !peeking) return 'peek';
  return state.sidebarCollapsed ? 'rail' : 'sidebar';
}

// Which slice of the window the chrome view needs right now. Anything that has to be drawn over the
// page — a sheet, the palette, a right-click menu — needs the whole window; otherwise the chrome is
// only as wide as the sidebar it is showing. See CHROME_REGIONS in main.js.
function chromeRegion() {
  if (openSheetName || paletteOpen || !menuEl.hidden) return 'full';
  return sidebarRegion();
}

// The chrome view is the room the sidebar is drawn in, so it has to be at least as wide as the
// sidebar for the whole of a slide. Growing can happen at once — the sidebar then slides into the
// room that makes. Shrinking has to wait for the slide to finish, or the view clips the sidebar out
// of existence instead of letting it leave, and the animation is never seen.
function syncChromeRegion() {
  const want = chromeRegion();
  const inset = sidebarRegion();
  clearTimeout(regionTimer);
  if (want === region && inset === dockInset) return;
  const send = () => {
    region = want;
    dockInset = inset;
    window.shell.setChromeRegion(want, inset);
  };
  if (REGION_ORDER[want] >= REGION_ORDER[region]) {
    send();
    return;
  }
  regionTimer = setTimeout(send, SLIDE_MS);
}

// Reaching for the strip holds the sidebar in; leaving it lets go again, after a moment's grace so
// that clipping the corner on the way past does not slam it shut.
function holdPeek() {
  clearTimeout(peekTimer);
  if (!stowed || peeking) return;
  peeking = true;
  document.body.classList.toggle('peeking', true);
  syncChromeRegion();
}

function releasePeek() {
  clearTimeout(peekTimer);
  if (!stowed || !peeking) return;
  peekTimer = setTimeout(() => {
    peeking = false;
    document.body.classList.toggle('peeking', false);
    syncChromeRegion();
  }, LEAVE_GRACE_MS);
}

// ---- Sheets ----
//
// Settings and the removed list. They were windows of their own until the chrome could cover the
// whole window; the code that renders them is unchanged, it just draws into a panel here and reads
// the state the sidebar already has instead of fetching its own copy.
const scrimEl = document.getElementById('scrim');
const sheetEls = {
  settings: document.getElementById('sheet-settings'),
  removed: document.getElementById('sheet-removed'),
};

function openSheet(name) {
  if (!sheetEls[name]) return;
  openSheetName = name;
  for (const [key, el] of Object.entries(sheetEls)) el.hidden = key !== name;
  scrimEl.hidden = false;
  syncChromeRegion();
  renderSheets();
  // The sheet is over the page, so the pointer is nowhere near the sidebar — without this the
  // sidebar would stow out from under the panel that was opened from it.
  holdPeek();
}

function closeSheet() {
  if (!openSheetName) return;
  openSheetName = null;
  for (const el of Object.values(sheetEls)) el.hidden = true;
  if (!paletteOpen) scrimEl.hidden = true;
  syncChromeRegion();
  releasePeek();
}

// ---- Quick switch ----
//
// Substring match on the service name, in list order. With a dozen services there is nothing for
// fuzzy matching to earn, and "net" landing on Netflix rather than on whatever scores highest is
// what someone typing three letters fast is expecting.
const paletteEl = document.getElementById('palette');
const paletteInputEl = document.getElementById('palette-input');
const paletteListEl = document.getElementById('palette-list');
let paletteIndex = 0;

function paletteMatches() {
  const q = paletteInputEl.value.trim().toLowerCase();
  const all = state.services || [];
  return q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;
}

function renderPalette() {
  const matches = paletteMatches();
  if (paletteIndex >= matches.length) paletteIndex = Math.max(0, matches.length - 1);
  paletteListEl.replaceChildren();
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'palette-empty';
    li.textContent = 'No service by that name.';
    paletteListEl.appendChild(li);
    return;
  }
  matches.forEach((svc, i) => {
    const li = document.createElement('li');
    if (i === paletteIndex) li.className = 'on';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.style.background = svc.color;
    icon.textContent = initial(svc.name);

    const label = document.createElement('span');
    label.textContent = svc.name;

    li.append(icon, label);

    // In grid mode every choice adds a pane rather than switching, so say which panes this service
    // already holds — otherwise a second Enter on the same row looks like it did nothing.
    const panes = state.gridMode ? panesFor(svc.id) : [];
    if (panes.length) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = panes.map((p) => p.position).join(' ');
      where.title = `Already in pane ${panes.map((p) => p.position).join(', ')}`;
      li.appendChild(where);
    }

    li.addEventListener('click', (e) => choosePalette(svc, e.shiftKey));
    paletteListEl.appendChild(li);
  });
}

function openPalette() {
  paletteOpen = true;
  paletteIndex = 0;
  paletteInputEl.value = '';
  paletteEl.hidden = false;
  scrimEl.hidden = false;
  syncChromeRegion();
  renderPalette();
  paletteInputEl.focus();
  // Same reason as a sheet: the pointer is out over the page, and the sidebar must not stow out
  // from under the thing that is using it.
  holdPeek();
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  paletteEl.hidden = true;
  if (!openSheetName) scrimEl.hidden = true;
  syncChromeRegion();
  releasePeek();
}

// Enter switches; Shift+Enter tiles it as another grid pane. In grid mode there is nothing to
// switch to, so every choice adds a pane.
function choosePalette(svc, asPane) {
  if (!svc) return;
  closePalette();
  if (asPane || state.gridMode) window.shell.addGridPane(svc.id);
  else window.shell.switchService(svc.id);
}

// ---- Settings sheet ----
// Owns no state of its own: it renders what the main process sends and reports changes back over
// the same `shell` bridge, so a change made here shows up in the sidebar at once.
const adblockEl = document.getElementById('chk-adblock');
const adblockSubEl = document.getElementById('adblock-sub');
const adblockExtraEl = document.getElementById('adblock-extra');
const filterAgeEl = document.getElementById('filter-age');
const refreshBtn = document.getElementById('btn-refresh-filters');
const theaterEl = document.getElementById('chk-theater');
const autoHideEl = document.getElementById('chk-autohide');
const glassEl = document.getElementById('chk-glass');
const trayEl = document.getElementById('chk-tray');
const updateBtn = document.getElementById('btn-update');
const updateTitleEl = document.getElementById('update-title');
const updateSubEl = document.getElementById('update-sub');

const ADBLOCK_SUB = 'Brave Experimental Adblock Rules';

function setAdblockSub(text, isError) {
  adblockSubEl.textContent = text;
  adblockSubEl.classList.toggle('error', Boolean(isError));
}

function renderAdblockCount(blocked) {
  setAdblockSub(blocked > 0 ? `${blocked.toLocaleString()} requests blocked` : ADBLOCK_SUB, false);
}

// How stale the rules are, which is the useful question — not the exact timestamp.
function ageText(ms) {
  if (!ms) return 'Age unknown';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'Updated today';
  if (days === 1) return '1 day old';
  return `${days} days old`;
}

function renderAdblock(ab) {
  if (!ab) return;
  adblockEl.checked = ab.enabled;
  if (ab.error) setAdblockSub(`Filter list unavailable — ${ab.error}`, true);
  else if (ab.enabled) renderAdblockCount(ab.blocked);
  else setAdblockSub(ADBLOCK_SUB, false);

  // The filter controls only mean anything once the engine is actually loaded.
  adblockExtraEl.hidden = !ab.enabled || !ab.ready;
  filterAgeEl.textContent = ageText(ab.lastUpdated);
}

// `busy` covers the checking/downloading states, where the button is reporting on itself and must
// not be overwritten by a state broadcast arriving mid-download.
let updateBusy = false;

function renderUpdate() {
  updateTitleEl.textContent = state.version ? `StreamHub v${state.version}` : 'StreamHub';
  if (updateBusy) return;
  const version = state.updateAvailable;
  updateBtn.textContent = version ? `Update to v${version}` : 'Check for updates';
  updateBtn.title = version ? `Install StreamHub v${version}` : 'Check for updates';
  updateBtn.classList.toggle('has-update', Boolean(version));
  updateSubEl.textContent = version
    ? `v${version} is available. Installing restarts StreamHub.`
    : 'Checking is manual — nothing is downloaded until you say so.';
}

// ---- Removed sheet ----
const removedListEl = document.getElementById('removed-list');
const removedEmptyEl = document.getElementById('removed-empty');

function renderRemoved(removed) {
  removedListEl.replaceChildren();
  removedEmptyEl.hidden = removed.length > 0;
  for (const svc of removed) {
    const li = document.createElement('li');
    li.className = 'service restorable';
    li.dataset.id = svc.id;
    li.title = `Add ${svc.name} back`;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.style.background = svc.color;
    icon.textContent = initial(svc.name);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = svc.name;

    const plus = document.createElement('span');
    plus.className = 'restore-plus';
    plus.textContent = '+';

    li.append(icon, label, plus);
    li.addEventListener('click', () => window.shell.restoreService(svc.id));
    removedListEl.appendChild(li);
  }
}

// Both sheets, rendered from the state the sidebar already has. Cheap enough to do on every
// broadcast whether they are open or not, which keeps them from having to be woken up.
function renderSheets() {
  renderAdblock(state.adblock);
  theaterEl.checked = Boolean(state.enhance && state.enhance.theater);
  autoHideEl.checked = state.autoHideSidebar !== false;
  glassEl.checked = state.glassSidebar !== false;
  trayEl.checked = state.minimizeToTray === true;
  renderUpdate();
  renderRemoved(state.removed || []);
}

function applyState(next) {
  state = next;
  renderServices();
  renderSheets();
  removedCountEl.textContent = String(state.removed.length);
  setCollapsed(state.sidebarCollapsed);
  renderUpdateBadge();
  renderGridToggle();
  if (state.version) document.getElementById('app-version').textContent = `v${state.version}`;
  // Last, because it asks for the chrome region that all of the above has just settled.
  renderStow();
}

async function init() {
  // Not `initial` — that name is already the icon-letter helper above.
  const boot = await window.shell.getConfig();
  playing = Boolean(boot.playing);
  applyState(boot);

  // Reopen whatever was being watched last, so the app comes back where it was left rather
  // than always on the first service. Falls back to the first if that service is gone. Skipped
  // when a grid was restored — the main process is already showing it.
  if (!state.gridMode && !state.activeServiceId && state.services.length) {
    const last = state.services.find((s) => s.id === state.lastServiceId);
    window.shell.switchService((last || state.services[0]).id);
  }

  document.getElementById('btn-removed').addEventListener('click', () => openSheet('removed'));
  settingsBtn.addEventListener('click', () => openSheet('settings'));
  scrimEl.addEventListener('click', () => {
    closePalette();
    closeSheet();
  });
  for (const btn of document.querySelectorAll('[data-close-sheet]')) {
    btn.addEventListener('click', closeSheet);
  }
  // A click inside a sheet is not a click past it. Without this the window-level handler that
  // dismisses the context menu would take the sheet down with it.
  for (const el of Object.values(sheetEls)) el.addEventListener('click', (e) => e.stopPropagation());
  // Ctrl+, and Ctrl+K pressed anywhere but here — the app menu, or inside a service view, where
  // the page owns the keystroke until main.js takes it back.
  window.shell.onOpenSheet((name) => openSheet(name));
  window.shell.onOpenPalette(() => {
    if (paletteOpen) closePalette();
    else openPalette();
  });
  paletteEl.addEventListener('click', (e) => e.stopPropagation());
  paletteInputEl.addEventListener('input', () => {
    paletteIndex = 0;
    renderPalette();
  });

  // Toggling reloads every open service, and turning it on the first time may have to fetch the
  // filter list — so disable the box until the main process reports back, and render whatever
  // state it actually reached (which is "off" if the fetch failed).
  adblockEl.addEventListener('change', async () => {
    const wanted = adblockEl.checked;
    adblockEl.disabled = true;
    setAdblockSub(wanted ? 'Loading filter lists…' : ADBLOCK_SUB, false);
    try {
      renderAdblock(await window.shell.setAdblock(wanted));
    } finally {
      adblockEl.disabled = false;
    }
  });

  window.shell.onAdblockStats((blocked) => {
    if (adblockEl.checked) renderAdblockCount(blocked);
  });

  // Pull fresh filter lists on demand. Rebuilding the engine reloads every open service, so report
  // progress on the button rather than appearing to do nothing for a few seconds.
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const label = refreshBtn.textContent;
    refreshBtn.textContent = 'Updating…';
    try {
      renderAdblock(await window.shell.refreshFilters());
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = label;
    }
  });

  // Applied in place by the injected controller, so there is nothing to wait for and no reload to
  // sit through — unlike the ad blocker above.
  theaterEl.addEventListener('change', () => window.shell.setEnhance('theater', theaterEl.checked));
  autoHideEl.addEventListener('change', () => window.shell.setAutoHideSidebar(autoHideEl.checked));
  glassEl.addEventListener('change', () => window.shell.setGlassSidebar(glassEl.checked));
  trayEl.addEventListener('change', () => window.shell.setTray(trayEl.checked));

  // Downloading the new build takes a while (the AppImage is ~130MB), so report progress on the
  // button rather than leaving it sitting on "Checking…".
  window.shell.onUpdateProgress((percent) => {
    updateBtn.textContent = percent === null ? 'Checking…' : `Downloading ${percent}%`;
  });

  updateBtn.addEventListener('click', () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Checking…';
    updateBtn.classList.remove('has-update'); // stop pulsing the moment it is acted on
    updateBusy = true;
    Promise.resolve(window.shell.checkForUpdates()).finally(() => {
      updateBtn.disabled = false;
      updateBusy = false;
      // The main process has since told us whether an update is really there, so let the button
      // settle back to whatever the truth now is.
      renderUpdate();
    });
  });

  document
    .getElementById('btn-collapse')
    .addEventListener('click', () => window.shell.toggleSidebar());
  document.getElementById('btn-back').addEventListener('click', () => window.shell.back());
  document.getElementById('btn-reload').addEventListener('click', () => window.shell.reload());
  gridBtn.addEventListener('click', () => window.shell.toggleGrid());
  document
    .getElementById('btn-fullscreen')
    .addEventListener('click', () => window.shell.toggleFullscreen());

  // Playback rides its own channel rather than the state payload, so the sidebar can stow and
  // return without re-rendering the service list under an in-progress drag.
  window.shell.onPlayback((on) => {
    playing = on;
    renderStow();
  });

  // Reaching for the strip holds the sidebar in; leaving it lets go. Entering the sidebar itself
  // counts as reaching too — the strip sits underneath it, so a pointer that arrives while the
  // sidebar is already sliding in would otherwise never cross the strip at all.
  edgeStripEl.addEventListener('mouseenter', holdPeek);
  sidebarEl.addEventListener('mouseenter', holdPeek);
  sidebarEl.addEventListener('mouseleave', releasePeek);

  window.shell.onState((next) => applyState(next));
}

init();
