// The Rumble half of the enhancements (see enhance.js for the settings shape).
//
// Delivered the same way as the YouTube, Twitch and Crunchyroll controllers — as the *source* of a
// controller that views.js injects into the view — and for the same reason: service views are
// sandboxed, which is worth keeping for pages we do not control, and a sandboxed preload cannot
// `require` a local module.
//
// Like YouTube and Crunchyroll, this is a stylesheet scoped under a class on <html>, put on only
// while a watch page is showing: the top header slides out of the way and peeks back when the
// pointer reaches the top edge, and the player fills the window height (100vh) with the picture
// centred rather than stretched. On livestreams with visible chat, chat stays docked beside the
// player at full height on desktop widths — collapsing chat expands the player to the full width.
// Scrolling down still reaches the title, description, comments and related videos.
//
// Pressing `T` or clicking Rumble's own theater button toggles the layout for the current video
// without reloading; navigating to another video re-engages it. Everything is reversible at
// runtime: unticking the setting removes the stylesheet, classes and listeners and hands the page
// back to Rumble untouched.

const STYLE_ID = 'streamhub-enhance';
const PEEK_ID = 'streamhub-peek';
const ROOT_CLASS = 'sh-rumble-theater'; // on <html> while a watch page should be enlarged
const PEEK_CLASS = 'sh-peek'; // …and while the pointer is holding the header open
const LIVE_CLASS = 'sh-rumble-live'; // …and while a live chat column is visible beside the player
const FS_CLASS = 'sh-rumble-fs'; // …disabled while HTML5 fullscreen owns the page

const HEADER_SELECTOR = 'header[data-js="app_header"], header.header';
const THEATER_BTN_SELECTOR =
  '[title="Toggle theater mode" i], [data-js="theater-mode-toggle"], ' +
  'button[title*="theater" i], button[aria-label*="theater" i]';
const CHAT_ASIDE_SELECTOR = 'aside.media-page-chat-aside-chat';
const CHAT_TOGGLE_SELECTOR =
  '[data-js="media_page_chat_container_toggle_btn"], button.media-page-chat-container-toggle-btn';

// Scoped entirely under html.sh-rumble-theater:not(.sh-rumble-fs), which only goes on for a watch
// page outside HTML5 fullscreen, so home, search, channel, shorts and account pages are left alone.
// !important throughout so these win over Rumble's utility classes and inline player dimensions.
const CSS = `
/* The top header slides out of the way and comes back when the pointer reaches the top edge.
   #${PEEK_ID} catches that; the header's own :hover holds it open once the pointer moves onto it,
   and :focus-within keeps it visible when reaching the search box by keyboard. */
html.${ROOT_CLASS}:not(.${FS_CLASS}) header[data-js="app_header"],
html.${ROOT_CLASS}:not(.${FS_CLASS}) header.header {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  transform: translateY(-100%);
  transition: transform 160ms ease;
  z-index: 2200 !important;
}
html.${ROOT_CLASS}.${PEEK_CLASS}:not(.${FS_CLASS}) header[data-js="app_header"],
html.${ROOT_CLASS}.${PEEK_CLASS}:not(.${FS_CLASS}) header.header,
html.${ROOT_CLASS}:not(.${FS_CLASS}) header[data-js="app_header"]:hover,
html.${ROOT_CLASS}:not(.${FS_CLASS}) header.header:hover,
html.${ROOT_CLASS}:not(.${FS_CLASS}) header[data-js="app_header"]:focus-within,
html.${ROOT_CLASS}:not(.${FS_CLASS}) header.header:focus-within {
  transform: none;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) #${PEEK_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  z-index: 2201;
}

/* Take back the vertical gap left by the hidden header and any left-rail offset on watch pages. */
html.${ROOT_CLASS}:not(.${FS_CLASS}) body {
  padding-top: 0 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) main.nav--transition {
  margin-left: 0 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) main[data-js="media_container"],
html.${ROOT_CLASS}:not(.${FS_CLASS}) main.media-page,
html.${ROOT_CLASS}:not(.${FS_CLASS}) main:has(#videoPlayer) {
  margin-top: 0 !important;
  padding-top: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) #player-spacer {
  display: none !important;
}

/* Watch layout without a side-by-side live chat column (VODs, streams with chat collapsed, or
   narrow grid panes): stack the related-videos sidebar below so the player gets the full width
   and nothing on the page is lost — scrolling down still reaches everything underneath. */
html.${ROOT_CLASS}:not(.${FS_CLASS}):not(.${LIVE_CLASS}) .main-and-sidebar,
html.${ROOT_CLASS}:not(.${FS_CLASS}):not(.${LIVE_CLASS}) [data-js="media_container"]:has(> aside.media-page-related-media-desktop-sidebar) {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}):not(.${LIVE_CLASS}) .main-and-sidebar .main-content,
html.${ROOT_CLASS}:not(.${FS_CLASS}):not(.${LIVE_CLASS}) .media-container:has(#videoPlayer) {
  width: 100% !important;
  max-width: 100% !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* Livestreams with visible chat: keep chat docked beside the full-height player on desktop widths,
   and stack vertically in narrow panes (e.g. a tiled grid) so the video is not squeezed. */
@media (min-width: 1024px) {
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .main-and-sidebar,
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) [data-js="media_container"]:has(> ${CHAT_ASIDE_SELECTOR}) {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) var(--sh-chat-w, 360px) !important;
    align-items: start !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    gap: 0 !important;
  }
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .main-and-sidebar .main-content,
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .media-container:has(#videoPlayer) {
    min-width: 0 !important;
    width: 100% !important;
    max-width: 100% !important;
    padding: 0 !important;
  }
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) ${CHAT_ASIDE_SELECTOR} {
    width: var(--sh-chat-w, 360px) !important;
    min-width: var(--sh-chat-w, 360px) !important;
    max-width: clamp(320px, var(--sh-chat-w, 360px), 480px) !important;
    height: 100vh !important;
    max-height: 100vh !important;
    position: sticky !important;
    top: 0 !important;
    margin-top: 0 !important;
  }
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .media-page-chat-aside-chat-wrapper-fixed {
    top: 0 !important;
    height: 100vh !important;
    max-height: 100vh !important;
  }
}
@media (max-width: 1023px) {
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .main-and-sidebar,
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) [data-js="media_container"]:has(> ${CHAT_ASIDE_SELECTOR}) {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .main-and-sidebar .main-content,
  html.${ROOT_CLASS}.${LIVE_CLASS}:not(.${FS_CLASS}) .media-container:has(#videoPlayer) {
    width: 100% !important;
    max-width: 100% !important;
    padding: 0 !important;
  }
}

/* The player itself: a flat 100vh so the video owns the window height, with object-fit:contain
   keeping the picture centred and unstretched on black. Guarded against Rumble's hidden preload
   video (.preload) and against HTML5 fullscreen (.rumble-player--fullscreen / .${FS_CLASS}). */
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer,
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) .video-player:has(#videoPlayer),
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) .video-player#videoPlayer {
  position: relative !important;
  width: 100% !important;
  max-width: 100% !important;
  height: 100vh !important;
  max-height: 100vh !important;
  min-height: 0 !important;
  margin-top: 0 !important;
  background: #000 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer .videoPlayer-Rumble-cls,
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer.videoPlayer-Rumble-cls,
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer [id^="vid_v"] {
  position: relative !important;
  width: 100% !important;
  max-width: 100% !important;
  height: 100% !important;
  max-height: 100vh !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  aspect-ratio: unset !important;
  background: #000 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer .videoPlayer-Rumble-cls > div:has(video) {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}
html.${ROOT_CLASS}:not(.${FS_CLASS}) body:not(.rumble-player--fullscreen) #videoPlayer video:not(.preload) {
  width: 100% !important;
  height: 100% !important;
  max-height: 100vh !important;
  object-fit: contain !important;
}
`;

// The controller, as source to be injected into a Rumble view.
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
    liveClass: LIVE_CLASS,
    fsClass: FS_CLASS,
    header: HEADER_SELECTOR,
    theaterBtn: THEATER_BTN_SELECTOR,
    chatAside: CHAT_ASIDE_SELECTOR,
    chatToggle: CHAT_TOGGLE_SELECTOR,
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
  let userExited = false;  // whether the viewer toggled theater off for this video
  let urlTimer = null;     // fallback watcher for Rumble's in-page/htmx navigations
  let liveTimer = null;    // bounded poll waiting for live chat to hydrate on watch pages
  let lastRoute = location.pathname + location.search;

  const root = () => document.documentElement;

  // Watch pages are /v<id>-<slug>.html, /v<id>.html or /video/<id>. Home, search, channel,
  // shorts (/shorts), embeds (/embed/) and account pages are left untouched.
  const isWatchPage = () => {
    const p = location.pathname;
    return /^\\/v[a-z0-9]+-/i.test(p) || /^\\/v[a-z0-9]+\\.html$/i.test(p) || p.startsWith('/video/');
  };

  const nudgePlayer = () => window.dispatchEvent(new Event('resize'));

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

  function stopLivePoll() {
    if (liveTimer === null) return;
    clearInterval(liveTimer);
    liveTimer = null;
  }

  // Detect whether a live chat sidebar is present and visible, so livestreams keep chat docked
  // beside the player while VODs and streams with collapsed chat expand to the full width.
  function syncLive() {
    if (!active || !isWatchPage() || userExited) {
      root().classList.remove(CFG.liveClass);
      root().style.removeProperty('--sh-chat-w');
      return false;
    }
    const chat = document.querySelector(CFG.chatAside);
    const visible = Boolean(chat && !chat.hidden && getComputedStyle(chat).display !== 'none');
    if (visible) {
      const rect = chat.getBoundingClientRect();
      if (rect.width >= 280 && rect.width <= 480) {
        root().style.setProperty('--sh-chat-w', Math.round(rect.width) + 'px');
      }
    } else {
      root().style.removeProperty('--sh-chat-w');
    }
    root().classList.toggle(CFG.liveClass, visible);
    return visible;
  }

  // Chat sometimes arrives after initial DOM hydration (e.g. via htmx swap). Poll briefly per
  // navigation so a livestream picks up its two-column layout as soon as chat mounts.
  function startLivePoll() {
    stopLivePoll();
    let tries = 0;
    liveTimer = setInterval(() => {
      tries += 1;
      if (syncLive() || tries >= 20 || !active || !isWatchPage() || userExited) {
        stopLivePoll();
        nudgePlayer();
      }
    }, 500);
  }

  function syncFullscreen() {
    const fs = Boolean(document.fullscreenElement);
    const was = root().classList.contains(CFG.fsClass);
    root().classList.toggle(CFG.fsClass, fs);
    if (fs) root().classList.remove(CFG.peekClass);
    if (was !== fs && active && isWatchPage()) nudgePlayer();
  }

  // Put the page into (or out of) the enlarged state for the current route and user choice.
  function sync() {
    syncFullscreen();
    const on = active && isWatchPage() && !userExited;
    root().classList.toggle(CFG.rootClass, on);
    if (!on) {
      stopLivePoll();
      root().classList.remove(CFG.peekClass, CFG.liveClass);
      root().style.removeProperty('--sh-chat-w');
      nudgePlayer();
      return;
    }
    ensurePeek();
    if (!syncLive()) startLivePoll();
    nudgePlayer();
  }

  function onRouteChange() {
    const route = location.pathname + location.search;
    if (route === lastRoute) return;
    lastRoute = route;
    userExited = false;
    sync();
  }

  function onHtmx() {
    const route = location.pathname + location.search;
    if (route !== lastRoute) {
      lastRoute = route;
      userExited = false;
    }
    sync();
  }

  // Clicking Rumble's own theater button or pressing T toggles our theater mode for the current
  // video without fighting Rumble's built-in toggle. Leaving theater mode lasts until the next
  // video (or until pressed again); turning it off permanently is the checkbox in Settings.
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
  }

  function onDocumentClick(e) {
    if (!active || !isWatchPage() || !(e.target instanceof Element)) return;
    if (e.isTrusted && e.target.closest(CFG.theaterBtn)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      userExited = !userExited;
      sync();
      return;
    }
    if (e.target.closest(CFG.chatToggle)) {
      setTimeout(() => {
        syncLive();
        nudgePlayer();
      }, 60);
    }
  }

  function onDocumentKeydown(e) {
    if (!active || !isWatchPage() || !e.isTrusted || document.fullscreenElement) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if ((e.key || '').toLowerCase() !== 't') return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    userExited = !userExited;
    sync();
  }

  function watchUrl() {
    if (urlTimer !== null) return;
    urlTimer = setInterval(onRouteChange, 500);
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
    const want = Boolean(next && next.rumbleTheater);
    if (want === active) return;
    active = want;

    if (!active) {
      stopLivePoll();
      stopWatchUrl();
      userExited = false;
      root().classList.remove(CFG.rootClass, CFG.peekClass, CFG.liveClass, CFG.fsClass);
      root().style.removeProperty('--sh-chat-w');
      const style = document.getElementById(CFG.styleId);
      if (style) style.remove();
      const peek = document.getElementById(CFG.peekId);
      if (peek) peek.remove();
      window.removeEventListener('popstate', onRouteChange);
      document.removeEventListener('htmx:afterSwap', onHtmx);
      document.removeEventListener('htmx:afterSettle', onHtmx);
      document.removeEventListener('htmx:historyRestore', onHtmx);
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onDocumentKeydown, true);
      nudgePlayer();
      return;
    }

    ensureStyle();
    lastRoute = location.pathname + location.search;
    userExited = false;
    window.addEventListener('popstate', onRouteChange);
    document.addEventListener('htmx:afterSwap', onHtmx);
    document.addEventListener('htmx:afterSettle', onHtmx);
    document.addEventListener('htmx:historyRestore', onHtmx);
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
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
      if (t instanceof Element && t.matches(CFG.header)) {
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
