// NOT WIRED UP. Nothing loads this page, and nothing should expect it to work.
//
// It was written to draw the player controls in Electron, over the video. That turned out to be
// impossible here: no Electron window can be composited above the window mpv renders into — tried
// with the overlay parented to the main window and to the mpv host, with always-on-top, with
// moveTop(), and with a notification-type window, measuring the pixels each time. mpv's own
// on-screen controller is the only overlay that can sit over the picture, because it is drawn
// inside mpv's window, so the real controls live in src/mpv-osc.lua instead.
//
// Kept because that Lua is a restatement of this design in ASS drawing commands, and it is far
// easier to read the intent here than there. It would also be the starting point if the video
// ever moved to a native libmpv render-API addon, which is the one route that would make an
// Electron-drawn overlay possible.
//
// The description below is of the design, not of anything currently running.
//
// The player OSD's own script. mpv is a separate process, driven by the main process over its IPC
// socket; this page never sees it. Everything on the bar is drawn from the state main pushes down
// the `__streamhubPlayer` bridge, and every control asks main for a change rather than making one.
//
// The bridge is allowed to be missing. This page is small enough to be worth opening on its own to
// look at, and a control bar that throws on load because nothing is playing would be untestable —
// so without a bridge it drives itself from a standing-still example instead.

const osdEl = document.getElementById('osd');
const titleEl = document.getElementById('title');
const elapsedEl = document.getElementById('elapsed');
const durationEl = document.getElementById('duration');
const seekEl = document.getElementById('seek');
const seekFillEl = document.getElementById('seek-fill');
const seekKnobEl = document.getElementById('seek-knob');
const volEl = document.getElementById('volume');
const volFillEl = document.getElementById('vol-fill');
const volKnobEl = document.getElementById('vol-knob');
const playEl = document.getElementById('btn-play');
const muteEl = document.getElementById('btn-mute');
const closeEl = document.getElementById('btn-close');
const spinnerEl = document.getElementById('spinner');
const audioBtnEl = document.getElementById('btn-audio');
const audioValueEl = document.getElementById('audio-value');
const audioMenuEl = document.getElementById('menu-audio');
const subsBtnEl = document.getElementById('btn-subs');
const subsValueEl = document.getElementById('subs-value');
const subsMenuEl = document.getElementById('menu-subs');

const bridge = window.__streamhubPlayer || null;

// How long the bar waits before leaving. Three seconds is what every player settles on: long
// enough to reach for a control after moving to it, short enough that the film is not sharing the
// screen with a bar nobody is using.
const IDLE_AFTER = 3000;
// What the arrow keys are worth. Ten seconds is a missed line of dialogue, which is what someone
// pressing Left is almost always after.
const SEEK_STEP = 10;
const VOLUME_STEP = 5;

let state = {
  positionSeconds: 0,
  durationSeconds: 0,
  paused: true,
  volume: 100,
  muted: false,
  title: '',
  tracks: { audio: [], subtitle: [] },
  buffering: false,
};

// Where the pointer has dragged the seek handle to, while it is being dragged. Incoming state
// keeps arriving during a scrub and would otherwise yank the handle back to wherever mpv still
// is — so while this is a number, it is what the bar draws.
let scrubSeconds = null;
// The same for volume: a drag owns the slider until it is let go.
let scrubVolume = null;
// The picker menu currently showing, if any. The bar may not leave while one is open, and Escape
// closes the menu before it closes the player.
let openMenu = null;
let pointerOnBar = false;
let idleTimer = 0;
// Whether the bar was being held open the last time anything looked. Pressing play with the mouse
// and then leaving it still is the case this exists for: the countdown has to start when the
// reason to stay ends, not only when the pointer next moves.
let heldOpen = true;

/* ---- Talking to main ---- */

// Every control goes through here, so a bridge that is missing or has gone away is handled in one
// place rather than at each call site. Without a bridge the request is applied to the example
// state instead, which is what makes the page usable on its own.
function send(method, ...args) {
  const fn = bridge && bridge[method];
  if (typeof fn !== 'function') {
    demo(method, args);
    return;
  }
  try {
    fn.apply(bridge, args);
  } catch (err) {
    // A control that cannot be delivered is not worth taking the OSD down for: the film is still
    // playing, and the rest of the bar still works.
    console.warn('[player]', method, 'failed:', (err && err.message) || err);
  }
}

// State arrives whole rather than as a diff, but a partial payload — or none at all — must not be
// able to empty the bar, so it is merged over what is already there and the track lists are made
// safe to iterate before anything reads them.
function apply(next) {
  if (!next || typeof next !== 'object') return;
  const tracks = next.tracks || state.tracks || {};
  state = Object.assign({}, state, next, {
    tracks: {
      audio: Array.isArray(tracks.audio) ? tracks.audio : [],
      subtitle: Array.isArray(tracks.subtitle) ? tracks.subtitle : [],
    },
  });
  render();
}

/* ---- Formatting ---- */

// Hours only once there are any, and minutes padded only when an hour is showing beside them —
// "7:04" for a short, "1:07:04" for a film. Both hold their width as they count.
function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function langTag(track) {
  return track && track.lang ? String(track.lang).toUpperCase() : '';
}

// What a track is called in the menu. mpv gives a title only when the file carries one, so the
// language is the fallback and the numbered track is the last resort — never an empty row.
function trackLabel(track, index) {
  if (!track || typeof track !== 'object') return 'Track ' + (index + 1);
  const named = track.title || track.name || track.label;
  if (named) return String(named);
  const lang = langTag(track);
  if (lang) return lang;
  return 'Track ' + (track.id != null ? track.id : index + 1);
}

// The right-hand caption: what settles a tie between two tracks whose names read alike. The
// language is deliberately not repeated here — the name is almost always the language, and a row
// reading "English   ENG" spends the width that the name itself needs.
function trackNote(track) {
  if (!track || typeof track !== 'object') return '';
  const parts = [];
  if (track.codec) parts.push(String(track.codec).toUpperCase());
  // mpv calls it `demux-channel-count`; anything friendlier that main hands down is taken as is.
  const channels = track.channels || track['demux-channel-count'];
  if (channels) parts.push(String(channels));
  if (track.forced) parts.push('FORCED');
  return parts.join(' · ');
}

// What the pill beside the label says about the track that is playing. The language is what anyone
// glancing at it is checking — unless the file holds two tracks in that language, in which case the
// name is the only thing that tells the commentary from the film.
function pillValue(list, track) {
  if (!track) return '';
  const lang = langTag(track);
  const shared = lang && list.filter((t) => langTag(t) === lang).length > 1;
  if (lang && !shared) return lang;
  return trackLabel(track, list.indexOf(track));
}

// Which track is playing. mpv's track-list flags the selected one, so that flag is the source of
// truth; `current` is accepted too because that is what jellyfin-web's own payloads call it.
function selectedTrack(list) {
  return (list || []).find((t) => t && (t.selected || t.current)) || null;
}

/* ---- Drawing ---- */

function setSlider(el, fillEl, knobEl, fraction, now, text) {
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  fillEl.style.width = pct + '%';
  knobEl.style.left = pct + '%';
  el.setAttribute('aria-valuenow', String(Math.round(now)));
  el.setAttribute('aria-valuetext', text);
}

// The track menus are rebuilt only when the tracks themselves change. Rebuilding them on every
// state tick would throw away the hover and the keyboard focus of a menu that is open at the time,
// once a second, for the whole film.
let menuSignature = '';

function render() {
  const duration = Math.max(0, Number(state.durationSeconds) || 0);
  const played = Math.max(0, Number(state.positionSeconds) || 0);
  const level = Math.max(0, Math.min(100, Number(state.volume) || 0));
  // A drag owns its slider: whatever mpv last said is ignored until the pointer is let go.
  const position = scrubSeconds != null ? scrubSeconds : played;
  const volume = scrubVolume != null ? scrubVolume : level;

  titleEl.textContent = state.title || 'Nothing playing';
  titleEl.title = state.title || '';

  elapsedEl.textContent = clock(position);
  // A live stream has no end, so it gets no total — a running "0:00" on the right would read as a
  // film of no length rather than as something still going.
  durationEl.textContent = duration ? clock(duration) : '—:—';
  seekEl.setAttribute('aria-valuemax', String(Math.round(duration)));
  setSlider(
    seekEl,
    seekFillEl,
    seekKnobEl,
    duration ? position / duration : 0,
    position,
    clock(position) + (duration ? ' of ' + clock(duration) : '')
  );

  setSlider(volEl, volFillEl, volKnobEl, volume / 100, volume, Math.round(volume) + '%');

  document.body.classList.toggle('playing', !state.paused);
  document.body.classList.toggle('muted', Boolean(state.muted));
  playEl.title = state.paused ? 'Play (Space)' : 'Pause (Space)';
  playEl.setAttribute('aria-label', state.paused ? 'Play' : 'Pause');
  muteEl.title = state.muted ? 'Unmute' : 'Mute';
  muteEl.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
  spinnerEl.hidden = !state.buffering;

  const audio = selectedTrack(state.tracks.audio);
  const subtitle = selectedTrack(state.tracks.subtitle);
  audioValueEl.textContent = pillValue(state.tracks.audio, audio) || '—';
  subsValueEl.textContent = pillValue(state.tracks.subtitle, subtitle) || 'Off';

  const signature = JSON.stringify([state.tracks.audio, state.tracks.subtitle]);
  if (signature !== menuSignature) {
    menuSignature = signature;
    fillMenu(audioMenuEl, state.tracks.audio, 'setAudioTrack', false);
    fillMenu(subsMenuEl, state.tracks.subtitle, 'setSubtitleTrack', true);
  }

  // Paused, loading, or with a menu open, the bar has to stay: it is being read or being used. Only
  // the moment that changes is acted on — calling this every tick would restart the countdown once
  // a second and the bar would never leave at all.
  if (holdOpen() !== heldOpen) wake();
}

function fillMenu(menuEl, tracks, method, withOff) {
  menuEl.textContent = '';
  const selected = selectedTrack(tracks);

  // Subtitles can be turned off, which is a choice the menu has to offer as plainly as any track —
  // audio cannot, so only the subtitle menu gets this row.
  if (withOff) {
    menuEl.append(makeMenuItem('Off', '', !selected, () => choose(method, null)));
  }

  if (!tracks.length && !withOff) {
    const empty = document.createElement('p');
    empty.className = 'menu-empty';
    empty.textContent = 'No other tracks in this file.';
    menuEl.append(empty);
    return;
  }

  tracks.forEach((track, i) => {
    const on = Boolean(track && (track.selected || track.current));
    const id = track && track.id != null ? track.id : i + 1;
    const pick = () => choose(method, id);
    menuEl.append(makeMenuItem(trackLabel(track, i), trackNote(track), on, pick));
  });
}

function makeMenuItem(label, note, on, onPick) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'menu-item' + (on ? ' on' : '');
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', on ? 'true' : 'false');

  const text = document.createElement('span');
  text.className = 'menu-label';
  text.textContent = label;
  item.append(text);

  if (note) {
    const noteEl = document.createElement('span');
    noteEl.className = 'menu-note';
    noteEl.textContent = note;
    item.append(noteEl);
  }

  item.addEventListener('click', onPick);
  return item;
}

// Picking a track closes the menu straight away rather than waiting for the new state to come
// back: mpv takes a moment to switch, and a menu sitting open through it looks like a dead click.
function choose(method, id) {
  send(method, id);
  closeMenu();
}

/* ---- The sliders ---- */

// One drag implementation for both of them. `done` is what separates a live change from the end of
// a gesture, which is the whole difference between the two: volume follows the pointer, seeking
// waits for it to be let go.
function draggable(el, onValue) {
  let dragging = false;

  const fractionAt = (e) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.classList.add('scrubbing');
    // Captured, so a drag that leaves the slider — which every drag does — keeps being the same
    // gesture rather than stopping at the edge of a 4px line.
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      /* no capture is survivable: the drag simply ends when the pointer leaves */
    }
    el.focus();
    onValue(fractionAt(e), false);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (dragging) onValue(fractionAt(e), false);
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('scrubbing');
    onValue(fractionAt(e), true);
  });

  el.addEventListener('pointercancel', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('scrubbing');
    onValue(null, true);
  });
}

// The handle follows the pointer the whole way, but the seek itself waits for the release: every
// pixel of the drag would otherwise be another seek down the socket, and mpv would spend the
// gesture decoding frames nobody is going to see.
draggable(seekEl, (fraction, done) => {
  const duration = Math.max(0, Number(state.durationSeconds) || 0);
  if (!duration) return; // nothing to seek within — a live stream, or nothing loaded yet
  if (fraction != null) scrubSeconds = fraction * duration;
  if (done) {
    const target = scrubSeconds;
    scrubSeconds = null;
    if (target != null) send('seek', target);
  }
  render();
});

// Volume goes the other way: it is a property set and nothing has to be decoded for it, so it
// follows the drag live — which is the only way to set a level by ear.
draggable(volEl, (fraction, done) => {
  if (fraction != null) scrubVolume = fraction * 100;
  const target = scrubVolume;
  if (done) scrubVolume = null;
  if (target != null) send('setVolume', Math.round(target));
  // Turning the volume up is how someone says they want to hear it, so it comes off mute too.
  if (target != null && target > 0 && state.muted) send('setMuted', false);
  render();
});

// The sliders answer their own arrow keys, and swallow them so the window's shortcuts do not act
// on the same press twice.
seekEl.addEventListener('keydown', (e) => {
  const duration = Math.max(0, Number(state.durationSeconds) || 0);
  const position = Math.max(0, Number(state.positionSeconds) || 0);
  let target = null;
  if (e.key === 'ArrowLeft') target = position - SEEK_STEP;
  else if (e.key === 'ArrowRight') target = position + SEEK_STEP;
  else if (e.key === 'Home') target = 0;
  else if (e.key === 'End' && duration) target = duration - 1;
  if (target == null) return;
  e.preventDefault();
  e.stopPropagation();
  send('seek', Math.max(0, duration ? Math.min(target, duration) : target));
});

volEl.addEventListener('keydown', (e) => {
  let step = 0;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -VOLUME_STEP;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = VOLUME_STEP;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  nudgeVolume(step);
});

function nudgeVolume(step) {
  const next = Math.max(0, Math.min(100, (Number(state.volume) || 0) + step));
  send('setVolume', Math.round(next));
  if (step > 0 && state.muted) send('setMuted', false);
}

/* ---- Buttons and menus ---- */

playEl.addEventListener('click', () => send('playPause'));
muteEl.addEventListener('click', () => send('setMuted', !state.muted));
closeEl.addEventListener('click', () => send('close'));

function bindPicker(btn, menu) {
  btn.addEventListener('click', () => {
    if (openMenu === menu) {
      closeMenu();
      return;
    }
    closeMenu();
    openMenu = menu;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.menu-item');
    if (first) first.focus();
    wake();
  });
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.hidden = true;
  openMenu = null;
  audioBtnEl.setAttribute('aria-expanded', 'false');
  subsBtnEl.setAttribute('aria-expanded', 'false');
  wake();
}

bindPicker(audioBtnEl, audioMenuEl);
bindPicker(subsBtnEl, subsMenuEl);

// A click anywhere but inside the picker dismisses its menu — including on the film, which is the
// gesture anyone reaches for first.
document.addEventListener('pointerdown', (e) => {
  if (!openMenu) return;
  const inside = e.target instanceof Element && e.target.closest('.picker');
  if (!inside) closeMenu();
});

/* ---- Getting out of the way ---- */

// What keeps the bar on screen regardless of the clock: there is nothing to watch behind it while
// it is paused or loading, and a menu that vanished mid-choice would be unusable.
function holdOpen() {
  return Boolean(state.paused || state.buffering || openMenu || pointerOnBar);
}

// Back on screen, and counting again — unless something is holding it open, in which case there is
// nothing to count.
function wake() {
  heldOpen = holdOpen();
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (heldOpen) return;
  idleTimer = setTimeout(() => {
    if (holdOpen()) {
      wake();
      return;
    }
    document.body.classList.add('idle');
  }, IDLE_AFTER);
}

osdEl.addEventListener('mouseenter', () => {
  pointerOnBar = true;
  wake();
});
osdEl.addEventListener('mouseleave', () => {
  pointerOnBar = false;
  wake();
});

// Any sign of a person brings it back. `mousemove` is the one that matters — reaching for the
// controls is how a player is asked for them — and the rest are here so that using the bar by
// keyboard or wheel does not let it fade out from under the hand using it.
for (const event of ['mousemove', 'pointerdown', 'wheel', 'keydown']) {
  window.addEventListener(event, wake, { passive: true });
}

/* ---- Keys ---- */

// The player's keys, in the shape every video player has used for twenty years. mpv is started
// with its own bindings off (--no-input-default-bindings), so these are the only ones there are.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

  // A focused button or slider gets first refusal on Space and Enter: they are how that control is
  // pressed, and acting on them here as well would toggle playback behind a click the user meant
  // for something else.
  const focused = document.activeElement;
  const onControl = focused instanceof Element && focused.closest('button, [role="slider"]');
  if (onControl && (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar')) return;

  switch (e.key) {
    case ' ':
    case 'Spacebar':
    case 'k':
    case 'K':
      e.preventDefault();
      send('playPause');
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekBy(-SEEK_STEP);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekBy(SEEK_STEP);
      break;
    case 'ArrowUp':
      e.preventDefault();
      nudgeVolume(VOLUME_STEP);
      break;
    case 'ArrowDown':
      e.preventDefault();
      nudgeVolume(-VOLUME_STEP);
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      send('setMuted', !state.muted);
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      // Optional on the bridge — fullscreen is the window's business, not the player's, and an
      // older bridge may not offer it.
      send('toggleFullscreen');
      break;
    case 'Escape':
      e.preventDefault();
      // Escape closes the nearest thing first: a menu, then the player itself. Stopping the film
      // by mistake while dismissing a menu is not a mistake anyone forgives.
      if (openMenu) closeMenu();
      else send('close');
      break;
    default:
      break;
  }
});

function seekBy(delta) {
  const duration = Math.max(0, Number(state.durationSeconds) || 0);
  const next = Math.max(0, (Number(state.positionSeconds) || 0) + delta);
  send('seek', duration ? Math.min(next, duration) : next);
}

/* ---- With no bridge ---- */

// Opened on its own — for a look at the bar without a film behind it — the page drives itself.
// It starts paused, because nothing is actually playing and because a bar that faded out two
// seconds after the window opened would be a poor thing to be shown.
function startDemo() {
  apply({
    title: 'The Man Who Fell to Earth (1976) — 2160p HDR',
    positionSeconds: 1284,
    durationSeconds: 8130,
    paused: true,
    volume: 70,
    muted: false,
    buffering: false,
    tracks: {
      audio: [
        { id: 1, title: 'Surround', lang: 'eng', codec: 'truehd', channels: '7.1', selected: true },
        { id: 2, title: 'Stereo', lang: 'eng', codec: 'ac3', channels: '2.0' },
        { id: 3, title: 'Director commentary', lang: 'eng', codec: 'ac3', channels: '2.0' },
      ],
      subtitle: [
        { id: 1, title: 'English', lang: 'eng', codec: 'pgs' },
        { id: 2, title: 'English (forced)', lang: 'eng', codec: 'pgs', forced: true },
        { id: 3, title: 'Français', lang: 'fra', codec: 'subrip' },
      ],
    },
  });

  setInterval(() => {
    if (state.paused) return;
    apply({ positionSeconds: Math.min(state.positionSeconds + 1, state.durationSeconds) });
  }, 1000);
}

// The same requests the bridge would have taken, applied to the example state instead, so every
// control on the page does visibly what it says it does even with nothing behind it.
function demo(method, args) {
  const tracks = state.tracks;
  const pick = (list, id) => list.map((t) => Object.assign({}, t, { selected: t.id === id }));

  switch (method) {
    case 'playPause':
      apply({ paused: !state.paused });
      break;
    case 'seek':
      apply({ positionSeconds: Number(args[0]) || 0 });
      break;
    case 'setVolume':
      apply({ volume: Number(args[0]) || 0 });
      break;
    case 'setMuted':
      apply({ muted: Boolean(args[0]) });
      break;
    case 'setAudioTrack':
      apply({ tracks: { audio: pick(tracks.audio, args[0]), subtitle: tracks.subtitle } });
      break;
    case 'setSubtitleTrack':
      apply({ tracks: { audio: tracks.audio, subtitle: pick(tracks.subtitle, args[0]) } });
      break;
    default:
      // close, toggleFullscreen — nothing this page can honour on its own.
      break;
  }
}

/* ---- Go ---- */

if (bridge && typeof bridge.onState === 'function') {
  try {
    bridge.onState(apply);
  } catch (err) {
    console.warn('[player] could not subscribe to state:', (err && err.message) || err);
  }
} else {
  startDemo();
}

render();
wake();
