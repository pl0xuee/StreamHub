// Renders the sidebar and wires it to the main process via the `shell` bridge exposed
// in preload.js. This script never touches the streaming sites themselves. The user's
// list lives in the main process (persisted to their userData); the sidebar just
// reflects the state it is sent and reports user actions back.

const listEl = document.getElementById('service-list');
const removedCountEl = document.getElementById('removed-count');
const adblockEl = document.getElementById('chk-adblock');
const adblockSubEl = document.getElementById('adblock-sub');

let state = { services: [], removed: [], activeServiceId: null, sidebarCollapsed: false };

function initial(name) {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
}

function makeServiceEl(svc) {
  const li = document.createElement('li');
  li.className = 'service' + (svc.id === state.activeServiceId ? ' active' : '');
  li.dataset.id = svc.id;
  li.draggable = true;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.style.background = svc.color;
  icon.textContent = initial(svc.name);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = svc.name;

  const del = document.createElement('button');
  del.className = 'del';
  del.title = `Remove ${svc.name}`;
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    window.shell.removeService(svc.id);
  });

  li.append(icon, label, del);
  li.addEventListener('click', () => window.shell.switchService(svc.id));

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

const ADBLOCK_SUB = 'Brave Experimental Adblock Rules';

function setAdblockSub(text, isError) {
  adblockSubEl.textContent = text;
  adblockSubEl.classList.toggle('error', Boolean(isError));
}

function renderAdblockCount(blocked) {
  setAdblockSub(
    blocked > 0 ? `${blocked.toLocaleString()} requests blocked` : ADBLOCK_SUB,
    false,
  );
}

function renderAdblock(ab) {
  if (!ab) return;
  adblockEl.checked = ab.enabled;
  if (ab.error) setAdblockSub(`Filter list unavailable — ${ab.error}`, true);
  else if (ab.enabled) renderAdblockCount(ab.blocked);
  else setAdblockSub(ADBLOCK_SUB, false);
}

// The button is the only place an update is announced, so it says which version is waiting
// rather than just glowing. `busy` covers the checking/downloading states, where the button
// is reporting on itself and must not be overwritten by a state broadcast.
let updateBusy = false;

function renderUpdateButton() {
  if (updateBusy) return;
  const btn = document.getElementById('btn-update');
  const version = state.updateAvailable;
  btn.textContent = version ? `Update to v${version}` : 'Check for updates';
  btn.title = version ? `Install StreamHub v${version}` : 'Check for updates';
  btn.classList.toggle('has-update', Boolean(version));
  // The button is hidden in the collapsed rail, so mark the body too — that lets the rail
  // show a dot instead, rather than the update going unmentioned until the sidebar is opened.
  document.body.classList.toggle('update-available', Boolean(version));
}

function applyState(next) {
  state = next;
  renderServices();
  removedCountEl.textContent = String(state.removed.length);
  setCollapsed(state.sidebarCollapsed);
  renderAdblock(state.adblock);
  renderUpdateButton();
  if (state.version) document.getElementById('app-version').textContent = `v${state.version}`;
}

async function init() {
  applyState(await window.shell.getConfig());

  // Auto-open the first service so the content area is never a blank panel.
  if (!state.activeServiceId && state.services[0]) {
    window.shell.switchService(state.services[0].id);
  }

  document.getElementById('btn-removed').addEventListener('click', () => window.shell.openRemovedWindow());
  const updateBtn = document.getElementById('btn-update');

  // Downloading the new build takes a while (the AppImage is ~130MB), so report progress
  // on the button rather than leaving it sitting on "Checking…".
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
      // The main process has since told us whether an update is really there, so let the
      // button settle back to whatever the truth now is.
      renderUpdateButton();
    });
  });
  // Toggling reloads every open service, and turning it on the first time may have to
  // fetch the filter list — so disable the box until the main process reports back, and
  // render whatever state it actually reached (which is "off" if the fetch failed).
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
