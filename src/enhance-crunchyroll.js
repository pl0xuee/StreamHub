// The Crunchyroll half of the enhancements (see enhance.js for the settings shape).
//
// Delivered the same way as the YouTube and Twitch controllers — as the *source* of a controller
// that views.js injects into the view — and for the same reason: service views are sandboxed, and a
// sandboxed preload cannot `require` a local module.
//
// Crunchyroll has no theater mode of its own to switch on, so this is closer to YouTube's than to
// Twitch's: a stylesheet scoped under a class on <html>, put on only while a watch page is showing.
// The player itself is a cross-origin iframe (Crunchyroll's "vilos" player) that we neither can nor
// want to touch; all we change is the size of the box the page gives it, and the iframe's own
// document fits the video to that box when it resizes.
//
// Everything is reversible at runtime: unticking the setting removes the stylesheet and the class
// and puts the page back exactly as Crunchyroll laid it out, no reload.

const STYLE_ID = 'streamhub-enhance';
const PEEK_ID = 'streamhub-peek';
const ROOT_CLASS = 'sh-cr-theater'; // on <html> while a watch page should be enlarged
const PEEK_CLASS = 'sh-peek'; // …and while the pointer is holding the header open

// Crunchyroll's CSS-module class names carry a build hash (app-layout__header--ywueY), which
// changes whenever they ship, hence the prefix matches on those. The plain names (.erc-*,
// .video-player-*) are their stable ones.
const HEADER_SLOT = '[class*="app-layout__header--"]';

// Scoped entirely under html.sh-cr-theater, which only goes on for a watch page, so browse, search
// and series pages are left alone. !important throughout so this wins over Crunchyroll's own
// rules without having to match their specificity.
const CSS = `
/* The header's slot in the page grid is what pushes the player down; collapse it, and float the
   header itself above the page, slid out of view. It comes back when the pointer reaches the top
   edge (#${PEEK_ID} catches that) and stays while the pointer is on it. :focus-within covers
   reaching the search box by keyboard, which would otherwise type into something invisible.

   The visible bar is itself position:fixed inside a header element that is 0px tall, so the
   header needs a real height for translateY(-100%) to move anything; the transform then also
   becomes the containing block for that fixed bar, so the bar travels with it. */
html.${ROOT_CLASS} ${HEADER_SLOT} {
  height: 0 !important;
  min-height: 0 !important;
}
html.${ROOT_CLASS} ${HEADER_SLOT} > * {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: var(--cx-header-height, 3.75rem) !important;
  transform: translateY(-100%);
  transition: transform 160ms ease;
  z-index: 2200 !important;
}
html.${ROOT_CLASS}.${PEEK_CLASS} ${HEADER_SLOT} > *,
html.${ROOT_CLASS} ${HEADER_SLOT} > *:hover,
html.${ROOT_CLASS} ${HEADER_SLOT} > *:focus-within {
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

/* The size of the player. Crunchyroll sizes it from an invisible spacer that sits in the same grid
   cell: 16:9 of the width, but capped at the window height minus room for the header and title
   (calc(100vh - 15.625rem)), which is what leaves the player small on a wide window. A flat 100vh
   lets it own the window; the player letterboxes the picture inside it rather than stretching it.
   Scrolling still reaches the episode details and the next-episode list below. */
html.${ROOT_CLASS} .erc-watch-episode-layout .video-player-spacer {
  height: 100vh !important;
  max-height: 100vh !important;
  min-height: 0 !important;
}
`;

// The controller, as source to be injected into a Crunchyroll view.
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
    headerSlot: HEADER_SLOT,
  });
  const wanted = JSON.stringify(settings || {});

  return `(() => {
  const SETTINGS = ${wanted};
  if (window.__streamhubEnhance) {
    window.__streamhubEnhance.apply(SETTINGS);
    return 'reconfigured';
  }
  const CFG = ${cfg};

  let active = false;   // whether the feature is currently installed
  let urlTimer = null;  // the watcher for Crunchyroll's in-page navigations
  let path = location.pathname;

  const root = () => document.documentElement;

  // Episode pages are /watch/<id>/<slug>, or /<locale>/watch/… for the localised site (/fr/,
  // /pt-br/, …). Series, browse and the rest are left as they are.
  const isWatchPage = () => /^(\\/[a-z]{2}(-[a-z]{2,4})?)?\\/watch\\//i.test(location.pathname);

  function ensureStyle() {
    if (document.getElementById(CFG.styleId)) return;
    const style = document.createElement('style');
    style.id = CFG.styleId;
    style.textContent = CFG.css;
    (document.head || root()).appendChild(style);
  }

  function ensurePeek() {
    if (!document.body || document.getElementById(CFG.peekId)) return;
    const peek = document.createElement('div');
    peek.id = CFG.peekId;
    peek.addEventListener('mouseenter', () => root().classList.add(CFG.peekClass));
    document.body.appendChild(peek);
  }

  // Put the page into (or out of) the enlarged state for wherever Crunchyroll has just navigated to.
  function sync() {
    const on = active && isWatchPage();
    root().classList.toggle(CFG.rootClass, on);
    if (!on) {
      root().classList.remove(CFG.peekClass);
      return;
    }
    ensurePeek();
  }

  // Crunchyroll is a single-page app that announces nothing we can listen for when it moves to the
  // next episode, so the URL is what tells us. A string compare twice a second costs nothing.
  function watchUrl() {
    if (urlTimer !== null) return;
    urlTimer = setInterval(() => {
      if (location.pathname === path) return;
      path = location.pathname;
      sync();
    }, 500);
  }

  function stopWatchUrl() {
    if (urlTimer === null) return;
    clearInterval(urlTimer);
    urlTimer = null;
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function apply(next) {
    const want = Boolean(next && next.crunchyrollTheater);
    if (want === active) return;
    active = want;

    if (!active) {
      stopWatchUrl();
      root().classList.remove(CFG.rootClass, CFG.peekClass);
      const style = document.getElementById(CFG.styleId);
      if (style) style.remove();
      const peek = document.getElementById(CFG.peekId);
      if (peek) peek.remove();
      return;
    }

    ensureStyle();
    path = location.pathname;
    watchUrl();
    whenReady(sync);
  }

  // Release the header once the pointer leaves it. Bound once for the life of the document: it
  // only ever removes a class, so leaving it attached while the feature is off costs nothing.
  // mouseleave does not bubble, hence the capture phase.
  document.addEventListener(
    'mouseleave',
    (e) => {
      const t = e.target;
      if (t && t.parentElement && t.parentElement.matches && t.parentElement.matches(CFG.headerSlot)) {
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
