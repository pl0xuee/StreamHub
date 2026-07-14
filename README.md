# StreamHub

A desktop app that wraps the **official** streaming websites (Netflix, Prime Video,
Disney+, Max, Hulu, YouTube, Apple TV+, Paramount+, Peacock, Crunchyroll, Twitch, Tubi,
and any others you add) behind one unified, gunmetal-grey UI — so you get an app-like
experience instead of juggling browser tabs.

Playback happens on each service's own website using its own DRM. **No DRM is
circumvented, extracted, or bypassed** — the app is a purpose-built Chromium shell
that hosts the official web players.

## Download

Grab the latest `StreamHub-*.AppImage` from the [Releases](https://github.com/pl0xuee/StreamHub/releases)
page. It needs the **FUSE 2** runtime to run (see [Requirements](#requirements--limits-linux)).

## How it works

- Built on [castLabs "Electron for Content Security" (ECS)](https://github.com/castlabs/electron-releases),
  a drop-in Electron fork that bundles the licensed **Widevine** CDM. This is what
  makes Netflix/Prime/etc. actually play — vanilla Electron cannot.
- Each service loads in its own `WebContentsView` with a **persistent, isolated
  session** (`persist:<service>@default`), so every service stays logged in and keeps
  its cookies separate from the others.
- Each service view presents a desktop Chrome identity (User-Agent **and** matching
  `Sec-CH-UA` client hints) so sign-in flows behave the same as they do in Chrome.
- The sidebar (the only part this app styles) switches services and can collapse to a
  narrow icon rail; the streaming sites keep their own look inside the content area.

## Requirements & limits (Linux)

- **Resolution caps at ~720p.** Netflix and most services require hardware DRM
  (Widevine L1 + HDCP) for 1080p/4K, which Linux browsers don't have. This matches what
  Chrome/Firefox deliver on Linux today — it is a platform limit, not an app bug.
  (YouTube, Twitch and other non-DRM services can go higher via their own quality menus.)
- **FUSE 2 is needed to run the AppImage** (`libfuse.so.2`), which many current distros
  no longer ship by default:
  - Arch/CachyOS: `sudo pacman -S fuse2`
  - Debian/Ubuntu: `sudo apt install libfuse2`
  - Fedora: `sudo dnf install fuse`

  Or run it without FUSE via `APPIMAGE_EXTRACT_AND_RUN=1 ./StreamHub-*.AppImage`
  (unpacks to a temp dir on each launch).
- **No offline downloads** — ECS does not support persistent Widevine licenses on Linux.

## Features

- Unified sidebar + one-click service switching
- **Manage your list**: drag to reorder, delete a service (it moves to a separate
  "Removed" window), and click it there to add it back — all saved automatically
- **Pause on switch**: leaving a service pauses its video so nothing plays in the
  background; returning resumes it (unless you'd paused it yourself)
- **Experimental ad blocker** (off by default) — see [Ad blocking](#ad-blocking) below
- Collapsible sidebar (icon rail) to give the video more width
- Persistent, per-service logins (isolated sessions)
- Popup-based sign-in ("Sign in with Google/Apple") works via real child windows
- Fullscreen (F11 / the site's own button; sidebar auto-hides during video fullscreen)
- Media keys (play/pause, and ±10s seek on next/prev) — only while the app is focused
- Picture-in-picture / floating mini-player

## Ad blocking

The sidebar has an **Experimental ad blocker** toggle. It is **off by default**; the choice
is saved with the rest of your settings.

- It blocks **network requests** (ads, trackers) and applies **cosmetic filters** and
  **scriptlets**, using the standard uBlock Origin / EasyList filter syntax — the same
  rules an EasyList + EasyPrivacy setup gives you in a browser.
- uBlock Origin Lite itself can't be installed here: it's a Manifest V3 extension built on
  Chrome's `declarativeNetRequest`, which Electron doesn't implement. So the engine runs
  natively in the main process instead ([`@ghostery/adblocker`](https://github.com/ghostery/adblocker)),
  attached to each service's session.
- The filter engine is downloaded on first enable and cached in your userData dir
  (`adblock-engine.bin`), then refreshed weekly. With no network and no cache, the toggle
  reports the failure and stays off rather than pretending to be on.
- Toggling it reloads the open services, since blocking only affects new requests.

**Caveats, honestly:** it's labelled experimental for a reason.

- **Server-stitched ads still get through.** Where ads are muxed into the video stream
  itself (Hulu's ad tier, Peacock free, some YouTube ads) there is no separate request to
  block. This is the same limit every blocker hits, uBlock Origin Lite included.
- **It may break a service.** An over-broad rule can take out a player or a sign-in flow.
  If a service misbehaves, turn the toggle off and reload.
- Blocking ads on an ad-supported tier may be against that service's terms of use. Your
  call — the feature ships off.

## Run from source

```bash
npm install     # downloads the castLabs ECS binary (bundles Widevine)
npm start
```

First launch downloads and verifies the Widevine component before the window opens.

## Build (AppImage)

```bash
npm run build          # -> dist/StreamHub-<version>.AppImage
```

## Adding or changing services

The built-in list lives in [`src/services.js`](src/services.js) as `DEFAULT_SERVICES`.
Add an entry — `{ id, name, url, color }` — and it appears automatically (the config
loader folds in any new built-in without disturbing a user's existing order or removals).
Your own reordering/removals are saved per-user in `~/.config/streamhub/services.json`,
never in the source.

## Privacy

Everything runs and stays on your machine — there is no account, server, or telemetry.
Logins are stored as ordinary browser cookies under your user config directory
(`~/.config/streamhub/Partitions/<service>@default/`).

Note that Electron stores these cookies **unencrypted** on disk (unlike Chrome, it does
not attach an OS-keyring crypto layer, and no setting changes this). The files are
readable only by your own user, but a **session cookie is a working login** — so do not
sync or back up that config directory to anywhere shared, and don't commit it.

## Legal

This is a personal-use shell around official streaming sites. castLabs ECS is free for
personal/development use; wider redistribution has its own VMP signing/license terms.
Keep the app a shell only — no scraping of protected streams, no key handling.

Licensed under the [MIT License](LICENSE).
