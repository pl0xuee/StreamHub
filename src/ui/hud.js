// The grid HUD: the panes as they are actually tiled, how they are arranged, and a line saying how
// to work them.
//
// These lived in the sidebar until the sidebar became a strip you reach for — three controls
// crammed into 220px, with the service list paying for all of them. They are a view of their own
// now, parked at the top of the window, and like the sidebar's own strip that view is only ever as
// big as it is drawn: a view swallows clicks across its whole rect, so it asks the main process to
// grow it before it expands and to shrink it again after.
//
// It owns no state. The main process broadcasts the same payload the sidebar gets.

const hudEl = document.getElementById('hud');
const nubEl = document.getElementById('hud-nub');
const gridLayoutEl = document.getElementById('grid-layout');
const gridPreviewEl = document.getElementById('grid-preview');
const gridHintEl = document.getElementById('grid-hint');

let state = { services: [], gridPanes: [], gridLayout: 'auto' };

function initial(name) {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
}

// The panes drawn in the arrangement they really have on screen — the CSS mirrors gridRects() in
// views.js, so what this shows is what the window looks like. A flat strip of chips could say which
// pane came first but never what the screen would look like; this says both.
//
// It is also the only place the tiling order can be edited: the numbered badges on the service rows
// say where a pane is and close it, but a service holding two panes has no way to say "swap those
// two" from its own row. Dragging moves the *pane*, which keeps its own view, so the page a tile is
// showing travels with it — nothing reloads and nothing playing is interrupted.
function renderGridPreview() {
  const panes = state.gridPanes || [];
  gridPreviewEl.dataset.layout = state.gridLayout || 'auto';
  gridPreviewEl.replaceChildren();

  panes.forEach((pane, i) => {
    const svc = state.services.find((s) => s.id === pane.serviceId);
    if (!svc) return; // a pane whose service has gone; the main process drops it on next reconcile
    const tile = document.createElement('div');
    tile.className = 'pane-tile';
    tile.dataset.paneId = pane.paneId;
    tile.draggable = true;
    tile.title = `Pane ${i + 1}: ${svc.name} — drag to move it`;

    const num = document.createElement('span');
    num.className = 'pane-tile-num';
    num.textContent = String(i + 1);

    const mark = document.createElement('span');
    mark.className = 'pane-tile-mark';
    mark.style.background = svc.color;
    mark.textContent = initial(svc.name);

    // The last pane cannot be closed — an empty grid would show nothing, and the grid toggle is the
    // way out of the mode. Drop the button rather than offering a dead one.
    const close = document.createElement('button');
    close.className = 'pane-close';
    close.textContent = '×';
    close.title = `Close pane ${i + 1} (${svc.name})`;
    close.hidden = panes.length < 2;
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.shell.removeGridPane(pane.paneId);
    });

    tile.append(num, mark, close);
    tile.addEventListener('dragstart', () => {
      // Defer so the class lands after the drag image is captured.
      requestAnimationFrame(() => tile.classList.add('dragging'));
    });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      // Commit whatever order the DOM ended up in.
      const ids = Array.from(gridPreviewEl.children).map((c) => c.dataset.paneId);
      window.shell.reorderGridPanes(ids);
    });
    gridPreviewEl.appendChild(tile);
  });

  // The arrangement is drawn from this and the layout above, so the preview re-tiles itself the
  // moment either changes. Taken from what actually rendered rather than from the pane count: a
  // pane whose service has gone is skipped, and a template expecting a tile that is not there would
  // lay out around a hole.
  gridPreviewEl.dataset.count = String(gridPreviewEl.children.length);
}

// The tiles in reading order, grouped into rows by their top edge. The preview is a real two-
// dimensional arrangement, so finding an insertion point needs both axes — unlike the service list,
// which is a single column and splits on y alone.
function tileRows() {
  const rows = [];
  for (const el of gridPreviewEl.querySelectorAll('.pane-tile:not(.dragging)')) {
    const box = el.getBoundingClientRect();
    const row = rows.find((r) => Math.abs(r.top - box.top) < 4);
    if (row) row.items.push({ el, box });
    else rows.push({ top: box.top, items: [{ el, box }] });
  }
  return rows;
}

// During a drag, the tile the dragged one should be inserted before (null = put it last).
function afterTile(x, y) {
  const rows = tileRows();
  if (!rows.length) return null;
  // Which axis decides "before" has to come from the arrangement, not from the tiles left on
  // screen: dragging one of two side-by-side tiles leaves a single tile behind, which looks exactly
  // like a one-tall stack and would then be split on the wrong axis. Only 'rows' stacks vertically
  // — 'columns' is always a strip, and 'auto' is two columns or a block.
  if ((state.gridLayout || 'auto') === 'rows') {
    for (const { items } of rows) {
      const { el, box } = items[0];
      if (y < box.top + box.height / 2) return el;
    }
    return null;
  }
  for (let i = 0; i < rows.length; i += 1) {
    const { items } = rows[i];
    if (y > items[items.length - 1].box.bottom) continue; // the pointer is below this row entirely
    for (const { el, box } of items) {
      if (x < box.left + box.width / 2) return el;
    }
    // Past the last tile in this row: the next row's first tile is the insertion point.
    const next = rows[i + 1];
    return next ? next.items[0].el : null;
  }
  return null;
}

gridPreviewEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = gridPreviewEl.querySelector('.dragging');
  if (!dragging) return;
  const after = afterTile(e.clientX, e.clientY);
  if (after == null) gridPreviewEl.appendChild(dragging);
  else gridPreviewEl.insertBefore(dragging, after);
});

gridLayoutEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (btn && !btn.disabled) window.shell.setGridLayout(btn.dataset.layout);
});

function renderLayoutPicker() {
  // With four panes tiled there is nothing more to add, so say so — better than clicks in the
  // sidebar that silently do nothing.
  gridHintEl.textContent = state.gridFull
    ? 'All four panes are in use. Close one to add another.'
    : 'Click a service to add a pane. Drag a tile to move it.';

  // Mark the arrangement in use. With a single pane there is nothing to arrange, so the choice is
  // disabled rather than hidden — it keeps the HUD from reflowing as panes come and go.
  const only = (state.gridPanes || []).length < 2;
  for (const btn of gridLayoutEl.querySelectorAll('button')) {
    const chosen = btn.dataset.layout === (state.gridLayout || 'auto');
    btn.classList.toggle('active', chosen);
    btn.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    btn.disabled = only;
  }
  gridLayoutEl.title = only ? 'Add a second pane to choose an arrangement' : '';
}

// Same bargain the sidebar's hover strip makes: ask to be grown before expanding, and to be shrunk
// once collapsed, so the rest of the window belongs to the picture.
//
// The height is measured rather than agreed in advance. It depends on the preview's aspect ratio,
// on how many lines the hint wraps to and on the user's font — a constant in main.js would be a
// guess that quietly drifts out of step with the CSS, and being short by even a little clips the
// arrangement buttons off the bottom of the view.
nubEl.addEventListener('mouseenter', () => {
  document.body.classList.add('expanded');
  window.shell.setHudExpanded(true, Math.ceil(hudEl.getBoundingClientRect().height));
});
hudEl.addEventListener('mouseleave', () => {
  document.body.classList.remove('expanded');
  window.shell.setHudExpanded(false);
});

// The panel's height changes with its contents — a fourth pane makes the preview no taller, but the
// hint line swapping to "All four panes are in use." can rewrap. Re-report while it is open.
const resize = new ResizeObserver(() => {
  if (!document.body.classList.contains('expanded')) return;
  window.shell.setHudExpanded(true, Math.ceil(hudEl.getBoundingClientRect().height));
});
resize.observe(hudEl);

function applyState(next) {
  state = next;
  renderGridPreview();
  renderLayoutPicker();
}

async function init() {
  applyState(await window.shell.getConfig());
  window.shell.onState((next) => applyState(next));
}

init();
