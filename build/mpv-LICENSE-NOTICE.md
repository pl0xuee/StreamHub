# mpv, bundled with StreamHub

StreamHub is MIT. The `mpv` binary next to this file is not: mpv is free software licensed under
the **GNU General Public License, version 2 or (at your option) any later version**, with parts
under the LGPL-2.1-or-later. Its full licence text is in `mpv-COPYING.txt` in this same
directory. If that file is missing or says PLACEHOLDER, this build must not be distributed —
see the end of this notice.

Copyright © 2000–present the mpv, MPlayer and mplayer2 projects and contributors.

## Why an MIT app may carry a GPL player

StreamHub does not link mpv, statically or dynamically. It starts mpv as a **separate process**
and talks to it over mpv's own JSON IPC socket, the same interface any other program may use
(see `src/mpv.js` in the StreamHub source). The two programs are aggregated on one medium, not
combined into one work, so mpv's licence applies to mpv and StreamHub's MIT licence applies to
StreamHub. Nothing in this bundle relicenses either.

This is also why the code is written the way it is. Using libmpv as a linked native addon would
have been less code; it would also have made the combined binary GPL.

## Where to get the source

mpv's complete corresponding source is upstream at:

**https://github.com/mpv-player/mpv**

The exact version bundled here is recorded at the end of this file, along with the distribution
package it was taken from. Every released version has a matching tag in that repository, and the
distribution's source package (its PKGBUILD, patches and build flags) reproduces the specific
binary, including any patches the distribution applied.

**Written offer.** If you would rather have the source directly, StreamHub will provide the
complete corresponding source for the mpv binary in this bundle — including the scripts used to
control compilation and installation — for a period of three years from the date you received
this software, at no charge beyond the cost of transfer. Ask by opening an issue at
https://github.com/pl0xuee/StreamHub.

## The shared libraries in `lib/`

mpv is not the only thing bundled. `lib/` holds the shared libraries mpv needs that a target
machine may not have, each under its own licence — most notably **FFmpeg**
(https://ffmpeg.org/, LGPL-2.1-or-later, and GPL-2.0-or-later when built with GPL-licensed
encoders such as x264 and x265), libass, libplacebo and the codec libraries. They were taken
unmodified from the distribution that packaged them, and their sources are obtainable from that
distribution and from each project upstream. The offer above extends to these on the same terms.

Libraries belonging to the host system and its graphics drivers are deliberately *not* bundled;
those come from the machine the AppImage runs on.

## If `mpv-COPYING.txt` is a placeholder

The staging script copies the GPL text from the system it stages on
(`/usr/share/licenses/mpv/`, `/usr/share/doc/mpv/`, or the shared SPDX texts). Some
distributions ship no copy for common licences, and then there is nothing to copy. In that case
the text must be added by hand — from `LICENSE.GPL` in the mpv source tree, or from
https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt — before the AppImage is published.
Distributing the binary without it is a licence violation, not a formality.
