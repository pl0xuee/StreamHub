# StreamHub

One desktop app for the **official** streaming sites — Netflix, Prime Video, Disney+, Max,
Hulu, YouTube, YouTube TV, Apple TV+, Paramount+, Peacock, Crunchyroll, Twitch, Tubi, your own
**Jellyfin** server, and any others you add — instead of a drawer full of browser tabs.

Each service loads its own website and plays through its own DRM. **No DRM is circumvented,
extracted, or bypassed:** this is a purpose-built Chromium shell hosting the official web
players, built on [castLabs ECS](https://github.com/castlabs/electron-releases), an Electron
fork that bundles the licensed Widevine CDM (vanilla Electron cannot play these sites).

## Download

Grab the latest `StreamHub.AppImage` from
[Releases](https://github.com/pl0xuee/StreamHub/releases).

It needs **FUSE 2** (`libfuse.so.2`), which many distros no longer ship by default:

| Distro | |
| --- | --- |
| Arch / CachyOS | `sudo pacman -S fuse2` |
| Debian / Ubuntu | `sudo apt install libfuse2` |
| Fedora | `sudo dnf install fuse` |

Or skip FUSE entirely: `APPIMAGE_EXTRACT_AND_RUN=1 ./StreamHub.AppImage`.

## Know before you install

- **Video caps at ~720p.** 1080p/4K needs hardware DRM (Widevine L1 + HDCP), which no Linux
  browser has. Chrome and Firefox are capped the same way — it's a platform limit, not a bug.
  Non-DRM services (YouTube, Twitch) go higher via their own quality menus.
- **No offline downloads** — ECS has no persistent Widevine licenses on Linux.
- Linux only.

## Features

- **Glass chrome** — the sidebar is a slab of tinted glass resting *over* the page rather than
  sitting beside it: held clear of the window on all four sides, rounded, lifted by a shadow, and
  see-through enough that a bright frame is plainly visible behind it. It rests off the left edge
  until you reach for that edge, and nothing behind it moves or resizes when it comes and goes.
  The settings, the removed list and the quick switch float the same way. Both halves are
  switchable in Settings: pin it open, or dock it beside the page opaque, the way it used to sit.
- Sidebar with one-click switching; drag to reorder, delete to a "Removed" list, click to
  restore. Collapses to an icon rail.
- **Quick switch** — `Ctrl+K`, a few letters, Enter. Shift+Enter tiles it as another grid pane.
  Works from inside a service too, not just when the sidebar is already open.
- **Pause on switch** — leaving a service pauses its video, returning resumes it.
- **Stays signed in**, per service, in isolated sessions. Popup sign-in ("Sign in with
  Google/Apple") works. Right-click a service to sign out and wipe its data.
- **System media controls (MPRIS)** — the KDE/GNOME panel and lock screen drive playback.
  Media keys work while the app is focused.
- **Grid view** — tile up to four services at once, the same one more than once if you like
  (two streams side by side). The controls live in a small panel at the top of the window that
  stays out of the way until you reach for it: drag a tile to move a pane and it keeps playing
  where it lands. Choose packed, stacked or side-by-side.
- **Full-window theater mode on YouTube** — the player takes the window to itself with the video
  centred in it, and the top bar hides until you reach for it. Scroll down as usual for the
  description and comments. On by default; the switch is in Settings.
- **Twitch streams open in theater mode** — the player is already at full height when the stream
  arrives, chat still beside it, instead of sitting in a box with the channel panels underneath.
  Leaving theater mode on one stream lasts until you open the next. On by default; the switch is
  in Settings.
- **Your own Jellyfin server** — see below.
- **Jellyfin plays through mpv** — no DRM is involved on your own server, so a real player can
  take the original file instead of the browser asking the server to transcode it. Needs mpv
  installed; single view only; the switch is in Settings.
- **Keeps the screen awake** during playback; picture-in-picture; fullscreen (F11).
- **Remembers where you left off** — window, last service, sidebar state.
- **Settings** (sidebar gear, or `Ctrl+,`) — a panel over the page rather than a second window:
  ad blocker, the YouTube and Twitch theater modes, how the sidebar behaves, tray behaviour,
  updates. The removed
  list is a panel now too.
- **Optional tray icon** — closing the window keeps a stream running.

## Updating

"Check for updates" in Settings downloads the new build, swaps the AppImage in place and
restarts into it — no browser, no reinstall. The sidebar's gear shows a dot when one is
waiting.

The file is deliberately named `StreamHub.AppImage`, with no version in it, so updates
overwrite that one path and your desktop entry and dock icon keep working. Coming from an
older `StreamHub-<version>.AppImage`, the update renames the file once and warns you first;
repoint your shortcuts that one time and updates stop disturbing them.

Self-updating only works when running as the AppImage. Started any other way, the app sends
you to the download page instead.

## Jellyfin

Jellyfin ships in the list like everything else, but it is the one service with no address to
ship: the server is yours. Click it and StreamHub asks where that server is — the same address
you would type into a browser, `http://192.168.1.10:8096` or `https://media.example.com/jellyfin`
— checks something is actually answering there, and names the server it found before saving it.
From then on it is an ordinary service: its own session, its own login, grid panes, media keys.

- A bare `192.168.1.10:8096` is enough; the scheme is assumed, and a `/web/index.html` copied out
  of a browser is trimmed off.
- If the check fails but you know the address is right, it offers to use it anyway.
- Right-click Jellyfin in the sidebar → **Change server…** to point it somewhere else. The login
  is left alone, so pointing it back picks up where it left off.
- **HTTPS with a self-signed certificate will not load.** Chromium refuses it and StreamHub does
  not override that. Use plain `http` on your own network, or give the server a real certificate.
- No DRM is involved here — this is your own server, so quality is whatever it serves and the
  ~720p Widevine ceiling above does not apply.

### Playing through mpv

Because the server is yours and no DRM stands in the way, StreamHub can hand the file to
[mpv](https://mpv.io) instead of playing it in the browser. MKV, H.265/HEVC, DTS and TrueHD
audio, PGS and VOBSUB image subtitles and 10-bit video all direct-play that way. The browser
player cannot decode any of them, so it makes the server transcode instead — burning CPU on the
server and losing quality on the way.

Press play and mpv takes over the content area in its own window; the sidebar steps aside for
the duration, the same way it does when a site goes fullscreen. Stop, and you are back on the
page you were on.

The controls are drawn by mpv rather than by StreamHub's glass chrome, and mpv's usual keys work
— space to pause, arrows to seek, `f` for fullscreen.

**`Esc` takes you back to the library.** So does `q`, which is rebound here: in a standalone mpv
it would end the process, and while a film is playing mpv covers the whole content area with the
sidebar stepped aside, so that key is the way out rather than the way to quit. In fullscreen,
`Esc` leaves fullscreen first and returns to the library on a second press.

Where you stopped is reported back to the server, so an item keeps its resume point, shows up
under Continue Watching, and is marked played when it reaches the end.

It needs mpv installed:

| Distro | |
| --- | --- |
| Arch / CachyOS | `sudo pacman -S mpv` |
| Debian / Ubuntu | `sudo apt install mpv` |
| Fedora | `sudo dnf install mpv` |

If mpv is missing, Jellyfin quietly falls back to the browser player. There is a switch in
Settings — "Play Jellyfin through mpv" — to turn it off; turning it off reloads the Jellyfin
view.

Honest caveats:

- **Single view only.** In grid mode Jellyfin keeps the browser player. One mpv window cannot be
  tiled into four panes.
- **The glass chrome cannot float over the video.** An Electron window cannot be composited
  above the window mpv renders into — this was tried, and it does not work. That is why the
  controls are mpv's rather than the app's.
- **It runs on X11, on a Wayland session too.** mpv can only be handed a window to draw into on
  X11 — it has no such support on Wayland — so the app asks for the X11 backend at launch and
  XWayland hosts it. This is why `npm start` and the packaged launcher both pass
  `--ozone-platform=x11`; started some other way without it, Jellyfin playback has nowhere to
  draw and simply never appears.

  Worth knowing what that costs, because it applies to the whole app and not just Jellyfin: under
  X11 any other X client on your machine can read your keystrokes, including the ones you type
  into a service's sign-in page. Wayland isolates applications from each other in a way X11 never
  did. On a desktop where you trust everything you have installed this changes nothing in
  practice, and it is the same exposure as running any X11 browser — but it is a step back from a
  pure Wayland session, taken to make playback possible at all.
- Linux only, like the rest of the app.

## Ad blocking

Off by default, and **experimental** — the toggle is in Settings.

It blocks network requests and applies cosmetic filters using standard uBlock Origin /
EasyList rules, via [`@ghostery/adblocker`](https://github.com/ghostery/adblocker) running in
the main process (uBlock Origin Lite itself is a Manifest V3 extension, which Electron can't
load). Filters are fetched on first enable, cached, and refreshed weekly. Right-click a
service to turn blocking off for just that site.

Honest caveats:

- **Server-stitched ads still get through.** Where ads are muxed into the video itself
  (Hulu's ad tier, Peacock free, some YouTube ads) there is no request to block. Every
  blocker hits this limit.
- **It may break a service.** An over-broad rule can take out a player or a sign-in flow.
  Turn it off and reload if a site misbehaves.
- Blocking ads on an ad-supported tier may breach that service's terms. Your call — it ships
  off.

## Privacy

No account, no server, no telemetry. Logins are ordinary browser cookies under
`~/.config/streamhub/`, encrypted through your OS secret store (kwallet/gnome-libsecret) the
same way Chrome's are.

Two limits: cookies written by an older build stay plaintext until the site rewrites them
(sign out and back in to convert one), and on a system with no keyring Chromium falls back to
a hardcoded key, which is obfuscation rather than security. **A session cookie is a working
login** — don't sync or commit that directory.

## Development

```bash
npm install     # downloads the castLabs ECS binary (bundles Widevine)
npm start
npm run build   # -> dist/StreamHub.AppImage
```

The built-in service list is `DEFAULT_SERVICES` in [`src/services.js`](src/services.js) — add
`{ id, name, url, color }` and it shows up, including for existing users, without disturbing
their order or removals. Personal lists live in `~/.config/streamhub/services.json`, never in
the source.

A service whose address is the user's own server instead carries `selfHosted: true` and an empty
`url`. Its view then loads [`src/ui/setup.html`](src/ui/setup.html) — the only page in the app
served to a service view, and the only one given a bridge ([`src/setup-preload.js`](src/setup-preload.js))
— until an address is saved, at which point the view is rebuilt on the real server.

## Legal

A personal-use shell around official streaming sites. castLabs ECS is free for
personal/development use; redistribution has its own VMP signing and license terms. Keep it a
shell — no scraping of protected streams, no key handling.

[MIT](LICENSE).
