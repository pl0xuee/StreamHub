# StreamHub

A desktop app that wraps the **official** streaming websites (Netflix, Prime Video,
Disney+, Max, Hulu, YouTube, Apple TV+, Paramount+, Peacock, Crunchyroll, Twitch, Tubi,
and any others you add) behind one unified, gunmetal-grey UI — so you get an app-like
experience instead of juggling browser tabs.

Playback happens on each service's own website using its own DRM. **No DRM is
circumvented, extracted, or bypassed** — the app is a purpose-built Chromium shell
that hosts the official web players.

## Download

Grab the latest build from the [Releases](https://github.com/pl0xuee/StreamHub/releases) page:

- **Linux** — `StreamHub-*.AppImage` (needs the **FUSE 2** runtime; see [Requirements](#requirements--limits)).
- **Windows** — `StreamHub Setup *.exe` (an installer).

Both are built automatically by CI on each tagged release (see [Building](#build)).

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

## Requirements & limits

- **Resolution caps at ~720p** on the DRM services. Netflix and most services require
  hardware DRM (Widevine L1 + HDCP) for 1080p/4K, which the Widevine software path
  (Linux, and Chrome on Windows) doesn't provide — 1080p on those needs Edge/PlayReady.
  It is a platform limit, not an app bug. (YouTube, Twitch and other non-DRM services can
  go higher via their own quality menus.)
- **Linux — FUSE 2 is needed to run the AppImage** (`libfuse.so.2`), which many current
  distros no longer ship by default:
  - Arch/CachyOS: `sudo pacman -S fuse2`
  - Debian/Ubuntu: `sudo apt install libfuse2`
  - Fedora: `sudo dnf install fuse`

  Or run it without FUSE via `APPIMAGE_EXTRACT_AND_RUN=1 ./StreamHub-*.AppImage`
  (unpacks to a temp dir on each launch).
- **Windows — the installer is unsigned**, so SmartScreen shows an "unknown publisher"
  warning on first run (click *More info → Run anyway*). An Authenticode certificate would
  remove it.
- **No offline downloads** — ECS does not support persistent Widevine licenses.

## Features

- Unified sidebar + one-click service switching
- **Manage your list**: drag to reorder, delete a service (it moves to a separate
  "Removed" window), and click it there to add it back — all saved automatically
- **Pause on switch**: leaving a service pauses its video so nothing plays in the
  background; returning resumes it (unless you'd paused it yourself)
- Collapsible sidebar (icon rail) to give the video more width
- Persistent, per-service logins (isolated sessions)
- Popup-based sign-in ("Sign in with Google/Apple") works via real child windows
- Fullscreen (F11 / the site's own button; sidebar auto-hides during video fullscreen)
- Media keys (play/pause, and ±10s seek on next/prev) — only while the app is focused
- Picture-in-picture / floating mini-player

## Run from source

```bash
npm install     # downloads the castLabs ECS binary (bundles Widevine)
npm start
```

First launch downloads and verifies the Widevine component before the window opens.

## Build

Build on the target OS (the castLabs Electron binary is platform-specific, so build Linux
on Linux and Windows on Windows):

```bash
npm run build          # Linux   -> dist/StreamHub-<version>.AppImage
npm run build:win      # Windows -> dist/StreamHub Setup <version>.exe
```

### Automated releases (GitHub Actions)

`.github/workflows/release.yml` builds **both** the Linux AppImage and the Windows
installer and attaches them to the GitHub release. Push a version tag to trigger it:

```bash
npm version patch      # bumps package.json and creates a git tag
git push --follow-tags # pushes the commit and the tag -> CI builds + publishes
```

(Run the workflow manually from the Actions tab to test a build without publishing.)

### Windows + Widevine (VMP signing)

For **protected playback to work in the packaged Windows build**, the app must be
VMP-signed with a free [castLabs EVS](https://castlabs.com/evs/) account — electron-builder's
repackaging invalidates the stock signature. Add two repository secrets and CI signs the
Windows build automatically (`build/afterPack.cjs`):

- `EVS_ACCOUNT_NAME`
- `EVS_PASSWD`

Without them the Windows installer still builds, but DRM won't play until it's signed.
Linux needs no signing — the stock ECS signature works there.

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
