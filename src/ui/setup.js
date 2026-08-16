// The setup page's own script. It knows which service it is standing in for from the query
// string views.js loaded it with, and does exactly two things through the `setup` bridge
// (setup-preload.js): ask the main process whether a server answers at an address, and save the
// one the user settles on. Nothing here talks to the network itself.

const params = new URLSearchParams(location.search);
const serviceId = params.get('service') || '';
const serviceName = params.get('name') || 'your server';
const serviceColor = params.get('color') || '';
const previousUrl = params.get('prev') || '';

const iconEl = document.getElementById('icon');
const markNameEl = document.getElementById('mark-name');
const titleEl = document.getElementById('title');
const formEl = document.getElementById('form');
const inputEl = document.getElementById('address');
const connectEl = document.getElementById('connect');
const anywayEl = document.getElementById('anyway');
const statusEl = document.getElementById('status');

// Wear the service's own name and colour — the same initial-on-colour mark the sidebar draws,
// so the page reads as that service's rather than as a stray dialog.
iconEl.textContent = serviceName.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
if (serviceColor) iconEl.style.background = serviceColor;
markNameEl.textContent = serviceName;
titleEl.textContent = `Where is your ${serviceName} server?`;
document.title = `Set up ${serviceName}`;

// Changing the server rather than setting it for the first time: offer the old address back,
// selected, so a changed port is a few keystrokes instead of the whole thing again.
if (previousUrl) {
  inputEl.value = previousUrl;
  inputEl.select();
}
inputEl.focus();

let checking = false;
// The address the last failed check actually tried, which is what "use it anyway" would save —
// the normalised form, not the raw typing, so the two paths save the same thing.
let unverified = '';

function setStatus(text, kind) {
  statusEl.textContent = text;
  if (kind) statusEl.dataset.kind = kind;
  else delete statusEl.dataset.kind;
}

// The bridge is missing only if this page somehow loaded outside its own view, in which case
// there is nothing it can do — say so rather than offering buttons that do nothing.
if (!window.setup) {
  connectEl.disabled = true;
  inputEl.disabled = true;
  setStatus('This page is not connected to the app.', 'bad');
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (checking || !window.setup) return;
  const typed = inputEl.value.trim();
  if (!typed) {
    setStatus('Type the address your server answers on.', 'bad');
    inputEl.focus();
    return;
  }

  checking = true;
  connectEl.disabled = true;
  anywayEl.hidden = true;
  unverified = '';
  setStatus('Looking for a server there…', 'busy');

  const result = await window.setup.probe(typed);

  if (result && result.ok) {
    // Show what was found before the page goes: the view is rebuilt on the server the moment
    // this saves, and being told which server it reached is the confirmation that it is yours.
    setStatus(`Found ${result.name} — Jellyfin ${result.version}. Opening it…`, 'good');
    inputEl.value = result.url;
    await window.setup.save(serviceId, result.url);
    return;
  }

  checking = false;
  connectEl.disabled = false;
  setStatus((result && result.error) || 'Could not reach that address.', 'bad');
  // A server can be perfectly reachable and still not answer the check — behind an auth proxy,
  // or an older version. Let the user overrule us, as long as what they typed was an address
  // at all (a null url means it could not even be read as one).
  if (result && result.url) {
    unverified = result.url;
    anywayEl.hidden = false;
  }
});

anywayEl.addEventListener('click', () => {
  if (!unverified || !window.setup) return;
  anywayEl.hidden = true;
  setStatus(`Opening ${unverified}…`, 'busy');
  window.setup.save(serviceId, unverified);
});

// Typing again after a failure clears the verdict — it applies to the old address, not this one.
inputEl.addEventListener('input', () => {
  if (checking) return;
  anywayEl.hidden = true;
  setStatus('');
});
