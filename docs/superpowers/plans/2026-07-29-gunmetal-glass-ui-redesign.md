# Gunmetal Glass UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace StreamHub's opaque "theater dark" sidebar with a translucent gunmetal-grey chrome that floats over the video, and rework the surrounding UX so nothing covers the picture unless the user reaches for it.

**Architecture:** Service `WebContentsView`s move to full-window bounds and `chromeView` is raised on top with a transparent background. Because a native view swallows mouse events across its whole rect regardless of CSS transparency, main.js sizes `chromeView` to exactly the slice the chrome needs right now — an 8px hover strip, a 56px rail, a 220px sidebar, or the whole window when a sheet, palette or context menu is open. The renderer asks for a region; main.js is the only thing that sets bounds. A second small transparent view carries the grid HUD.

**Tech Stack:** Electron (castLabs ECS 43, `BaseWindow` + `WebContentsView`), vanilla JS renderer, hand-written CSS. No build step, no framework, no test runner.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-gunmetal-glass-ui-redesign-design.md`. Read it before starting.
- **No test suite exists in this repo.** Verification is running the real app (`npm start`) and checking stated observations. Every task ends with a manual verification step whose expected observation is written out. Do not invent a test framework; do not claim a task passes without running the app.
- **`node_modules` may be absent.** `npm install` downloads the castLabs ECS binary (~150 MB) and must complete before any verification step.
- **No `backdrop-filter`.** It samples only the current rendering context; the video is a separate `WebContents`, so the rule would be a silent no-op. Never add one.
- **Colour tokens are fixed** — use exactly the values in Task 4's token block. No warm/gold values survive anywhere.
- **`--exit` (`#b8434b`) is only ever used for removing, signing out, or closing a pane.** Nothing else in the app carries colour except the services' own brand marks.
- **Nothing may reflow the page being watched.** Chrome state changes are opacity/transform and view *bounds* only; never resize a service view as a side effect of showing or hiding chrome.
- **Comment style:** this codebase explains *why*, in prose, above the thing. Match it. Do not add "// set the width" comments.
- **Commit after every task.** Conventional-commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`), body explaining why. End every commit message with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Spike — prove transparent view-over-view compositing

Everything downstream assumes a transparent `WebContentsView` composites over another one in the same `BaseWindow`. That is unverified on Wayland/KDE with castLabs ECS 43. Prove it before building on it.

**Files:**
- Create: `/tmp/claude-1000/-home-jamespc-Documents-Projects-StreamHub/dfc8cc2d-78ac-4434-a6d8-e38b08116235/scratchpad/spike/main.js`
- Create: `/tmp/claude-1000/-home-jamespc-Documents-Projects-StreamHub/dfc8cc2d-78ac-4434-a6d8-e38b08116235/scratchpad/spike/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a yes/no answer that gates Task 3. Nothing in the repo.

- [ ] **Step 1: Wait for `npm install` to finish**

Run: `ls node_modules/electron/dist/electron`
Expected: the path exists. If not, run `npm install` and wait.

- [ ] **Step 2: Write the spike**

Create `scratchpad/spike/package.json`:

```json
{ "name": "spike", "version": "1.0.0", "main": "main.js" }
```

Create `scratchpad/spike/main.js`:

```js
// Does a transparent WebContentsView composite over another one? Bottom view is a solid red
// page; top view is a half-width page with a transparent body and one translucent grey panel.
// If compositing works, the left half of the window shows grey-over-red; if it does not, it
// shows either opaque grey or opaque black.
const { app, BaseWindow, WebContentsView } = require('electron');

app.whenReady().then(() => {
  const win = new BaseWindow({ width: 900, height: 500, backgroundColor: '#000000' });

  const bottom = new WebContentsView();
  win.contentView.addChildView(bottom);
  bottom.setBounds({ x: 0, y: 0, width: 900, height: 500 });
  bottom.webContents.loadURL(
    'data:text/html,<body style="margin:0;background:%23ff0000">' +
      '<h1 style="color:%23fff;font:48px sans-serif;padding:40px">BOTTOM</h1></body>',
  );

  const top = new WebContentsView();
  win.contentView.addChildView(top);
  top.setBackgroundColor('#00000000');
  top.setBounds({ x: 0, y: 0, width: 450, height: 500 });
  top.webContents.loadURL(
    'data:text/html,<body style="margin:0;background:transparent">' +
      '<div style="height:100%;background:rgba(30,35,43,0.86)">' +
      '<h1 style="color:%23fff;font:32px sans-serif;padding:40px">TOP (glass)</h1></div></body>',
  );
});
```

- [ ] **Step 3: Run the spike and look at it**

Run: `npx electron scratchpad/spike` from the repo root (uses the installed ECS binary).

Expected, for the spike to pass: the left half is dark grey-blue with the red of the bottom view clearly showing through it, and the word BOTTOM legible underneath TOP. The right half is plain red.

Failure looks like: the left half is flat opaque grey with no red at all, or flat black.

- [ ] **Step 4: Record the result**

If it **passed**, note it and continue to Task 2.

If it **failed**, stop and report to the user before writing any more code. The fallback is the `glassSidebar: false` path (docked opaque sidebar, service views inset) which Task 3 builds anyway — but it becomes the only mode, and Tasks 5–9 need re-scoping. This is a decision for the user, not for the implementer.

- [ ] **Step 5: No commit**

The spike lives in the scratchpad and is not committed. Nothing in the repo changed.

---

### Task 2: YouTube theater mode fills the window

Independent of the glass work and the most direct complaint: theater mode leaves the title and description peeking in under the player. `#full-bleed-container` is capped at `min(100vh, 56.25vw)`, which on a landscape window resolves to the 16:9 height for the available width and so always leaves a band below. A flat `100vh` makes the player own the window; YouTube then centres the video inside it with letterbox bars.

**Files:**
- Modify: `src/enhance-youtube.js:56-69` (the `CSS` template's last rule)
- Modify: `src/ui/settings.html:47` (the setting's sub-label, which describes the old behaviour)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the size-cap rule and its comment**

In `src/enhance-youtube.js`, replace this block:

```js
/* The size cap itself, and the point of the whole feature. YouTube's theater mode ("full bleed")
   deliberately stops short of the window bottom so the title and description stay peeking in
   underneath — it caps #full-bleed-container from its own layout code, which is what this
   overrides. Scrolling still works, so the description and comments are one flick away rather
   than gone; that is what makes this worth doing instead of just going fullscreen.

   min() rather than a flat 100vh because the container is full-width: past 16:9 the extra height
   goes to black bars above and below the picture, not to a bigger picture. So take the smaller of
   "as tall as the window" and "as tall as this width's 16:9", which on the usual landscape window
   is the latter. 100vh stays the ceiling for tall or narrow windows. */
html.${ROOT_CLASS} ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
  height: min(100vh, 56.25vw) !important;
  max-height: 100vh !important;
}
```

with:

```js
/* The size cap itself, and the point of the whole feature. YouTube's theater mode ("full bleed")
   deliberately stops short of the window bottom so the title and description stay peeking in
   underneath — it caps #full-bleed-container from its own layout code, which is what this
   overrides.

   A flat 100vh, so the player owns the window and nothing else is on screen. The picture does not
   stretch to fill it: YouTube fits the video to the container and centres it, so past 16:9 the
   spare height becomes bars above and below and the video sits in the middle of the window, which
   is where someone watching it is looking. Scrolling still works, so the description and comments
   are one flick away rather than gone; that is what makes this worth doing instead of just going
   fullscreen. */
html.${ROOT_CLASS} ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
  height: 100vh !important;
  max-height: 100vh !important;
}
```

- [ ] **Step 2: Update the setting's description**

In `src/ui/settings.html`, replace:

```html
<span class="setting-sub">The player fills the window; the top bar hides until you reach for it</span>
```

with:

```html
<span class="setting-sub">The video fills the window on its own, centred; the top bar hides until you reach for it</span>
```

- [ ] **Step 3: Run the app and check it**

Run: `npm start`

Then: click YouTube in the sidebar, open any video.

Expected: the player fills the full height of the window. The video sits vertically centred with equal black bars above and below (on a window wider than 16:9). No title, description or comment text is visible until you scroll. Scrolling down still reaches the description and comments.

- [ ] **Step 4: Commit**

```bash
git add src/enhance-youtube.js src/ui/settings.html
git commit -m "$(cat <<'EOF'
fix: let YouTube theater mode have the window to itself

The cap was min(100vh, 56.25vw), which on a landscape window is always the
16:9 height for the available width — so a band of title and description
sat under the player, which is not what "full-window" says. A flat 100vh
gives the player the window; YouTube fits and centres the video inside it,
so the picture lands in the middle with bars above and below instead of
sharing the screen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Chrome region manager and full-width service views

The structural change. No visual change yet — the sidebar keeps its current colours; what moves is *where the views are* and *who is on top*. Doing this before the restyle means a compositing or mouse-event problem shows up on a UI you already recognise.

**Files:**
- Modify: `src/config.js:22-48` (add `glassSidebar`)
- Modify: `src/main.js:64-68` (region constants), `:128-132` (`layout()`), `:332-394` (`createWindow`), `:193-213` (`statePayload`), IPC block near `:589`
- Modify: `src/views.js:206-222` (constructor), `:375-409` (`setVisibleSet`), `:429-444` (`layout`), `:501-511` (`setVideoFullscreen`)
- Modify: `src/preload.js` (add `setChromeRegion`)
- Modify: `src/ui/renderer.js` (ask for a region)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `window.shell.setChromeRegion(region)` where `region` is `'peek' | 'rail' | 'sidebar' | 'full'` — used by Tasks 5, 6, 7.
  - `viewManager.onStackChange` — a no-arg callback main.js sets to re-raise the chrome.
  - `viewManager.onFullscreenChange(on)` — a callback main.js sets to hide/show the chrome.
  - `viewManager.glass` (boolean) — whether service views run full width.
  - `state.glassSidebar` in the state payload.

- [ ] **Step 1: Add the `glassSidebar` setting**

In `src/config.js`, in `defaultSettings()`, add after `minimizeToTray: false,`:

```js
    // The sidebar floats over the video as tinted glass. Off docks it beside the video instead,
    // the way it used to sit: some people would rather have nothing at all over the picture, and
    // it is also the way out if a compositor will not composite one view over another.
    glassSidebar: true,
```

In `cleanSettings()`, add alongside the others:

```js
    glassSidebar: s.glassSidebar !== false,
```

- [ ] **Step 2: Teach `ViewManager` about glass, stacking and fullscreen**

In `src/views.js`, in the constructor, add after `this.onPlaybackChange = () => {};`:

```js
    this.glass = true; // service views run the full window width, with the chrome floating over them
    // main.js owns the view stack: it re-raises the chrome after we raise a service view, and
    // hides it entirely while a site is in fullscreen. ViewManager does not know what the chrome
    // is, only that something has to be told.
    this.onStackChange = () => {};
    this.onFullscreenChange = () => {};
```

Replace the body of `layout(width, height)`'s non-fullscreen half — the two lines

```js
    const x = this.sidebarWidth;
    const areaW = Math.max(0, width - x);
```

with:

```js
    // With glass on, the picture runs the full width of the window and the chrome floats over its
    // left edge. Docked, it starts where the sidebar ends, as it always did.
    const x = this.glass ? 0 : this.sidebarWidth;
    const areaW = Math.max(0, width - x);
```

At the end of `setVisibleSet()`, after `this.layout(this.bounds.width, this.bounds.height);`, add:

```js
    // Raising a service view put it above the chrome; put the chrome back on top.
    this.onStackChange();
```

In `setVideoFullscreen(on, view)`, after `this.videoFullscreen = on;` add:

```js
    this.onFullscreenChange(on);
```

and at the end of that method, after `this.layout(...)`, add:

```js
    if (!on) this.onStackChange();
```

- [ ] **Step 3: Add the region manager to main.js**

In `src/main.js`, after the `SIDEBAR_RAIL_WIDTH` constant, add:

```js
// How wide a slice of the window the chrome view occupies, by name.
//
// This exists because a native view swallows mouse events across its whole rectangle whatever CSS
// does with transparency: a full-window transparent chrome would eat every click meant for the
// video. So the chrome is never wider than the part of it that is actually meant to be clickable —
// a hover strip while it is stowed, the rail or the sidebar while it is out, and the whole window
// only while something (a sheet, the palette, a context menu) genuinely needs to be over the
// picture. The renderer asks for a region by name; this is the only place bounds are set.
const CHROME_REGIONS = { peek: 8, rail: SIDEBAR_RAIL_WIDTH, sidebar: SIDEBAR_WIDTH, full: null };
let chromeRegion = 'sidebar';

function chromeRegionWidth(windowWidth) {
  const width = CHROME_REGIONS[chromeRegion];
  return width === null || width === undefined ? windowWidth : width;
}
```

- [ ] **Step 4: Make `layout()` use it**

Replace `layout()` (main.js:128-132) with:

```js
function layout() {
  const { width, height } = baseWindow.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width: chromeRegionWidth(width), height });
  viewManager.layout(width, height);
}
```

- [ ] **Step 5: Wire the chrome view up in `createWindow()`**

In `createWindow()`, change the `BaseWindow` background colour from `'#080a10'` to `'#0d1015'`.

After `baseWindow.contentView.addChildView(chromeView);` add:

```js
  // Transparent so the picture shows through the chrome. The page sets its own background to
  // `transparent` too — both halves are needed, or Chromium paints the view's base colour first.
  chromeView.setBackgroundColor('#00000000');
```

After `viewManager.onPlaybackChange = onPlaybackChange;` add:

```js
  viewManager.glass = config.settings.glassSidebar !== false;
  // Raising a service view puts it above the chrome; this puts the chrome back on top.
  viewManager.onStackChange = () => {
    if (chromeView && !chromeView.webContents.isDestroyed()) {
      baseWindow.contentView.addChildView(chromeView);
    }
  };
  // A site in fullscreen owns the window outright — a strip of sidebar floating over it would be
  // the one thing left on screen that isn't the film.
  viewManager.onFullscreenChange = (on) => {
    if (chromeView && !chromeView.webContents.isDestroyed()) chromeView.setVisible(!on);
  };
```

- [ ] **Step 6: Add the region IPC**

In `src/main.js`, next to the other `ipcMain.on` handlers (near `toggle-sidebar`), add:

```js
// The renderer knows what the chrome is showing; main.js knows what that costs in mouse events.
// See CHROME_REGIONS.
ipcMain.on('set-chrome-region', (_e, region) => {
  if (!Object.prototype.hasOwnProperty.call(CHROME_REGIONS, region)) return;
  if (region === chromeRegion) return;
  chromeRegion = region;
  layout();
});
```

In the `toggle-sidebar` handler, replace the `viewManager.setSidebarWidth(...)` line with:

```js
  // Docked, the service view starts where the sidebar ends, so collapsing widens the picture.
  // On glass the picture is already full width and only the chrome's own region changes — which
  // the renderer asks for once it has re-rendered.
  viewManager.setSidebarWidth(sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH);
```

- [ ] **Step 7: Publish `glassSidebar` in the state payload**

In `statePayload()`, add alongside `minimizeToTray`:

```js
    glassSidebar: config.settings.glassSidebar !== false,
```

- [ ] **Step 8: Expose the bridge method**

In `src/preload.js`, add inside the `shell` object:

```js
  // Which slice of the window the chrome view occupies: 'peek' | 'rail' | 'sidebar' | 'full'.
  // A native view eats mouse events across its whole rect, so the chrome is only ever as wide as
  // the part of it that is meant to be clickable.
  setChromeRegion: (region) => ipcRenderer.send('set-chrome-region', region),
```

- [ ] **Step 9: Ask for the right region from the renderer**

In `src/ui/renderer.js`, add above `applyState`:

```js
// Which slice of the window the chrome needs right now. Anything that has to be drawn over the
// picture — a sheet, the palette, a right-click menu — needs the whole window; otherwise the
// chrome is only as wide as the sidebar it is showing. See CHROME_REGIONS in main.js.
function chromeRegion() {
  if (!menuEl.hidden) return 'full';
  return state.sidebarCollapsed ? 'rail' : 'sidebar';
}

function syncChromeRegion() {
  window.shell.setChromeRegion(chromeRegion());
}
```

Call `syncChromeRegion()` at the end of `applyState()`, at the end of `openServiceMenu()`, and at the end of `closeServiceMenu()`.

- [ ] **Step 10: Run the app and check the structure**

Run: `npm start`

Expected:
1. The sidebar is visible and every service still switches, exactly as before.
2. The video now runs *behind* the sidebar — the sidebar's colours are still opaque, so this is visible only at the sidebar's right edge, where the picture no longer starts at 220px. Check by switching to YouTube and watching the page's own left rail: it now begins under the sidebar rather than beside it.
3. Right-click a service. The context menu draws fully over the video instead of being clipped at 220px — this is a bug in the current build and is fixed by the `full` region.
4. Click somewhere on the video well right of the sidebar. It responds — mouse events are reaching the service view.
5. Play a video and press F11, then enter the site's own fullscreen. The sidebar disappears entirely; leaving fullscreen brings it back.
6. Grid mode with two panes: both tile from the left window edge, and the sidebar floats over the first one.

- [ ] **Step 11: Commit**

```bash
git add src/config.js src/main.js src/views.js src/preload.js src/ui/renderer.js
git commit -m "$(cat <<'EOF'
refactor: float the chrome over the picture instead of beside it

Service views now fill the window and the chrome view is raised on top of
them with a transparent background, which is what lets the sidebar become
glass. The catch is that a native view swallows mouse events across its
whole rect whatever CSS does with transparency, so a full-window chrome
would eat every click meant for the video: main.js now sizes the chrome to
just the slice it needs, and the renderer asks for that slice by name.

Falls back to the old docked layout with glassSidebar off. Incidentally
fixes the right-click menu being clipped at the sidebar's width.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The gunmetal stylesheet

The restyle. Most of `styles.css` survives as-is with renamed tokens — the warm/cool split it was built on maps directly onto steel-on-gunmetal. What is genuinely new is the glass material itself.

**Files:**
- Modify: `src/ui/styles.css` (throughout)
- Modify: `src/main.js` (`openRemovedWindow`, `openSettingsWindow` background colours)

**Interfaces:**
- Consumes: `viewManager.glass` and `state.glassSidebar` from Task 3.
- Produces: the token names below, used by every later task's CSS.

- [ ] **Step 1: Replace the file header and `:root` block**

Replace `src/ui/styles.css:1-52` (the comment and `:root`) with:

```css
/* StreamHub — "gunmetal glass".
 *
 * The chrome is a pane of tinted glass laid over the picture: one cold material, lit with one
 * cold accent. Everything at rest is gunmetal; anything *lit* — the active service, a hovered
 * control, keyboard focus — is steel. Nothing else carries colour, with two deliberate
 * exceptions: the services' own brand marks (the posters on the wall) and the exit-sign red,
 * which is only ever used for leaving or removing.
 *
 * The glass is tinted, not frosted. backdrop-filter samples the current rendering context and the
 * video is a different WebContents entirely, so there is nothing there for Chromium to blur — the
 * picture shows through sharply, dimmed and cooled by the tint. Contrast is therefore set by the
 * worst case, a white frame behind the sidebar, which is why --dim sits as light as it does.
 *
 * The chrome's job is to get out of the way of the picture, so it is flat: no gradients, no inset
 * highlights, no bevels. One hairline of light down its edge is what says "glass" — where
 * something needs to stand out it is lit, not embossed.
 */

:root {
  /* The window itself, seen only through the grid's gutters. */
  --ink: #0d1015;

  /* The glass. Alpha is doing the work: over a white frame 0.86 gunmetal resolves to about
     #3c3f43, which is what the text colours below are chosen against. */
  --gun: rgba(30, 35, 43, 0.86);
  --gun-raised: rgba(38, 44, 54, 0.94);
  --gun-hover: rgba(52, 60, 72, 0.55);

  /* A hairline of light along an edge is the whole trick: it is what reads as a sheet of glass
     rather than a flat panel that happens to be see-through. */
  --edge: rgba(255, 255, 255, 0.07);
  --edge-strong: rgba(255, 255, 255, 0.11);

  /* Text. Lifted from the values a solid dark panel could afford: over a bright frame the glass
     only gets down to about #3c3f43, and anything dimmer than this disappears into it. */
  --text: #e9edf2;
  --dim: #a4afc0;
  --dim-2: #7d8798;

  /* The one lit thing. */
  --steel: #8fa3b8;
  --steel-hot: #c9d6e4;
  --steel-wash: rgba(143, 163, 184, 0.14);
  --steel-edge: rgba(143, 163, 184, 0.3);
  --steel-glow: rgba(143, 163, 184, 0.45);

  /* Exit sign. Removing, signing out, closing a pane — nothing else. */
  --exit: #b8434b;

  --sidebar-width: 220px;
  --rail-width: 56px;
  --peek-width: 8px;
  --radius: 8px;
  --radius-sm: 6px;

  /* A condensed grotesk for the wordmark and section rules — marquee lettering is condensed,
     spaced and set in caps, which is exactly what those two roles want. The body face carries
     everything that is read rather than glanced at, and the mono face every numeral, so counts
     and versions hold their column instead of jittering. */
  --font-display: "Fira Sans Condensed", "Archivo Narrow", "Roboto Condensed",
    "Liberation Sans Narrow", "Segoe UI", system-ui, sans-serif;
  --font-body: Inter, "Adwaita Sans", "Noto Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-mono: "Adwaita Mono", "JetBrains Mono", Hack, "DejaVu Sans Mono", "Liberation Mono",
    Consolas, monospace;

  font-family: var(--font-body);
}
```

- [ ] **Step 2: Rename every old token, mechanically**

Run these in order from the repo root, then read the file to confirm nothing is left:

```bash
sed -i \
  -e 's/var(--bulb-hot)/var(--steel-hot)/g' \
  -e 's/var(--bulb-wash)/var(--steel-wash)/g' \
  -e 's/var(--bulb-edge)/var(--steel-edge)/g' \
  -e 's/var(--bulb-glow)/var(--steel-glow)/g' \
  -e 's/var(--bulb)/var(--steel)/g' \
  -e 's/var(--surface-2)/var(--gun-hover)/g' \
  -e 's/var(--surface)/var(--gun-raised)/g' \
  -e 's/var(--line-soft)/var(--edge)/g' \
  -e 's/var(--line)/var(--edge-strong)/g' \
  -e 's/var(--ink-2)/var(--ink)/g' \
  src/ui/styles.css
grep -n 'bulb\|surface\|line-soft\|ink-2\|217, 193, 136' src/ui/styles.css
```

Expected from the `grep`: only the raw `rgba(217, 193, 136, …)` literals in `.brand`'s `box-shadow`, the `update-pulse` keyframes and the `lights-down` rules. Fix each by hand:

- `.brand` `box-shadow: 0 1px 0 rgba(217, 193, 136, 0.07)` → `box-shadow: 0 1px 0 rgba(143, 163, 184, 0.09)`
- the same literal inside the `body.lights-down #sidebar:hover .brand` group → the same replacement
- `@keyframes update-pulse`: `rgba(217, 193, 136, 0)` → `rgba(143, 163, 184, 0)`, `rgba(217, 193, 136, 0.4)` → `rgba(143, 163, 184, 0.4)`
- `.setting input[type="checkbox"]:checked` `box-shadow: 0 0 8px rgba(217, 193, 136, 0.3)` → `rgba(143, 163, 184, 0.3)`
- `.setting input[type="checkbox"]` `border: 1px solid #39404e` → `border: 1px solid var(--edge-strong)`
- `::-webkit-scrollbar-thumb:hover` `background: #2e3442` → `background: rgba(255, 255, 255, 0.16)`
- `#sidebar` `border-right: 1px solid #04050a` → handled in Step 3

- [ ] **Step 3: Make the page and the sidebar glass**

Replace the `html, body` rule's `background: var(--ink);` with `background: transparent;` and add a comment above it:

```css
/* Transparent, so the picture behind the chrome view shows through. The view's own background is
   cleared in main.js; both halves are needed. */
```

Replace the `#sidebar` background and border:

```css
#sidebar {
  position: fixed;
  top: 0;
  left: 0;
  width: var(--sidebar-width);
  height: 100%;
  background: var(--gun);
  /* The lit edge. This one hairline is what makes it read as a sheet of glass over the picture
     rather than a hole cut in it. */
  border-right: 1px solid var(--edge);
  box-shadow: 1px 0 0 rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  padding: 16px 12px 14px;
  gap: 14px;
  transition: transform 0.22s ease, opacity 0.22s ease;
}
```

Delete the `body.lights-down #sidebar { background: var(--ink); }` and
`body.lights-down #sidebar:hover, … { background: linear-gradient(…); }` rules — the sidebar's
background no longer changes with the lights, only its position (Task 5).

Also delete the `body.settings-window, body.removed-window` rule's `background: linear-gradient(…)`
line and replace it with `background: var(--ink);` — those pages are still separate windows until
Task 6.

- [ ] **Step 4: Update the secondary window background colours**

In `src/main.js`, in `openRemovedWindow()` and `openSettingsWindow()`, change `backgroundColor: '#080a10'` to `backgroundColor: '#0d1015'` in both.

- [ ] **Step 5: Run the app and check it against a bright frame**

Run: `npm start`

Expected:
1. The sidebar is gunmetal grey and the picture is visible through it — not blurred, but clearly behind it. A hairline of light runs down its right edge.
2. The active service's dot and wash are pale blue-steel. Nothing anywhere is gold.
3. Brand marks are still their own colours, dimmed at rest and true when hovered or active.
4. **The bright-frame check:** open YouTube, find a video with a white or very bright scene, and pause on it so the sidebar sits over it. Every service name must still be readable, and the version number and "Removed 0" must still be legible rather than washed out. If they are not, raise `--gun`'s alpha in 0.02 steps until they are, and note the value used.
5. Settings and Removed windows still open and are readable.

- [ ] **Step 6: Commit**

```bash
git add src/ui/styles.css src/main.js
git commit -m "$(cat <<'EOF'
feat: gunmetal glass, lit with steel instead of gold

One cold material rather than two temperatures: the chrome is tinted glass
over the picture and the only lit colour is a pale steel, which leaves the
services' own brand marks as the only colour in the app.

The tint is doing all the contrast work — there is no frost, because
backdrop-filter samples the current rendering context and the video is a
different WebContents — so the text colours are set against the worst case,
a white frame behind the sidebar, and sit lighter than a solid panel would
have needed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The sidebar stows while playing

Replaces dim-to-12%, which still occupied 220px of picture. The sidebar slides out of the window and the chrome shrinks to an 8px strip, freeing the whole left edge; touching the strip brings it back over the video.

**Files:**
- Modify: `src/config.js` (`autoHideSidebar`, reading the old `dimWhilePlaying`)
- Modify: `src/main.js` (`statePayload`, the `set-dim-while-playing` handler)
- Modify: `src/preload.js` (rename the bridge method)
- Modify: `src/ui/index.html` (the hover strip)
- Modify: `src/ui/styles.css` (stow rules replace the lights-down rules)
- Modify: `src/ui/renderer.js` (`renderLights` becomes `renderStow`)
- Modify: `src/ui/settings.html`, `src/ui/settings.js` (the setting's name and wiring)

**Interfaces:**
- Consumes: `window.shell.setChromeRegion` and `chromeRegion()` from Task 3.
- Produces: `state.autoHideSidebar` (boolean), `window.shell.setAutoHideSidebar(on)`, and the `stowed`
  boolean in the renderer which `chromeRegion()` reads.

- [ ] **Step 1: Rename the setting, keeping old configs working**

In `src/config.js`, in `defaultSettings()`, replace the `dimWhilePlaying` entry with:

```js
    // Slide the sidebar out of the window while something is playing, and bring it back on
    // approach. On by default: the chrome floats over the picture now, so getting out of the way
    // is the whole point of it — the one control that undoes it is in Settings.
    autoHideSidebar: true,
```

In `cleanSettings()`, replace the `dimWhilePlaying` entry with:

```js
    // `dimWhilePlaying` is what this was called when the sidebar faded rather than slid away;
    // a config written before the rename still carries the user's choice, so honour it.
    autoHideSidebar:
      s.autoHideSidebar !== undefined ? s.autoHideSidebar !== false : s.dimWhilePlaying !== false,
```

- [ ] **Step 2: Rename it through main.js and the bridge**

In `src/main.js` `statePayload()`, replace `dimWhilePlaying: config.settings.dimWhilePlaying !== false,` with:

```js
    autoHideSidebar: config.settings.autoHideSidebar !== false,
```

Replace the `set-dim-while-playing` handler with:

```js
ipcMain.handle('set-auto-hide-sidebar', (_e, on) => {
  config.settings.autoHideSidebar = on === true;
  persist();
  broadcast();
  return config.settings.autoHideSidebar;
});
```

In `src/preload.js`, replace the `setDimWhilePlaying` entry with:

```js
  // Whether the sidebar slides out of the window while something is playing.
  setAutoHideSidebar: (on) => ipcRenderer.invoke('set-auto-hide-sidebar', on),
```

- [ ] **Step 3: Add the hover strip to the markup**

In `src/ui/index.html`, immediately before `<nav id="sidebar">`, add:

```html
    <!-- What is left on screen while the sidebar is stowed: an 8px strip down the left edge that
         catches the pointer reaching for it, carrying the on-air light so a bare edge still reads
         as "playing" rather than "the app went away". The chrome view is shrunk to exactly this
         width, so everything right of it belongs to the picture. -->
    <div id="edge-strip" class="edge-strip" hidden>
      <span id="edge-onair" class="edge-onair" hidden></span>
    </div>
```

- [ ] **Step 4: Replace the lights-down CSS with stow CSS**

In `src/ui/styles.css`, delete the whole `/* ---- House lights ---- */` section (every rule from
the `#sidebar .services, … { transition: opacity … }` block through the last
`body.menu-open.lights-down #sidebar .brand` rule) and put this in its place:

```css
/* ---- Stowing ---- */
/* While something is playing the chrome is not what anyone is looking at, and it is sitting on
   the picture — so it leaves, rather than merely dimming. The sidebar slides out of the window
   and main.js shrinks the chrome view to the strip below, which hands the whole left edge back to
   the video. Reaching for the strip brings it in again.
   Nothing resizes: the service views keep the bounds they had, so the page being watched never
   reflows. It is a transform and a view width, nothing else. */
body.stowed #sidebar {
  transform: translateX(-100%);
}
body.stowed.peeking #sidebar {
  transform: none;
}

.edge-strip {
  position: fixed;
  top: 0;
  left: 0;
  width: var(--peek-width);
  height: 100%;
  /* Barely there: enough that the edge does not look like a rendering fault, not enough to be a
     stripe down the side of the film. */
  background: linear-gradient(90deg, rgba(143, 163, 184, 0.16), transparent);
}
.edge-strip[hidden] {
  display: none;
}

/* The on-air light survives the stow — it is the smallest thing here and the one worth keeping.
   Without it a bare edge reads as "the app has gone wrong" rather than "it is playing". */
.edge-onair {
  position: absolute;
  top: 14px;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--steel);
  box-shadow: 0 0 7px var(--steel-glow);
  animation: breathe 3.4s ease-in-out infinite;
}
.edge-onair[hidden] {
  display: none;
}
```

In the `@media (prefers-reduced-motion: reduce)` block, replace `.onair { opacity: 1; }` with:

```css
  .onair,
  .edge-onair {
    opacity: 1;
  }
```

- [ ] **Step 5: Drive it from the renderer**

In `src/ui/renderer.js`, add near the other element lookups at the top:

```js
const edgeStripEl = document.getElementById('edge-strip');
const edgeOnairEl = document.getElementById('edge-onair');
```

Add beside the `playing` declaration:

```js
// Whether the sidebar has slid out of the window, and whether the pointer is currently holding it
// back in. Kept out of `state` because they change on hover and on playback, neither of which is a
// reason to re-render the service list — that would cancel an in-progress drag.
let stowed = false;
let peeking = false;
```

Replace `renderLights()` with:

```js
// While something is playing the chrome is sitting on the picture, so it leaves rather than merely
// dimming: the sidebar slides out and main.js shrinks the chrome view to the hover strip, handing
// the whole left edge back to the video. Reaching for the strip brings it back.
function renderStow() {
  const away = playing && state.autoHideSidebar !== false;
  if (away !== stowed) peeking = false; // a fresh stow starts closed, however it was left
  stowed = away;
  onairEl.hidden = !playing;
  edgeStripEl.hidden = !stowed;
  edgeOnairEl.hidden = !stowed || !playing;
  document.body.classList.toggle('stowed', stowed);
  document.body.classList.toggle('peeking', peeking);
  syncChromeRegion();
}
```

Update `chromeRegion()` from Task 3 to account for the stow:

```js
function chromeRegion() {
  if (!menuEl.hidden) return 'full';
  if (stowed && !peeking) return 'peek';
  return state.sidebarCollapsed ? 'rail' : 'sidebar';
}
```

In `applyState()`, replace the `renderLights();` call with `renderStow();`.

In `init()`, replace the playback handler body and add the hover wiring:

```js
  window.shell.onPlayback((on) => {
    playing = on;
    renderStow();
  });

  // Reaching for the strip holds the sidebar in; leaving the sidebar lets it go again. Growing
  // never fires a spurious leave — the pointer is inside the larger bounds — and the shrink only
  // happens once the pointer is already outside, so the two cannot fight.
  edgeStripEl.addEventListener('mouseenter', () => {
    if (!stowed || peeking) return;
    peeking = true;
    renderStow();
  });
  document.getElementById('sidebar').addEventListener('mouseleave', () => {
    if (!stowed || !peeking) return;
    peeking = false;
    renderStow();
  });
```

- [ ] **Step 6: Rename the setting in the settings window**

In `src/ui/settings.html`, replace the Sidebar section's label block with:

```html
        <label class="setting" for="chk-autohide">
          <input type="checkbox" id="chk-autohide" />
          <span class="setting-text">
            <span class="setting-title">Hide the sidebar while playing</span>
            <span class="setting-sub">It slides out of the window during playback and returns when you reach for the left edge</span>
          </span>
        </label>
```

and the section note with:

```html
      <p class="section-note">
        Nothing moves or resizes behind it — only the sidebar leaves, so the page you are watching
        stays exactly where it is.
      </p>
```

In `src/ui/settings.js`, rename the `chk-dim` element lookup to `chk-autohide`, read
`state.autoHideSidebar` instead of `state.dimWhilePlaying`, and call
`window.shell.setAutoHideSidebar(...)` instead of `setDimWhilePlaying(...)`. Read the file first —
match whatever wiring pattern the other checkboxes there use.

- [ ] **Step 7: Run the app and check the stow**

Run: `npm start`

Expected:
1. Play something. The sidebar slides left out of the window within ~200ms. Only an 8px strip with a slowly breathing steel dot remains.
2. The picture behind it is untouched — the video does not resize, jump or reflow when the sidebar leaves or returns.
3. Click on the video at x≈100px (where the sidebar used to be). The click reaches the page — YouTube's own controls there respond.
4. Move the pointer onto the strip. The sidebar slides back in *over* the video. Move away from it; it slides out again.
5. Pause. The sidebar returns and stays.
6. Settings → untick "Hide the sidebar while playing". Play something: the sidebar stays put.
7. A config written before this change with "Dim while playing" unticked comes back with the new setting unticked. Test by putting `"dimWhilePlaying": false` into `~/.config/streamhub/services.json`'s `settings` object with the app closed, deleting `autoHideSidebar` if present, and starting it.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/main.js src/preload.js src/ui/index.html src/ui/styles.css src/ui/renderer.js src/ui/settings.html src/ui/settings.js
git commit -m "$(cat <<'EOF'
feat: the sidebar leaves while you are watching

Dimming to 12% made sense when the sidebar sat beside the picture. Now that
it sits on it, fading is not enough — it still held 220px of the film. So it
slides out of the window instead and the chrome view shrinks to an 8px strip,
which hands the whole left edge back to the video and lets clicks through to
the page. Reaching for the strip brings it back.

The strip keeps the on-air light, or a bare edge reads as the app having gone
wrong rather than as something playing. Configs that unticked the old "Dim
while playing" keep their choice under the new name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Settings and Removed become in-app sheets

They are separate `BrowserWindow`s only because a 220px sidebar left nowhere to put a panel. The chrome can now own the whole window, so that reason is gone.

**Files:**
- Modify: `src/ui/index.html` (two `<aside>` sheets, markup lifted from the two pages)
- Modify: `src/ui/styles.css` (sheet chrome; the `.settings*` / `.removed*` rules stay)
- Modify: `src/ui/renderer.js` (sheet open/close; absorb `settings.js` and `removed.js`)
- Modify: `src/main.js` (delete both window builders, their globals, `uiWebContents`, the menu item)
- Modify: `src/preload.js` (drop the two open-window methods, add `onOpenSheet`)
- Delete: `src/ui/settings.html`, `src/ui/settings.js`, `src/ui/removed.html`, `src/ui/removed.js`

**Interfaces:**
- Consumes: `chromeRegion()` from Task 3, which must return `'full'` while a sheet is open.
- Produces: `openSheet(name)` / `closeSheet()` in the renderer, where `name` is `'settings' | 'removed'`.

- [ ] **Step 1: Read the two pages you are absorbing**

Read `src/ui/settings.html`, `src/ui/settings.js`, `src/ui/removed.html`, `src/ui/removed.js` in full
before writing anything. Both scripts already talk over the same `window.shell` bridge the sidebar
uses, so this is a move, not a rewrite: the element ids, the state wiring and the update-button
logic all carry over unchanged.

- [ ] **Step 2: Add the sheets to `index.html`**

Immediately before `<div id="service-menu" …>`, add:

```html
    <!-- Settings and the removed list used to be windows of their own, because a 220px sidebar had
         nowhere to put a panel and the service view covered everything else. The chrome can own the
         whole window now, so they are sheets over the picture instead. -->
    <div id="scrim" class="scrim" hidden></div>

    <aside id="sheet-settings" class="sheet" hidden aria-label="Settings">
      <header class="sheet-head">
        <h1>Settings</h1>
        <button class="sheet-close" data-close-sheet title="Close (Esc)">×</button>
      </header>
      <div class="sheet-body">
        <!-- everything inside <body class="settings-window"> in the old settings.html, from
             <header class="settings-header"><p> through the last </section>, pasted unchanged -->
      </div>
    </aside>

    <aside id="sheet-removed" class="sheet" hidden aria-label="Removed services">
      <header class="sheet-head">
        <h1>Removed</h1>
        <button class="sheet-close" data-close-sheet title="Close (Esc)">×</button>
      </header>
      <div class="sheet-body">
        <!-- everything inside <body class="removed-window"> in the old removed.html, pasted
             unchanged -->
      </div>
    </aside>
```

Paste the real markup into the two `sheet-body` divs: `settings.html:13-96` (its `<header>`'s `<p>`
plus all five `<section class="settings-section">` blocks) and `removed.html`'s body content.
Drop only the two old `<h1>`s — the sheet header carries the title now. Keep every element id
exactly as it was: `chk-adblock`, `adblock-sub`, `adblock-extra`, `filter-age`,
`btn-refresh-filters`, `chk-theater`, `chk-autohide`, `chk-tray`, `update-title`, `update-sub`,
`btn-update`, and the removed list's own container. The absorbed scripts look every one of them up
by id.

- [ ] **Step 3: Style the sheets**

Add to `src/ui/styles.css`, after the context-menu section:

```css
/* ---- Sheets ---- */
/* Settings and the removed list, over the picture. The scrim is what makes a sheet feel like it is
   in front of the film rather than floating in it, and it is also the click target that dismisses
   one. */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(6, 8, 12, 0.55);
}
.scrim[hidden] {
  display: none;
}

.sheet {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 41;
  display: flex;
  flex-direction: column;
  width: min(460px, 60vw);
  height: 100%;
  background: var(--gun-raised);
  border-left: 1px solid var(--edge);
  box-shadow: -18px 0 40px rgba(0, 0, 0, 0.45);
  animation: sheet-in 0.2s ease;
}
.sheet[hidden] {
  display: none;
}
@keyframes sheet-in {
  from {
    transform: translateX(16px);
    opacity: 0;
  }
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--edge);
}
.sheet-head h1 {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.sheet-close {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--dim);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.sheet-close:hover {
  background: var(--gun-hover);
  color: var(--text);
}

.sheet-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px 24px;
}
```

Then delete the `body.settings-window, body.removed-window` rule and change every
`.removed-window .service…` selector to `#sheet-removed .service…`. Leave the `.settings-section`,
`.setting`, `.setting-*`, `#filter-age`, `#btn-refresh-filters` and `.update-row` rules alone —
they are unchanged.

- [ ] **Step 4: Absorb the two scripts into the renderer**

Append the bodies of `settings.js` and `removed.js` to `src/ui/renderer.js`, wrapped so they render
from the sidebar's own `state` rather than fetching their own. Add above them:

```js
// ---- Sheets ----
//
// Settings and the removed list. They were windows of their own until the chrome could cover the
// whole window; the code inside them is unchanged, it just renders into a panel here and reads the
// state the sidebar already has instead of asking for its own copy.
let openSheetName = null;

function openSheet(name) {
  openSheetName = name;
  document.getElementById('sheet-settings').hidden = name !== 'settings';
  document.getElementById('sheet-removed').hidden = name !== 'removed';
  document.getElementById('scrim').hidden = false;
  document.body.classList.add('sheet-open');
  syncChromeRegion();
  renderSheets();
}

function closeSheet() {
  if (!openSheetName) return;
  openSheetName = null;
  document.getElementById('sheet-settings').hidden = true;
  document.getElementById('sheet-removed').hidden = true;
  document.getElementById('scrim').hidden = true;
  document.body.classList.remove('sheet-open');
  syncChromeRegion();
}
```

`renderSheets()` is the merged render pass: whatever `settings.js` did on state, plus whatever
`removed.js` did. Call it from `applyState()` after `renderStow()`.

Update `chromeRegion()`:

```js
function chromeRegion() {
  if (openSheetName || !menuEl.hidden) return 'full';
  if (stowed && !peeking) return 'peek';
  return state.sidebarCollapsed ? 'rail' : 'sidebar';
}
```

Wire the openers and closers in `init()`:

```js
  document.getElementById('btn-removed').addEventListener('click', () => openSheet('removed'));
  settingsBtn.addEventListener('click', () => openSheet('settings'));
  document.getElementById('scrim').addEventListener('click', closeSheet);
  for (const btn of document.querySelectorAll('[data-close-sheet]')) {
    btn.addEventListener('click', closeSheet);
  }
  window.shell.onOpenSheet((name) => openSheet(name));
```

Extend the existing Escape handler so it closes a sheet as well as the context menu.

Important: the window-level `click` listener that calls `closeServiceMenu` must not close a sheet —
add `e.stopPropagation()` on the sheet elements, the way `menuEl` already does.

- [ ] **Step 5: Delete the two windows from main.js**

Remove `openRemovedWindow()`, `openSettingsWindow()`, the `removedWindow` and `settingsWindow`
globals, the `open-removed-window` / `open-settings-window` IPC handlers, the `removedWindow` close
in `baseWindow.on('closed')`, and the `BrowserWindow` import if nothing else uses it (check first —
`setWindowOpenHandler` popups do not need it).

Reduce `uiWebContents()` to:

```js
// The only thing that renders app state now that settings and the removed list are panels in it.
function uiWebContents() {
  return chromeView && !chromeView.webContents.isDestroyed() ? [chromeView.webContents] : [];
}
```

Change the app menu's Settings item to open the sheet:

```js
          {
            label: 'Settings',
            accelerator: 'CmdOrCtrl+,',
            click: () => {
              if (chromeView && !chromeView.webContents.isDestroyed()) {
                chromeView.webContents.send('open-sheet', 'settings');
              }
            },
          },
```

- [ ] **Step 6: Update the bridge**

In `src/preload.js`, delete `openRemovedWindow` and `openSettingsWindow`, and add:

```js
  // Ctrl+, from the app menu, which cannot reach the renderer any other way.
  onOpenSheet: (cb) => ipcRenderer.on('open-sheet', (_e, name) => cb(name)),
```

- [ ] **Step 7: Delete the old pages**

```bash
git rm src/ui/settings.html src/ui/settings.js src/ui/removed.html src/ui/removed.js
```

- [ ] **Step 8: Run the app and check both sheets**

Run: `npm start`

Expected:
1. The gear opens Settings as a sheet over the video. No new window appears in the taskbar.
2. Every setting still works: toggling the ad blocker reloads services and the filter age line appears; the YouTube theater toggle takes effect on a watch page without a reload; "Check for updates" still runs.
3. "Removed" opens the removed list as a sheet; clicking a service restores it to the sidebar and the sheet's list updates.
4. Escape closes a sheet. So does clicking the scrim, and the × in its header.
5. `Ctrl+,` opens Settings whether focus is in the sidebar or in a service view.
6. With a sheet open, clicking inside it does not dismiss it.
7. Playing something with a sheet open: the sidebar does not stow out from under the sheet.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: settings and the removed list become sheets, not windows

They were separate windows for one reason: a 220px sidebar had nowhere to put
a panel, and the service view covered everything else in the window. The
chrome can cover the whole window now, so that reason is gone — both are
panels over the picture, dismissed with Escape, and neither puts a second
entry in the taskbar.

The code inside them is unchanged; it already spoke over the same bridge the
sidebar uses. It just renders here and reads the state the sidebar already
has instead of fetching its own copy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Ctrl+K quick-switch palette

With the sidebar hidden most of the time, this is how you change service without going to fetch it.

**Files:**
- Modify: `src/views.js` (`ensureView`: forward the chord out of a service view)
- Modify: `src/main.js` (`onCommandPalette` wiring)
- Modify: `src/preload.js` (`onOpenPalette`)
- Modify: `src/ui/index.html`, `src/ui/styles.css`, `src/ui/renderer.js`

**Interfaces:**
- Consumes: `openSheet`/`closeSheet` and `chromeRegion()` from Task 6.
- Produces: `viewManager.onCommandPalette` — a no-arg callback main.js sets.

- [ ] **Step 1: Forward the chord out of service views**

In `src/views.js`, add to the constructor beside the other callbacks:

```js
    this.onCommandPalette = () => {}; // Ctrl+K pressed inside a service view; main.js opens ours
```

In `ensureView()`, after the `will-frame-navigate` handler, add:

```js
    // A keystroke inside a service view never reaches our own renderer — the page has it. Ctrl+K
    // is the one chord we take back, because the whole point of it is to work from wherever you
    // are, and by then the sidebar is usually stowed.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
      if ((input.key || '').toLowerCase() !== 'k') return;
      event.preventDefault();
      this.onCommandPalette();
    });
```

- [ ] **Step 2: Wire it in main.js**

In `createWindow()`, beside the other `viewManager.on…` assignments:

```js
  viewManager.onCommandPalette = () => {
    if (chromeView && !chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send('open-palette');
    }
  };
```

In `src/preload.js`, add:

```js
  // Ctrl+K pressed inside a service view, forwarded by the main process.
  onOpenPalette: (cb) => ipcRenderer.on('open-palette', () => cb()),
```

- [ ] **Step 3: Add the palette markup**

In `src/ui/index.html`, before `<div id="scrim" …>`, add:

```html
    <!-- Quick switch. With the sidebar stowed most of the time, this is how a service is reached
         without going to fetch the sidebar first: type a few letters, Enter switches, Shift+Enter
         tiles it as another grid pane. -->
    <div id="palette" class="palette" hidden role="dialog" aria-label="Quick switch">
      <input
        id="palette-input"
        class="palette-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Switch to…"
      />
      <ul id="palette-list" class="palette-list"></ul>
      <p class="palette-hint">
        <span>Enter — switch</span><span>Shift+Enter — add a pane</span><span>Esc — close</span>
      </p>
    </div>
```

- [ ] **Step 4: Style it**

Add to `src/ui/styles.css`:

```css
/* ---- Quick switch ---- */
.palette {
  position: fixed;
  z-index: 45;
  top: 16vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(420px, 76vw);
  padding: 6px;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius);
  background: var(--gun-raised);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}
.palette[hidden] {
  display: none;
}

.palette-input {
  width: 100%;
  padding: 11px 12px;
  border: none;
  border-bottom: 1px solid var(--edge);
  background: transparent;
  color: var(--text);
  font-family: var(--font-body);
  font-size: 14px;
  outline: none;
}
.palette-input::placeholder {
  color: var(--dim-2);
}

.palette-list {
  list-style: none;
  max-height: 46vh;
  overflow-y: auto;
  margin: 4px 0;
}
.palette-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--dim);
  font-size: 13.5px;
  cursor: pointer;
}
.palette-list li.on {
  background: var(--steel-wash);
  color: var(--text);
}
.palette-list li .icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}

.palette-hint {
  display: flex;
  gap: 14px;
  padding: 7px 10px 4px;
  border-top: 1px solid var(--edge);
  font-size: 10.5px;
  color: var(--dim-2);
}
```

- [ ] **Step 5: Implement it in the renderer**

Add to `src/ui/renderer.js`:

```js
// ---- Quick switch ----
//
// Substring match on the service name, in list order — with a dozen services there is nothing for
// fuzzy matching to earn, and "net" landing on Netflix rather than on whatever scores highest is
// the behaviour someone typing three letters fast is expecting.
let paletteOpen = false;
let paletteIndex = 0;

function paletteMatches() {
  const q = document.getElementById('palette-input').value.trim().toLowerCase();
  if (!q) return state.services;
  return state.services.filter((s) => s.name.toLowerCase().includes(q));
}

function renderPalette() {
  const listNode = document.getElementById('palette-list');
  const matches = paletteMatches();
  if (paletteIndex >= matches.length) paletteIndex = Math.max(0, matches.length - 1);
  listNode.replaceChildren();
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
    li.addEventListener('click', () => choosePalette(svc, false));
    listEl2.appendChild(li);
  });
}

function openPalette() {
  paletteOpen = true;
  paletteIndex = 0;
  const input = document.getElementById('palette-input');
  input.value = '';
  document.getElementById('palette').hidden = false;
  document.getElementById('scrim').hidden = false;
  syncChromeRegion();
  renderPalette();
  input.focus();
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  document.getElementById('palette').hidden = true;
  if (!openSheetName) document.getElementById('scrim').hidden = true;
  syncChromeRegion();
}

// Enter switches; Shift+Enter tiles it as another grid pane, which is the only other thing anyone
// wants a service for from here.
function choosePalette(svc, asPane) {
  if (!svc) return;
  closePalette();
  if (asPane) window.shell.addGridPane(svc.id);
  else window.shell.switchService(svc.id);
}
```

Update `chromeRegion()` again:

```js
function chromeRegion() {
  if (paletteOpen || openSheetName || !menuEl.hidden) return 'full';
  if (stowed && !peeking) return 'peek';
  return state.sidebarCollapsed ? 'rail' : 'sidebar';
}
```

Wire it in `init()`:

```js
  window.shell.onOpenPalette(() => openPalette());
  document.getElementById('palette-input').addEventListener('input', () => {
    paletteIndex = 0;
    renderPalette();
  });
  document.getElementById('palette').addEventListener('click', (e) => e.stopPropagation());
```

Extend the existing `keydown` handler:

```js
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (paletteOpen) closePalette();
    else if (openSheetName) closeSheet();
    else closeServiceMenu();
    return;
  }
  // Ctrl+K from inside our own chrome; the same chord pressed in a service view arrives over IPC.
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'k') {
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
```

Make the scrim's click handler close the palette too.

- [ ] **Step 6: Run the app and check it**

Run: `npm start`

Expected:
1. `Ctrl+K` with focus in the sidebar opens the palette, focused, listing every service.
2. Play a video so the sidebar stows, click into the video, then press `Ctrl+K`. It still opens — the chord is being taken back from the page.
3. Type `net`. The list narrows to Netflix. Enter switches to it and the palette closes.
4. Arrow keys move the highlight; Escape closes without switching.
5. In grid mode, Shift+Enter adds the highlighted service as another pane.
6. `Ctrl+K` on a YouTube watch page does not reach YouTube's own shortcut handling.

- [ ] **Step 7: Commit**

```bash
git add src/views.js src/main.js src/preload.js src/ui/index.html src/ui/styles.css src/ui/renderer.js
git commit -m "$(cat <<'EOF'
feat: Ctrl+K to switch service without fetching the sidebar

The sidebar is stowed most of the time now, so reaching a service meant going
to get the sidebar first. Type a few letters instead; Shift+Enter tiles it as
a grid pane.

A keystroke inside a service view belongs to the page, so main.js takes this
one chord back with before-input-event and forwards it — the whole point of a
quick switch is that it works from wherever you are.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Grid controls move to their own HUD

The preview, layout picker and hint line currently squeeze the service list inside 220px. They get their own small transparent view, parked top-centre — away from every player's bottom control bar — which exists only while grid mode is on.

**Files:**
- Create: `src/ui/hud.html`, `src/ui/hud.js`
- Modify: `src/main.js` (create/destroy the HUD view, size it, broadcast state to it)
- Modify: `src/preload.js` (`setHudExpanded`)
- Modify: `src/ui/index.html`, `src/ui/renderer.js` (remove the grid panel)
- Modify: `src/ui/styles.css` (HUD rules; the `.grid-*` rules move rather than change)

**Interfaces:**
- Consumes: the existing `addGridPane` / `removeGridPane` / `reorderGridPanes` / `setGridLayout`
  bridge methods, and `onState`.
- Produces: `window.shell.setHudExpanded(on)`.

- [ ] **Step 1: Build the HUD page**

Create `src/ui/hud.html` with the same CSP as `index.html`, `<body class="hud-window">`, and the
grid panel markup lifted verbatim from `index.html:29-46` (`#grid-preview`, `#grid-layout`,
`#grid-hint`) wrapped in:

```html
    <div id="hud" class="hud">
      <div id="hud-nub" class="hud-nub" aria-hidden="true"></div>
      <div id="hud-body" class="hud-body">
        <!-- #grid-preview, #grid-layout and #grid-hint, exactly as they were in index.html -->
      </div>
    </div>
```

Create `src/ui/hud.js` by moving `renderGridPreview()`, `tileRows()`, `afterTile()`, the
`gridPreviewEl` dragover handler and the layout-picker click handler out of `renderer.js`
unchanged. `initial()` is **copied**, not moved — `renderer.js` still needs it for the service rows
and the palette. Plus:

```js
// The HUD is a view of its own, only as big as it is drawn — a bigger one would swallow clicks
// meant for the picture. So it asks the main process to grow it before it expands and to shrink it
// again after it collapses, the same bargain the sidebar's hover strip makes.
document.getElementById('hud-nub').addEventListener('mouseenter', () => {
  window.shell.setHudExpanded(true);
  document.body.classList.add('expanded');
});
document.getElementById('hud').addEventListener('mouseleave', () => {
  document.body.classList.remove('expanded');
  window.shell.setHudExpanded(false);
});
```

with an `init()` that calls `window.shell.getConfig()` and subscribes to `onState`, exactly the way
`renderer.js` does.

- [ ] **Step 2: Create and size the HUD view in main.js**

Add beside the other view globals:

```js
let hudView = null;
let hudExpanded = false;

// The grid HUD, parked top-centre: the one band of a video player that is never controls. It is a
// view of its own rather than part of the chrome because the chrome is a strip down the left edge,
// and a view is only allowed to be as big as the part of it meant to catch clicks — so it is a nub
// until the pointer arrives on it.
const HUD_NUB = { width: 48, height: 10 };
const HUD_OPEN = { width: 380, height: 104 };

function hudBounds() {
  const { width } = baseWindow.getContentBounds();
  const size = hudExpanded ? HUD_OPEN : HUD_NUB;
  return {
    x: Math.round((width - size.width) / 2),
    y: 0,
    width: size.width,
    height: size.height,
  };
}

function showHud(on) {
  if (on && !hudView) {
    hudView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    hudView.setBackgroundColor('#00000000');
    baseWindow.contentView.addChildView(hudView);
    hudView.webContents.loadFile(path.join(__dirname, 'ui', 'hud.html'));
    hudView.setBounds(hudBounds());
    return;
  }
  if (!on && hudView) {
    baseWindow.contentView.removeChildView(hudView);
    hudView.webContents.close();
    hudView = null;
    hudExpanded = false;
  }
}
```

Call `showHud(gridMode)` from `setGridMode()`, and re-apply `hudView.setBounds(hudBounds())` inside
`layout()` when `hudView` exists. Include `hudView.webContents` in `uiWebContents()` so it receives
state. Raise it in `onStackChange` alongside the chrome, and hide it with the chrome in
`onFullscreenChange`.

Add the IPC:

```js
ipcMain.on('set-hud-expanded', (_e, on) => {
  hudExpanded = on === true;
  if (hudView) hudView.setBounds(hudBounds());
});
```

In `src/preload.js`:

```js
  // The grid HUD is only as big as it is drawn, so it asks to be grown before it expands.
  setHudExpanded: (on) => ipcRenderer.send('set-hud-expanded', on),
```

- [ ] **Step 3: Take the grid panel out of the sidebar**

Delete the `<section id="grid-panel">` block from `src/ui/index.html`, and from `renderer.js` delete
`gridPanelEl`, `gridLayoutEl`, `gridPreviewEl`, `renderGridPreview()`, `tileRows()`, `afterTile()`,
the preview dragover listener and the layout-picker listener (they now live in `hud.js`). Keep
`panesFor()` and the numbered badges on the service rows — those are how a row says which panes it
holds, and they stay.

In `renderGridToggle()`, drop the `#grid-hint` and `gridLayoutEl` handling; keep the button's
pressed state and the `grid-mode` / `grid-full` body classes.

Delete the `body.collapsed .grid-panel` rule from `styles.css` and move the `.grid-panel`,
`.grid-preview`, `.pane-tile*`, `.pane-close`, `.grid-layout` and `.grid-hint` rules into a
`hud`-scoped section, adding:

```css
/* ---- Grid HUD ---- */
.hud-window {
  background: transparent;
}
.hud {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.hud-nub {
  width: 48px;
  height: 6px;
  border-radius: 0 0 4px 4px;
  background: rgba(143, 163, 184, 0.28);
}
.hud-body {
  display: none;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--edge-strong);
  border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--gun-raised);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
}
body.expanded .hud-body {
  display: block;
}
body.expanded .hud-nub {
  width: 100%;
  border-radius: 0;
  background: transparent;
}
```

- [ ] **Step 4: Run the app and check the HUD**

Run: `npm start`

Expected:
1. Turn grid mode on with two services. A small steel nub appears at the top centre of the window.
2. The sidebar's service list now runs the full height — no preview, picker or hint line inside it.
3. Hover the nub. The HUD drops down showing the panes as they are tiled, the three arrangement buttons and the hint line.
4. Drag a tile in the HUD. The pane moves and keeps playing — nothing reloads.
5. Click an arrangement button. The panes re-tile; the button lights.
6. Close a pane from a tile's ×. It goes; the HUD and the sidebar badges both update.
7. Move the pointer off the HUD. It collapses back to the nub, and clicking where it *was* reaches the video underneath.
8. Turn grid mode off. The nub disappears entirely.
9. Resize the window. The nub stays centred.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: give the grid its own HUD instead of the sidebar's middle

The preview, the arrangement picker and the hint line were three things
crammed into a 220px rail, and the service list paid for all of them. They
get their own small view parked top-centre — the one band of a video player
that is never controls — which exists only while grid mode is on and is a nub
until you reach for it.

Like the sidebar's hover strip, it is only ever as big as it is drawn: a view
swallows clicks across its whole rect, so it asks the main process to grow it
before it expands.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update the README

The README describes behaviour that no longer exists — a sidebar that dims, settings in a window, theater mode that leaves the description peeking in.

**Files:**
- Modify: `README.md:38-58` (the Features list)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite the affected bullets**

In the Features list, replace the "Pause on switch", "Grid view", "Full-window theater mode" and
"Settings" bullets, and add one for the glass chrome:

```markdown
- **Glass chrome** — the sidebar floats over the picture as tinted gunmetal rather than sitting
  beside it, and slides out of the way entirely while something is playing. Reach for the left edge
  and it comes back. Turn it off in Settings for an opaque sidebar docked beside the video.
- **Quick switch** — `Ctrl+K`, type a few letters, Enter. Shift+Enter tiles it as another grid pane.
- **Grid view** — tile up to four services at once, the same one more than once if you like (two
  streams side by side). The controls live in a HUD at the top of the window; drag a tile to move a
  pane, and it keeps playing where it lands. Choose packed, stacked or side-by-side.
- **Full-window theater mode on YouTube** — the player takes the window to itself, the video
  centred in it, and the top bar hides until you reach for it. Scroll down as usual for the
  description and comments. On by default; the switch is in Settings.
- **Settings** (sidebar gear, or `Ctrl+,`) — a panel over the picture rather than a second window:
  ad blocker, YouTube theater mode, glass, tray behaviour, updates.
```

Keep every other bullet as it is.

- [ ] **Step 2: Check it reads true**

Read the whole Features section back against the running app. Every claim must be something you
have actually seen work in Tasks 2–8. Fix anything that has drifted.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: describe the chrome as it now behaves

The README still described a sidebar that dims, settings in a window of their
own and a theater mode that leaves the description peeking in underneath.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After Task 9, run the app once more and walk the spec's verification list end to end:

- [ ] A bright frame behind the sidebar — every label still readable.
- [ ] Playback: sidebar stows, strip catches the pointer, sidebar returns, and the page being watched never reflows.
- [ ] Grid mode with 2, 3 and 4 panes in all three arrangements; drag-to-move still moves a pane without reloading it.
- [ ] HTML fullscreen: the site owns the whole window, chrome and HUD included.
- [ ] A service right-click menu drawing fully over the video rather than being clipped.
- [ ] `glassSidebar` off: the docked opaque layout still works, and the sidebar does not stow.
- [ ] Sign-in popups still open and complete (they run through `setWindowOpenHandler`, untouched, but the stacking changed underneath them).
- [ ] Media keys, MPRIS and the tray still work.
