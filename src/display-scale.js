// Per-monitor display scale, for the one desktop that cannot tell Chromium about it.
//
// StreamHub runs on X11 even on a Wayland session (see the top of main.js), which means it runs
// under XWayland. On most compositors that is fine: XWayland presents the screen in logical pixels
// and the compositor scales the picture up (soft, but the right size), or the compositor publishes
// Xft.dpi and Chromium reads it. Hyprland with `xwayland { force_zero_scaling = true }` — which is
// Omarchy's default — does neither. X clients see the monitor's physical pixels and are expected
// to scale themselves, and nothing tells them by how much. Chromium then draws at 1x, and on a 4K
// monitor set to 150% the whole app comes out at two-thirds size.
//
// So the app asks the compositor. `hyprctl monitors` says what each monitor's scale is, and the
// window follows that as it moves between monitors. It is applied as page zoom rather than as a
// device scale factor: X11 has exactly one device scale factor for the whole display, chosen at
// startup, and a desk with three monitors at two different scales has no single right answer.
// Zoom is per view and changes at runtime, so the window can be dragged from the 4K monitor to the
// 1440p one and come out the right size on both. Visually the two are the same thing — layout,
// text and devicePixelRatio all follow zoom exactly as they follow the device scale factor.
//
// The user can also simply say. A manual scale in Settings overrides detection, for desktops this
// cannot see into, and for anyone who wants the app larger or smaller than the desktop's idea.
const { execFile, execFileSync } = require('child_process');
const { screen } = require('electron');

// The manual choices offered in Settings. 'auto' means "whatever the monitor says".
const SCALE_CHOICES = [1, 1.25, 1.5, 1.75, 2];

const HYPRCTL_TIMEOUT_MS = 1500;

// What the compositor last told us. `zeroScaling` is whether XWayland is being handed physical
// pixels at all — without that, XWayland's own upscaling already makes a 1x Chromium the right size
// and a second scaling on top would double it up.
let cache = { monitors: [], zeroScaling: false };

// Is the app running on X11, as opposed to natively on Wayland? Natively, Chromium learns every
// monitor's scale from the compositor itself and there is nothing for this module to add.
function onX11() {
  const flag = process.argv.find((a) => a.startsWith('--ozone-platform='));
  if (flag) return flag.endsWith('=x11');
  const hint = String(process.env.ELECTRON_OZONE_PLATFORM_HINT || '').toLowerCase();
  if (hint === 'wayland') return false;
  if (hint === 'auto') return !process.env.WAYLAND_DISPLAY;
  return true;
}

// Only Hyprland, only under XWayland, and only when nothing else has already spoken for the scale:
// an explicit --force-device-scale-factor or a GDK_SCALE above 1 are the user telling Chromium
// directly, and Chromium honours both on its own.
function canDetect() {
  if (process.platform !== 'linux') return false;
  if (!process.env.WAYLAND_DISPLAY || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  if (!onX11()) return false;
  if (process.argv.some((a) => a.startsWith('--force-device-scale-factor'))) return false;
  const gdk = Number(process.env.GDK_SCALE);
  if (Number.isFinite(gdk) && gdk > 1) return false;
  return true;
}

// `hyprctl getoption` has changed the shape of its answer between releases: the value has been
// reported as `int` and as `bool`. Read whichever is there.
function optionOn(opt) {
  if (!opt || typeof opt !== 'object') return false;
  if (typeof opt.bool === 'boolean') return opt.bool;
  if (typeof opt.int === 'number') return opt.int !== 0;
  return false;
}

function cleanMonitors(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m === 'object' && !m.disabled)
    .map((m) => ({
      name: String(m.name || ''),
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      scale: Number(m.scale) || 1,
      transform: Number(m.transform) || 0,
    }));
}

function hyprctlSync(args) {
  return JSON.parse(
    execFileSync('hyprctl', ['-j', ...args], {
      encoding: 'utf8',
      timeout: HYPRCTL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

function hyprctlAsync(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'hyprctl',
      ['-j', ...args],
      { encoding: 'utf8', timeout: HYPRCTL_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err);
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(e);
          }
        }
      },
    );
  });
}

// Read the compositor once, blocking. For startup only: it is a few milliseconds, and the first
// frame the window draws should already be at the right size rather than jumping a beat later.
function detectSync() {
  if (!canDetect()) return;
  try {
    cache = {
      zeroScaling: optionOn(hyprctlSync(['getoption', 'xwayland:force_zero_scaling'])),
      monitors: cleanMonitors(hyprctlSync(['monitors'])),
    };
  } catch {
    cache = { monitors: [], zeroScaling: false };
  }
}

// The same, without blocking — for a monitor being plugged in or reconfigured while running.
let refreshing = null;
function refresh() {
  if (!canDetect()) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = Promise.all([
    hyprctlAsync(['getoption', 'xwayland:force_zero_scaling']),
    hyprctlAsync(['monitors']),
  ])
    .then(([opt, monitors]) => {
      cache = { zeroScaling: optionOn(opt), monitors: cleanMonitors(monitors) };
    })
    .catch(() => {
      /* keep what we had */
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// A monitor's size in physical pixels as XWayland presents it: a rotated one is reported by
// Hyprland in its native orientation and by X in the orientation it is actually standing in.
function physicalSize(m) {
  const rotated = m.transform % 2 === 1;
  return rotated ? { w: m.height, h: m.width } : { w: m.width, h: m.height };
}

// Which of the compositor's monitors an Electron display is.
//
// Nothing names them the same way: under X11 Electron gives every display an empty label and
// lays the X screen out on its own, so positions do not match Hyprland's logical layout either.
// Physical size is the one thing both sides agree on, and it is enough for any desk short of two
// identical monitors — for those, both sides list monitors in the order the compositor made them.
function monitorFor(display) {
  if (!cache.zeroScaling || !cache.monitors.length) return null;
  const scale = display.scaleFactor || 1;
  const w = Math.round(display.size.width * scale);
  const h = Math.round(display.size.height * scale);
  const same = cache.monitors.filter((m) => {
    const p = physicalSize(m);
    return p.w === w && p.h === h;
  });
  if (!same.length) return null;
  if (same.length === 1) return same[0];
  const twins = screen
    .getAllDisplays()
    .filter((d) => d.size.width === display.size.width && d.size.height === display.size.height);
  const i = twins.findIndex((d) => d.id === display.id);
  return same[i] || same[0];
}

// The scale the app should be drawn at on a display, and where that number came from.
//   manual   — the user chose it in Settings;
//   monitor  — the compositor said so;
//   system   — Chromium's own reading, which is right everywhere this module has nothing to add.
function scaleFor(display, manual) {
  if (typeof manual === 'number' && manual > 0) return { scale: manual, source: 'manual' };
  const m = monitorFor(display);
  if (m && Number.isFinite(m.scale) && m.scale > 0) {
    return { scale: m.scale, source: 'monitor', monitor: m.name };
  }
  return { scale: display.scaleFactor || 1, source: 'system' };
}

// The zoom to apply to every view for a window at these bounds. Chromium already scales by the
// display's device scale factor; zoom makes up whatever difference is left.
function zoomFor(windowBounds, manual) {
  const display = screen.getDisplayMatching(windowBounds);
  const found = scaleFor(display, manual);
  const dsf = display.scaleFactor || 1;
  return { ...found, zoom: found.scale / dsf, systemScale: dsf };
}

// A manual value from the UI, or 'auto'. Anything else is 'auto' — a stale or hand-edited config
// must not zoom the app to nothing.
function cleanChoice(value) {
  if (typeof value === 'number' && SCALE_CHOICES.includes(value)) return value;
  return 'auto';
}

module.exports = {
  SCALE_CHOICES,
  canDetect,
  detectSync,
  refresh,
  zoomFor,
  cleanChoice,
};
