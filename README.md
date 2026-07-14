# StreamHub

One desktop app for the **official** streaming sites — Netflix, Prime Video, Disney+, Max,
Hulu, YouTube, YouTube TV, Apple TV+, Paramount+, Peacock, Crunchyroll, Twitch, Tubi, and any
others you add — instead of a drawer full of browser tabs.

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

- Sidebar with one-click switching; drag to reorder, delete to a "Removed" list, click to
  restore. Collapses to an icon rail.
- **Pause on switch** — leaving a service pauses its video, returning resumes it.
- **Stays signed in**, per service, in isolated sessions. Popup sign-in ("Sign in with
  Google/Apple") works. Right-click a service to sign out and wipe its data.
- **System media controls (MPRIS)** — the KDE/GNOME panel and lock screen drive playback.
  Media keys work while the app is focused.
- **Keeps the screen awake** during playback; picture-in-picture; fullscreen (F11).
- **Remembers where you left off** — window, last service, sidebar state.
- **Settings** (sidebar gear, or `Ctrl+,`) — ad blocker, tray behaviour, updates.
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

## Legal

A personal-use shell around official streaming sites. castLabs ECS is free for
personal/development use; redistribution has its own VMP signing and license terms. Keep it a
shell — no scraping of protected streams, no key handling.

[MIT](LICENSE).
