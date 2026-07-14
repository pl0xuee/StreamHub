// The settings window: the ad blocker, the tray behaviour and app updates. Like the sidebar,
// it owns no state — it renders what the main process sends and reports changes back over the
// same `shell` bridge (see preload.js), so a change made here shows up in the sidebar at once.

const adblockEl = document.getElementById('chk-adblock');
const adblockSubEl = document.getElementById('adblock-sub');
const adblockExtraEl = document.getElementById('adblock-extra');
const filterAgeEl = document.getElementById('filter-age');
const refreshBtn = document.getElementById('btn-refresh-filters');
const trayEl = document.getElementById('chk-tray');
const updateBtn = document.getElementById('btn-update');
const updateTitleEl = document.getElementById('update-title');
const updateSubEl = document.getElementById('update-sub');

const ADBLOCK_SUB = 'Brave Experimental Adblock Rules';

let state = {};

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

// `busy` covers the checking/downloading states, where the button is reporting on itself and
// must not be overwritten by a state broadcast arriving mid-download.
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

function applyState(next) {
  state = next;
  renderAdblock(state.adblock);
  trayEl.checked = state.minimizeToTray === true;
  renderUpdate();
}

async function init() {
  applyState(await window.shell.getConfig());

  // Toggling reloads every open service, and turning it on the first time may have to fetch
  // the filter list — so disable the box until the main process reports back, and render
  // whatever state it actually reached (which is "off" if the fetch failed).
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

  // Pull fresh filter lists on demand. Rebuilding the engine reloads every open service, so
  // report progress on the button rather than appearing to do nothing for a few seconds.
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

  trayEl.addEventListener('change', () => window.shell.setTray(trayEl.checked));

  // Downloading the new build takes a while (the AppImage is ~130MB), so report progress on
  // the button rather than leaving it sitting on "Checking…".
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
      renderUpdate();
    });
  });

  window.shell.onState((next) => applyState(next));
}

init();
