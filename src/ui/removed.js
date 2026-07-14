// The separate "removed services" window. Lists services the user has deleted; clicking
// one restores it to the main sidebar. State is pushed from the main process (same
// `state` broadcast the sidebar receives), so this list stays in sync live.

const listEl = document.getElementById('removed-list');
const emptyEl = document.getElementById('removed-empty');

function initial(name) {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
}

function render(removed) {
  listEl.innerHTML = '';
  emptyEl.hidden = removed.length > 0;
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
    listEl.appendChild(li);
  }
}

async function init() {
  const state = await window.shell.getConfig();
  render(state.removed || []);
  window.shell.onState((next) => render(next.removed || []));
}

init();
