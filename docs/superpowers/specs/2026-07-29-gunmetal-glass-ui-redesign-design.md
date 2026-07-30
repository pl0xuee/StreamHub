# Gunmetal glass — UI redesign

Date: 2026-07-29
Status: approved, ready to plan

## Goal

Replace the "theater dark" chrome with a **translucent gunmetal grey** interface whose sidebar
floats *over* the video rather than sitting beside it, and rework the UX around that so nothing
covers the picture unless the user reaches for it.

Two decisions were taken up front and are settled:

- **Transparency means glass over the video**, not a transparent window over the desktop. The
  service view fills the window; the chrome floats on top of it.
- **The accent is cool steel**, not the current warm gold. One cold material throughout; the only
  colour in the app comes from the services' own brand marks and the exit-red.

## Current architecture, and what changes

`src/main.js` builds a `BaseWindow` holding `WebContentsView`s:

- `chromeView` — the sidebar UI (`src/ui/index.html`), currently sized to the **full window**
  (`layout()`, main.js:128) and sitting **underneath** the service views.
- Service views — one per pane, laid out by `ViewManager.layout()` (views.js:429) starting at
  `x = sidebarWidth`, so they cover everything right of the sidebar. Because they are added to
  `contentView` after the chrome, they stack above it.

The visible sidebar today is therefore just the uncovered left strip of a full-window chrome view.

The redesign inverts the stacking:

- Service views are laid out from `x: 0` at **full window width**. The video runs behind the
  sidebar.
- `chromeView` gets a transparent background (`setBackgroundColor('#00000000')`, plus a transparent
  `body` in CSS) and is **raised above** the service views.

### The constraint that drives everything else

A native view captures mouse events across its **whole rect**, regardless of what CSS does with
transparency. A full-window transparent `chromeView` on top would swallow every click on the video.

So `chromeView` is sized to exactly the region the chrome needs at that moment. This is the core new
mechanism, and four separate features below are built on it.

| chrome state                                  | `chromeView` bounds        |
| --------------------------------------------- | -------------------------- |
| stowed (playing, sidebar hidden)               | `8 × height` hover strip   |
| collapsed rail                                 | `56 × height`              |
| sidebar open                                   | `220 × height`             |
| sheet / palette / context menu open            | full window                |

The renderer requests changes over a new IPC channel; main.js is the only thing that sets bounds.

### Ordering

`ViewManager.setVisibleSet()` calls `this.win.contentView.addChildView(v)` to raise a service view
to the top of the stack. Every path that does this must re-raise `chromeView` afterwards, or the
sidebar disappears behind the video. A single `raiseChrome()` callback on `ViewManager`, invoked at
the end of `setVisibleSet()` and `setVideoFullscreen()`, keeps that in one place.

HTML fullscreen is the deliberate exception: a site in fullscreen owns the window and the chrome
must stay under it, exactly as today.

## Known limits — stated, not worked around

**No frosted blur.** `backdrop-filter` samples the backdrop within the same rendering context. The
video lives in a different `WebContents` entirely, so Chromium has nothing to sample and the filter
is a no-op. The result is *tinted glass* — the picture shows through sharply, dimmed and
colour-shifted by the gunmetal — not a blurred frost. The only way to get true frost would be to
screen-capture the video and blur the capture, which is out of scope. Do not ship a
`backdrop-filter` rule that silently does nothing.

**Compositing is unverified.** Transparent-view-over-view has not been confirmed on Wayland/KDE with
castLabs ECS 43. Phase 1 is a spike that proves it before anything is built on top.

**Fallback.** A `glassSidebar` setting (default on) selects between the glass overlay and today's
docked opaque sidebar with the service views inset at `x = sidebarWidth`. It is both the escape
hatch if a compositor misbehaves and a genuine preference for users who want nothing over the
picture. It is one branch in `ViewManager.layout()` and one class on `<body>` — it must not fork the
stylesheet.

## Material and colour

One cold material, one accent, one alarm colour.

```
--ink         #0d1015                    window background; shows through grid gutters
--gun         rgba(30, 35, 43, 0.86)     sidebar glass
--gun-raised  rgba(38, 44, 54, 0.94)     menus, sheets, palette
--gun-hover   rgba(52, 60, 72, 0.55)
--edge        rgba(255, 255, 255, 0.07)  1px right edge — what reads as a pane of glass
--steel       #8fa3b8                    active / hover / focus
--steel-hot   #c9d6e4                    text on a lit surface
--steel-wash  rgba(143, 163, 184, 0.14)
--steel-edge  rgba(143, 163, 184, 0.30)
--exit        #b8434b                    removing, signing out, closing a pane — nothing else
--text        #e9edf2
--dim         #a4afc0
--dim-2       #7d8798
```

Contrast is set by the worst case, which is a white frame behind the sidebar. At `0.86` alpha
gunmetal over white resolves to roughly `#3c3f43`: body text lands near 11:1 and secondary text near
4.4:1. This is why `--dim` is lifted from the current `#7d8698`, which disappeared into that
background.

The warm gold (`--bulb*`) is removed entirely. Brand marks keep their inline colours and their
brightness-filter treatment (dimmed at rest, true colour when lit) — desaturating them still turns
them milky, so that stays a `filter`, never an overlay.

The type stack is unchanged: condensed display for the wordmark and section rules, body face for
prose, tabular mono for every numeral.

## UX changes

### Sidebar stows while playing

Replaces the current dim-to-12%, which still occupied 220px of picture. On playback the sidebar
slides out (`translateX(-100%)`) and `chromeView` shrinks to the 8px strip, freeing the entire left
edge of the video. Entering the strip slides it back over the video; leaving the sidebar stows it
again.

The on-air dot stays drawn on the strip, so a bare left edge still reads as "playing" rather than
"the app went away" — the same job it does today under `lights-down`.

Hysteresis: the expand is triggered by `mouseenter` on the strip, the stow by `mouseleave` on the
sidebar. Growing never fires a spurious leave (the pointer is inside the new, larger bounds);
shrinking only happens once the pointer is already outside. A pointer that jumps from the video
straight into where the expanded sidebar *would* be, without crossing the strip, does not expand it
— accepted.

Setting renamed *Dim while playing* → *Hide sidebar while playing*. Config reads
`autoHideSidebar ?? dimWhilePlaying ?? true` so existing configs carry over without a migration
step.

### Settings and Removed become in-app sheets

Both are separate `BrowserWindow`s today purely because a 220px sidebar left nowhere to put a panel.
That reason is gone: `chromeView` expands to the full window and a gunmetal sheet slides in over the
video, dismissed with Escape or a click outside.

`settings.js` and `removed.js` already talk over the same `window.shell` bridge that the sidebar
uses, so this is a move rather than a rewrite. `settings.html`, `removed.html`, `openSettingsWindow`,
`openRemovedWindow` and the `settingsWindow`/`removedWindow` globals are deleted; `uiWebContents()`
collapses to the chrome view alone.

### Ctrl+K quick-switch

An overlay palette: type a few letters, Enter switches to that service; Shift+Enter adds it as a
grid pane. This is what makes a hidden sidebar cost nothing.

Keystrokes inside a service view never reach our renderer, so main.js hooks `before-input-event` on
each service `webContents` and forwards the chord to the chrome view. The palette opens with
`chromeView` full-window and closes back to whatever region the sidebar was using.

### Grid controls leave the sidebar

The grid preview, layout picker and hint line currently squeeze the service list inside 220px. They
move to their own small transparent `WebContentsView` — a HUD parked top-centre, away from every
player's bottom control bar — which exists only while grid mode is on.

It stows to a 48×8 nub and expands to roughly 360×92 on hover, using the same
renderer-asks/main-resizes mechanism as the sidebar strip. Drag-to-move-a-pane and click-to-close
behave exactly as they do in the sidebar today; only the location changes.

### YouTube theater mode fills the window

`enhance-youtube.js` caps `#full-bleed-container` at `height: min(100vh, 56.25vw)`. On a landscape
window that resolves to the 16:9 height for the available width, leaving a band of title and
description visible underneath — which is exactly the complaint.

Changing it to a flat `height: 100vh` (with `max-height: 100vh`) makes the player own the window;
YouTube then centres the video inside it with letterbox bars top and bottom. The video is the only
thing on screen, vertically centred, with the description one scroll away as before. The masthead
auto-hide and peek strip are unchanged.

## Files affected

| File | Change |
| --- | --- |
| `src/main.js` | chrome-region manager + IPC; raise chrome above service views; window background; `before-input-event` forwarding; grid HUD view; delete the two secondary windows |
| `src/views.js` | lay out service views from `x: 0` full width (glass) or inset (fallback); `raiseChrome()` hook |
| `src/ui/styles.css` | full rewrite to the gunmetal system; stow/sheet/palette states |
| `src/ui/index.html` | sheets, palette, hover strip |
| `src/ui/renderer.js` | region requests, stow logic, sheet + palette controllers |
| `src/ui/hud.html`, `src/ui/hud.js` | new — grid HUD |
| `src/ui/settings.html`, `settings.js`, `removed.html`, `removed.js` | folded into the main renderer; standalone pages deleted |
| `src/preload.js` | new bridge methods for region/palette/HUD |
| `src/enhance-youtube.js` | theater height fix |
| `src/config.js` | `glassSidebar`, `autoHideSidebar` (reading the old `dimWhilePlaying`) |
| `README.md` | feature descriptions for the new behaviour |

## Phases

Each phase is independently runnable and checkable.

1. **Spike.** Prove a transparent `WebContentsView` composites over another on this Wayland/KDE
   session with castLabs ECS 43. Everything downstream depends on it; if it fails, the design
   changes rather than the fallback quietly shipping.
2. **Glass, gunmetal, stow.** Chrome-region manager, full-width service views, new stylesheet,
   sidebar stow, YouTube theater fix, `glassSidebar` fallback. This phase alone satisfies the
   original request.
3. **In-app sheets.** Settings and Removed fold in; the two secondary windows are deleted.
4. **Palette and grid HUD.**

## Verification

The repo has no test suite, so verification is running the real app per phase (`npm start` — note
`node_modules` is currently absent and `npm install` pulls the castLabs ECS binary).

Each phase must be checked against:

- A bright frame behind the sidebar — the case the glass has to survive, and the one that decides
  whether `--dim` is readable.
- Playback: sidebar stows, strip catches the pointer, sidebar returns, nothing reflows the page
  being watched.
- Grid mode with 2, 3 and 4 panes in all three arrangements; drag-to-move still moves a pane
  without reloading it.
- HTML fullscreen: the site still owns the whole window, chrome included.
- A service context menu opening over the video rather than being clipped by the sidebar's width —
  which is a bug in the current build and should be fixed by the full-window region.
- `glassSidebar` off: the docked opaque layout still works.
