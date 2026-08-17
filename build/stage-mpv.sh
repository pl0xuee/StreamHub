#!/usr/bin/env bash
# Collects the system mpv, and the libraries it needs that a target machine may not have, into
# build/mpv-staging/ so electron-builder can ship it as resources/mpv/ inside the AppImage.
#
# Why this exists at all: Jellyfin playback goes through mpv (see src/mpv.js), and a user who
# downloads an AppImage has not agreed to install anything else. src/mpv.js already prefers
# `resourcesPath/mpv/mpv` and falls back to whatever mpv is on PATH, so bundling is purely
# additive — this script is what fills that path in.
#
# To build a bundled AppImage:
#
#     npm run stage:mpv    # fills build/mpv-staging/ from the system mpv
#     npm run build        # -> dist/StreamHub.AppImage, now with mpv inside
#
# To build the way the project always has, shipping no mpv and using the user's own:
#
#     npm run build        # build/mpv-staging/ is empty; nothing lands in resources/mpv/
#
# Two things about the result are worth knowing before shipping one:
#
#   * It is only as portable as the machine that staged it. Everything here was compiled against
#     this host's glibc, and glibc is forward- but not backward-compatible, so an AppImage staged
#     on a rolling distro will not start on an older LTS. Stage on the oldest system you intend
#     to support.
#   * It is GPL software travelling with an MIT app. That is legal — StreamHub spawns mpv as a
#     separate process rather than linking it — but only if the licence and an offer of source
#     travel with it, which is what the notice copied in below is for. Do not delete it.
#
# Nothing here is downloaded. The source is the mpv already installed on this machine, which is
# also why the version stamped into the shipped notice is read back off the binary rather than
# assumed.
set -euo pipefail

build_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
staging="$build_dir/mpv-staging"
lib_dir="$staging/lib"

# Overridable so a release build can stage from a chroot or an older container without editing
# this file.
mpv_bin=${MPV_BIN:-/usr/bin/mpv}

if [ ! -x "$mpv_bin" ]; then
  echo "stage-mpv: no executable mpv at $mpv_bin (set MPV_BIN to point at one)" >&2
  exit 1
fi

# Which libraries must come from the host rather than from us.
#
# This is the whole difficulty of bundling a video player. Two groups, for two different reasons:
#
#   * The C runtime and the compiler runtime (libc, libm, libpthread, libdl, ld.so, libstdc++,
#     libgcc_s and their siblings). Half the process is host code — the GL driver, dbus, the
#     compositor's client libraries — and it is all linked against the host's copies. Shipping a
#     second libstdc++ into the same process is the classic way to make Mesa fail to load.
#   * The graphics and driver stack: X11, xcb, Wayland, GL/EGL/Vulkan, VA-API, VDPAU, libdrm,
#     gbm, xkbcommon. These are not really libraries so much as the front door to the user's
#     hardware; the vendor driver on the machine is the only thing that matches them. Bundle
#     these and hardware decoding stops working, which for the files mpv is here to play is
#     worse than not bundling mpv at all.
#
# Everything else — ffmpeg, libplacebo, libass, the codecs, the audio backends — is ours to
# carry, because it is exactly the set a machine without mpv installed will not have.
is_host_library() {
  case "$1" in
    ld-linux*|ld.so*|linux-vdso*|linux-gate*) return 0 ;;
    libc.so.*|libm.so.*|libdl.so.*|libpthread.so.*|librt.so.*|libutil.so.*) return 0 ;;
    libresolv.so.*|libnsl.so.*|libanl.so.*|libmvec.so.*|libBrokenLocale.so.*) return 0 ;;
    libstdc++.so.*|libgcc_s.so.*|libgomp.so.*|libatomic.so.*|libquadmath.so.*|libitm.so.*) return 0 ;;
    libX11*|libXext*|libXfixes*|libXrandr*|libXrender*|libXss*|libXv*|libXpresent*) return 0 ;;
    libXau*|libXdmcp*|libXcursor*|libXi*|libXinerama*|libXxf86vm*|libICE*|libSM*) return 0 ;;
    libxcb*|libwayland-*|libxkbcommon*) return 0 ;;
    libGL*|libEGL*|libOpenGL*|libGLX*|libGLdispatch*|libglapi*|libgbm*|libdrm*) return 0 ;;
    libvulkan*|libOpenCL*|libva*|libvdpau*|libnvidia*|libcuda*) return 0 ;;
    *) return 1 ;;
  esac
}

rm -rf "$staging"
mkdir -p "$lib_dir"
# The directory is checked in (empty) so electron-builder's extraResources source always exists,
# and re-staging must not quietly delete that marker along with the old libraries.
touch "$staging/.gitkeep"

version_line=$("$mpv_bin" --version | head -n 1)
echo "stage-mpv: staging $mpv_bin"
echo "stage-mpv:   $version_line"

# `ldd` prints the whole transitive closure already resolved, which is the point of using it
# rather than walking DT_NEEDED ourselves: what it lists is what this machine's loader would
# actually open. Three shapes turn up in its output — "soname => /path", a bare "/path" for a
# library linked by absolute name, and "linux-vdso.so.1" with no path at all — so parse for a
# path rather than a column.
missing=0
staged=0
skipped=0

while IFS= read -r line; do
  case "$line" in
    *"not found"*)
      echo "stage-mpv: WARNING unresolved dependency: ${line#"${line%%[![:space:]]*}"}" >&2
      missing=$((missing + 1))
      continue
      ;;
  esac

  if [[ "$line" == *"=>"* ]]; then
    src=${line#*=> }
  else
    src=${line#"${line%%[![:space:]]*}"}
  fi
  src=${src% (0x*}
  src=${src%"${src##*[![:space:]]}"}
  [ -n "$src" ] || continue
  [ "${src:0:1}" = "/" ] || continue

  soname=$(basename "$src")
  if is_host_library "$soname"; then
    skipped=$((skipped + 1))
    continue
  fi

  # -L because a distro's libfoo.so.8 is usually a symlink onto libfoo.so.8.3.2; we want the
  # bytes, under the soname the loader will ask for.
  cp -L "$src" "$lib_dir/$soname"
  chmod 0755 "$lib_dir/$soname"
  staged=$((staged + 1))
done < <(ldd "$mpv_bin")

if [ "$missing" -gt 0 ]; then
  echo "stage-mpv: $missing dependencies could not be resolved on this machine; aborting" >&2
  exit 1
fi

cp -L "$mpv_bin" "$staging/mpv.bin"
chmod 0755 "$staging/mpv.bin"

# The wrapper, not an rpath.
#
# patchelf would let us stamp a $ORIGIN rpath into every file and drop the wrapper, but it is not
# installed everywhere and this script is meant to need nothing but coreutils. A two-line sh
# wrapper does the same job with no build dependency.
#
# LD_LIBRARY_PATH is *prepended*, so the bundled ffmpeg wins over an older one on the host —
# without that the bundle is only half itself, and mismatched halves of ffmpeg are worse than
# either. The libraries deliberately left out above still resolve to the host's, because they
# are not in this directory for the loader to find.
#
# It is named `mpv`, with the real ELF binary alongside as `mpv.bin`, because src/mpv.js spawns
# resources/mpv/mpv and must find something executable there.
cat > "$staging/mpv" <<'WRAPPER'
#!/bin/sh
# Runs the bundled mpv against the bundled libraries. Generated by build/stage-mpv.sh.
# readlink -f so this still works when the AppImage mounts us somewhere else, or a symlink
# points here.
here=$(dirname "$(readlink -f "$0")")
LD_LIBRARY_PATH="$here/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
exec "$here/mpv.bin" "$@"
WRAPPER
chmod 0755 "$staging/mpv"

# --- Licence, which is not optional ---------------------------------------------------------
#
# mpv is GPL-2.0-or-later. Shipping the binary without its licence text and an offer of source
# is a licence violation, so the notice and the licence go in the same directory as the binary
# and travel with it into the AppImage.
notice_src="$build_dir/mpv-LICENSE-NOTICE.md"
if [ ! -f "$notice_src" ]; then
  echo "stage-mpv: $notice_src is missing; it must ship with the binary" >&2
  exit 1
fi
cp "$notice_src" "$staging/mpv-LICENSE-NOTICE.md"

# Stamp the notice with what was actually staged, rather than leaving the checked-in copy
# claiming a version it cannot know.
package_line="unknown (mpv not installed by a package manager, or pacman unavailable)"
if command -v pacman >/dev/null 2>&1; then
  package_line=$(pacman -Qo "$mpv_bin" 2>/dev/null || echo "$package_line")
fi
{
  echo
  echo "## The build in this AppImage"
  echo
  echo '```'
  echo "binary:  $mpv_bin"
  echo "version: $version_line"
  echo "package: $package_line"
  echo "staged:  $(date -u '+%Y-%m-%dT%H:%M:%SZ') on $(uname -srm)"
  echo '```'
} >> "$staging/mpv-LICENSE-NOTICE.md"

# The licence text itself is copied from the system, never written by us. Arch-family packages
# omit a copy for common licences and lean on the shared SPDX texts, so try those in turn.
license_copied=""
for candidate in \
  /usr/share/licenses/mpv/COPYING \
  /usr/share/licenses/mpv/LICENSE \
  /usr/share/doc/mpv/COPYING \
  /usr/share/doc/mpv/LICENSE \
  /usr/share/licenses/common/GPL2/license.txt \
  /usr/share/licenses/spdx/GPL-2.0-or-later.txt \
  /usr/share/licenses/spdx/GPL-2.0-only.txt; do
  if [ -f "$candidate" ]; then
    cp "$candidate" "$staging/mpv-COPYING.txt"
    license_copied="$candidate"
    break
  fi
done

if [ -z "$license_copied" ]; then
  cat > "$staging/mpv-COPYING.txt" <<'PLACEHOLDER'
PLACEHOLDER — THIS BUILD IS NOT DISTRIBUTABLE AS IT STANDS.

No copy of the GNU General Public License version 2 was found on the machine that staged this
bundle, so none could be copied here. mpv is GPL-2.0-or-later and may not be redistributed
without it.

Replace this file with the text of the GPL, taken from the mpv source tree (LICENSE.GPL in
https://github.com/mpv-player/mpv) or from https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt,
before publishing an AppImage built from this staging directory.
PLACEHOLDER
fi

total=$(du -sh "$staging" | cut -f1)
echo "stage-mpv: staged $staged libraries, left $skipped to the host"
echo "stage-mpv:   $staging/mpv           wrapper (this is what StreamHub spawns)"
echo "stage-mpv:   $staging/mpv.bin       the binary"
echo "stage-mpv:   $staging/lib/          $staged shared libraries"
if [ -n "$license_copied" ]; then
  echo "stage-mpv:   $staging/mpv-COPYING.txt   GPL text, from $license_copied"
else
  echo "stage-mpv:   $staging/mpv-COPYING.txt   *** PLACEHOLDER — add the GPL text before shipping ***" >&2
fi
echo "stage-mpv:   $staging/mpv-LICENSE-NOTICE.md   licence notice and source offer"
echo "stage-mpv: total $total — it will all land in the AppImage under resources/mpv/"
echo "stage-mpv: now run: npm run build"
