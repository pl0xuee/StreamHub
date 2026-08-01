// The Twitch half of the enhancements (see enhance.js for the settings shape).
//
// Delivered the same way as the YouTube controller — as the *source* of a controller that views.js
// injects into the view — and for the same reason: service views are sandboxed, which is worth
// keeping for pages we do not control, and a sandboxed preload cannot `require` a local module.
//
// Unlike YouTube's, this one ships no stylesheet. Twitch's own theatre mode already does the whole
// job: the top bar, the left rail and the panels under the stream all go, the player takes the
// window's full height and chat keeps its column beside it. There is nothing left to override, so
// all this controller does is press the button the site already draws. That also makes it entirely
// reversible — unticking the setting simply stops us pressing it.

// The controller, as source to be injected into a Twitch view.
//
// Idempotent by design: it parks itself on window.__streamhubEnhance, so re-running this — which
// happens on every document load and every time the setting changes — reconfigures the controller
// already there instead of stacking up a second set of timers.
function controllerJs(settings) {
  const wanted = JSON.stringify(settings || {});

  return `(() => {
  const SETTINGS = ${wanted};
  if (window.__streamhubEnhance) {
    window.__streamhubEnhance.apply(SETTINGS);
    return 'reconfigured';
  }

  let active = false;   // whether the feature is currently switched on
  let timer = null;     // the bounded poll waiting for a player to appear
  let urlTimer = null;  // the watcher for Twitch's in-page navigations
  let path = location.pathname;

  // Twitch gives its theatre button no data-a-target of its own — unlike play, mute, settings and
  // fullscreen, which all have one. What it does have is a fixed place: it is the last control
  // before fullscreen in the player's right-hand cluster. That, and the absence of a data-a-target,
  // is what identifies it here. Its label would be the obvious thing to match on and is the one
  // thing we cannot use: it reads "Theatre Mode (alt+t)" in English and something different in
  // every other language Twitch ships.
  //
  // The cluster is in the page twice, once for the live player and once hidden at zero size; only
  // the visible one's button does anything when clicked.
  function theaterButton() {
    const groups = document.querySelectorAll('.player-controls__right-control-group');
    for (const group of groups) {
      if (!group.getBoundingClientRect().width) continue;
      const buttons = Array.from(group.querySelectorAll('button'));
      const fullscreen = buttons.findIndex((b) => b.dataset.aTarget === 'player-fullscreen-button');
      const button = fullscreen > 0 ? buttons[fullscreen - 1] : null;
      // The data-a-target check is what keeps a Twitch that has dropped the theatre button from
      // leaving us clicking whatever has moved into its place — the settings button, say, which
      // would open a menu over the stream on every single one.
      if (button && !button.dataset.aTarget) return button;
    }
    return null;
  }

  // Two independent reads, because the one mistake that costs anything is deciding theatre mode is
  // off while it is on and clicking it straight back off. Either signal saying "on" is enough:
  // the class Twitch puts on the page's scroll area in theatre mode, and the player standing as
  // tall as the window, which nothing but theatre or fullscreen makes it do. If both are wrong we
  // do nothing, which is the harmless way round.
  function inTheater() {
    if (document.querySelector('.channel-root__scroll-area--theatre-mode')) return true;
    const video = document.querySelector('video');
    if (!video) return false;
    return video.getBoundingClientRect().height >= window.innerHeight - 2;
  }

  function stopPoll() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  // Poll for a player, then give up: most Twitch pages — the directory, a following list, a
  // channel that is offline — never grow one, and the ones that do can take a while to get there
  // behind a preroll ad. Twenty seconds is long enough for the slow case and still bounded.
  //
  // This runs per navigation rather than once ever. Leaving theatre mode on one stream reads as a
  // decision about that stream and is honoured until the next one; switching the whole thing off
  // for good is the settings checkbox, not the player button. Hence also the two-click ceiling —
  // it covers a button that is on screen a moment before React has wired it up, without ever
  // turning into an argument with someone who wants theatre mode off.
  function startPoll() {
    stopPoll();
    let tries = 0;
    let clicks = 0;
    timer = setInterval(() => {
      tries += 1;
      if (inTheater() || clicks >= 2 || tries > 80) {
        stopPoll();
        return;
      }
      const button = theaterButton();
      if (button) {
        button.click();
        clicks += 1;
      }
    }, 250);
  }

  // Twitch is a single-page app, and unlike YouTube it announces nothing we can listen for, so the
  // URL is what tells us a new stream has arrived. A string compare twice a second costs nothing
  // next to what the page it is watching is already doing.
  function watchUrl() {
    if (urlTimer !== null) return;
    urlTimer = setInterval(() => {
      if (location.pathname === path) return;
      path = location.pathname;
      startPoll();
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

  // Toggling off leaves the stream in whatever mode it is in. Theatre mode is Twitch's own setting
  // and the user can see the button for it; putting them back to the small player because they
  // unticked something in our settings would be us making a decision that is not ours.
  function apply(next) {
    const want = Boolean(next && next.twitchTheater);
    if (want === active) return;
    active = want;

    if (!active) {
      stopPoll();
      stopWatchUrl();
      return;
    }

    path = location.pathname;
    watchUrl();
    whenReady(startPoll);
  }

  window.__streamhubEnhance = { apply };
  apply(SETTINGS);
  return 'installed';
})()`;
}

module.exports = { controllerJs };
