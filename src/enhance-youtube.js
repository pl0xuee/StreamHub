// The YouTube half of the enhancements (see enhance.js for the settings shape).
//
// This module runs in the main process but exports no behaviour of its own: what it produces is
// the *source* of a controller that views.js injects into a YouTube view, the same way the
// play/pause and pause-all snippets in that file work. It is delivered as an injection rather
// than from the service preload because a preload cannot `require` a local module — service
// views are sandboxed, which is worth keeping for pages we do not control — and this is too much
// code to inline into the preload's own job.
//
// Everything the controller does is reversible at runtime: unticking the setting removes the
// stylesheet and the class and puts the page back exactly as YouTube laid it out, no reload.

const STYLE_ID = 'streamhub-enhance';
const PEEK_ID = 'streamhub-peek';
const ROOT_CLASS = 'sh-theater'; // on <html> while a watch page should be enlarged
const PEEK_CLASS = 'sh-peek'; // …and while the pointer is holding the masthead open

// Scoped entirely under html.sh-theater, which only goes on for a watch page, so the home, search
// and channel pages are left alone. !important throughout: YouTube sets these same properties
// from its own layout code, sometimes inline, and this has to win without us having to find and
// fight each write.
const CSS = `
/* The masthead slides out of the way and comes back when the pointer reaches the top edge.
   #${PEEK_ID} is the strip that catches that; the masthead's own :hover is what keeps it down
   once it has arrived, so moving onto it does not make it flee again. :focus-within covers
   reaching the search box by keyboard, which would otherwise type into something invisible. */
html.${ROOT_CLASS} #masthead-container {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  transform: translateY(-100%);
  transition: transform 160ms ease;
  z-index: 2200 !important;
}
html.${ROOT_CLASS}.${PEEK_CLASS} #masthead-container,
html.${ROOT_CLASS} #masthead-container:hover,
html.${ROOT_CLASS} #masthead-container:focus-within {
  transform: none;
}
html.${ROOT_CLASS} #${PEEK_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  z-index: 2201;
}

/* YouTube offsets the whole page down by the masthead's height. With the masthead hidden that
   band is just a gap above the player, so take it back. */
html.${ROOT_CLASS} ytd-page-manager#page-manager {
  margin-top: 0 !important;
}

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
`;

// The controller, as source to be injected into a YouTube view.
//
// Idempotent by design: it parks itself on window.__streamhubEnhance, so re-running this — which
// happens on every document load and every time the setting changes — reconfigures the controller
// already there instead of stacking up a second set of listeners.
function controllerJs(settings) {
  const cfg = JSON.stringify({
    css: CSS,
    styleId: STYLE_ID,
    peekId: PEEK_ID,
    rootClass: ROOT_CLASS,
    peekClass: PEEK_CLASS,
  });
  const wanted = JSON.stringify(settings || {});

  return `(() => {
  const SETTINGS = ${wanted};
  if (window.__streamhubEnhance) {
    window.__streamhubEnhance.apply(SETTINGS);
    return 'reconfigured';
  }
  const CFG = ${cfg};

  let active = false;      // whether the feature is currently installed
  let theaterTimer = null; // the bounded poll waiting for the player to appear

  const root = () => document.documentElement;

  // A watch page is the only place any of this means anything.
  const isWatchPage = () => window.location.pathname === '/watch';

  // YouTube's player measures its container once and then sizes the <video> itself, recomputing
  // on window resize — not on our stylesheet landing. Without this nudge the video keeps its old
  // size inside the now-taller container until something else resizes the window.
  const nudgePlayer = () => window.dispatchEvent(new Event('resize'));

  function ensureStyle() {
    if (document.getElementById(CFG.styleId)) return;
    const style = document.createElement('style');
    style.id = CFG.styleId;
    style.textContent = CFG.css;
    (document.head || root()).appendChild(style);
  }

  // Held open from the moment the strip is entered, and released only once the pointer leaves the
  // masthead itself — the masthead spans the full width directly below the strip, so travelling
  // down onto it never crosses a gap where it would snap shut mid-reach.
  function ensurePeek() {
    if (!document.body || document.getElementById(CFG.peekId)) return;
    const peek = document.createElement('div');
    peek.id = CFG.peekId;
    peek.addEventListener('mouseenter', () => root().classList.add(CFG.peekClass));
    document.body.appendChild(peek);
  }

  // YouTube's theater mode is what we are enlarging, so it has to be on, and the only way to set
  // it is the button the player draws — which does not exist yet when a watch page first opens.
  function enterTheater() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return false;
    if (flexy.hasAttribute('theater')) return true; // already there, by our doing or the user's
    const button = document.querySelector('.ytp-size-button');
    if (!button) return false;
    button.click();
    return true;
  }

  function stopTheaterPoll() {
    if (theaterTimer === null) return;
    clearInterval(theaterTimer);
    theaterTimer = null;
  }

  // Poll briefly for the player, then give up: a watch page that has not produced one within a
  // few seconds is not going to.
  //
  // This re-runs per navigation rather than once ever. Leaving theater mode on one video reads as
  // a decision about that video and is honoured until the next one; switching the whole thing off
  // for good is the settings checkbox, not the player button.
  function startTheaterPoll() {
    stopTheaterPoll();
    let tries = 0;
    theaterTimer = setInterval(() => {
      tries += 1;
      if (enterTheater() || tries > 20) {
        stopTheaterPoll();
        nudgePlayer();
      }
    }, 250);
  }

  // Put the page into (or out of) the enlarged state for wherever YouTube has just navigated to.
  function sync() {
    const on = active && isWatchPage();
    root().classList.toggle(CFG.rootClass, on);
    if (!on) {
      stopTheaterPoll();
      root().classList.remove(CFG.peekClass);
      return;
    }
    ensurePeek();
    startTheaterPoll();
    nudgePlayer();
  }

  // YouTube is a single-page app: the URL changes without a document load, so its own navigation
  // event is what tells us a new video has arrived. popstate covers the back/forward buttons,
  // which do not always produce one.
  const onNavigate = () => sync();

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  // Toggling off leaves YouTube's own theater mode exactly as it stands — that is the site's
  // setting, not ours to reach in and undo.
  function apply(next) {
    const want = Boolean(next && next.theater);
    if (want === active) return;
    active = want;

    if (!active) {
      stopTheaterPoll();
      root().classList.remove(CFG.rootClass, CFG.peekClass);
      const style = document.getElementById(CFG.styleId);
      if (style) style.remove();
      const peek = document.getElementById(CFG.peekId);
      if (peek) peek.remove();
      document.removeEventListener('yt-navigate-finish', onNavigate);
      window.removeEventListener('popstate', onNavigate);
      nudgePlayer(); // let the player claim back the size it had before
      return;
    }

    ensureStyle();
    document.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);
    whenReady(sync);
  }

  // Bound once for the life of the document rather than per install: it only ever removes a
  // class, so leaving it attached while the feature is off costs nothing and saves having to
  // unpick it. mouseleave does not bubble, hence the capture phase.
  document.addEventListener(
    'mouseleave',
    (e) => {
      if (e.target && e.target.id === 'masthead-container') {
        root().classList.remove(CFG.peekClass);
      }
    },
    true,
  );

  window.__streamhubEnhance = { apply };
  apply(SETTINGS);
  return 'installed';
})()`;
}

module.exports = { controllerJs };
