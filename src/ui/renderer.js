// Renders the sidebar and wires it to the main process via the `shell` bridge exposed
// in preload.js. This script never touches the streaming sites themselves. The user's
// list lives in the main process (persisted to their userData); the sidebar just
// reflects the state it is sent and reports user actions back.

const listEl = document.getElementById('service-list');
const removedCountEl = document.getElementById('removed-count');
const settingsBtn = document.getElementById('btn-settings');
const menuEl = document.getElementById('service-menu');
const menuTitleEl = document.getElementById('menu-title');
const menuAdblockEl = document.getElementById('menu-adblock');
const menuSignoutEl = document.getElementById('menu-signout');

let state = { services: [], removed: [], activeServiceId: null, sidebarCollapsed: false };
let menuServiceId = null; // the service the context menu is currently open for

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
  li.className = 'service' + (svc.id === state.activeServiceId ? ' active' : '');
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
  li.addEventListener('click', () => window.shell.switchService(svc.id));
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
  // Keep the menu on screen when the row is near the bottom edge.
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, window.innerWidth - width - 6)}px`;
  menuEl.style.top = `${Math.min(y, window.innerHeight - height - 6)}px`;
}

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
  if (e.key === 'Escape') closeServiceMenu();
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

function applyState(next) {
  state = next;
  renderServices();
  removedCountEl.textContent = String(state.removed.length);
  setCollapsed(state.sidebarCollapsed);
  renderUpdateBadge();
  if (state.version) document.getElementById('app-version').textContent = `v${state.version}`;
}

async function init() {
  applyState(await window.shell.getConfig());

  // Reopen whatever was being watched last, so the app comes back where it was left rather
  // than always on the first service. Falls back to the first if that service is gone.
  if (!state.activeServiceId && state.services.length) {
    const last = state.services.find((s) => s.id === state.lastServiceId);
    window.shell.switchService((last || state.services[0]).id);
  }

  document.getElementById('btn-removed').addEventListener('click', () => window.shell.openRemovedWindow());
  settingsBtn.addEventListener('click', () => window.shell.openSettingsWindow());

  document
    .getElementById('btn-collapse')
    .addEventListener('click', () => window.shell.toggleSidebar());
  document.getElementById('btn-back').addEventListener('click', () => window.shell.back());
  document.getElementById('btn-reload').addEventListener('click', () => window.shell.reload());
  document.getElementById('btn-pip').addEventListener('click', () => window.shell.togglePip());
  document
    .getElementById('btn-fullscreen')
    .addEventListener('click', () => window.shell.toggleFullscreen());

  window.shell.onState((next) => applyState(next));
}

init();
