#!/bin/bash
# Desktop CI's AppImage smoke (.github/workflows/desktop-ci.yml, job `linux-appimage-smoke`), one
# phase per step:
#
#   bash scripts/ci/desktop-appimage-smoke.sh appimagetool      the pinned appimagetool on PATH
#   bash scripts/ci/desktop-appimage-smoke.sh libnode           the libnode addon check, on real ELF addons
#   bash scripts/ci/desktop-appimage-smoke.sh inspect <dist>    the AppImage's entry, icon, metainfo, AppStream
#   bash scripts/ci/desktop-appimage-smoke.sh launch <dist>     the AppImage starts, listens and stays up
#
# <dist> holds exactly one `*.AppImage` (what `denext desktop package --format appimage` wrote).
# No FUSE in a container (no /dev/fuse): the AppImage is run with `--appimage-extract-and-run`, and
# appimagetool (itself an AppImage) is unpacked once and run from its AppDir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/appimage-smoke"
mkdir -p "$TMP"

# appimagetool 1.9.1 (2025-11-18), x86_64, by the SHA-256 GitHub records for the release asset.
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"

# The soname the stub libnode carries (Node 20's ABI; the check accepts any libnode.so[.N]*).
LIBNODE_SONAME="libnode.so.115"

die() {
  echo "::error::$*" >&2
  exit 1
}

# Whether this machine can mount an AppImage (FUSE device usable and a fusermount helper).
have_fuse() {
  [ -r /dev/fuse ] && [ -w /dev/fuse ] && { command -v fusermount3 || command -v fusermount; } >/dev/null 2>&1
}

# The single *.AppImage in $1, as an absolute path.
the_appimage() {
  local dist="$1" found=()
  shopt -s nullglob
  found=("$dist"/*.AppImage)
  shopt -u nullglob
  [ "${#found[@]}" -eq 1 ] || die "expected one .AppImage in $dist, found ${#found[@]}: ${found[*]:-none}"
  (cd "$(dirname "${found[0]}")" && echo "$PWD/$(basename "${found[0]}")")
}

phase_appimagetool() {
  local dir="$TMP/appimagetool" bin="$TMP/bin"
  rm -rf "$dir" && mkdir -p "$dir" "$bin"
  curl -fsSL --retry 3 -o "$dir/appimagetool.AppImage" "$APPIMAGETOOL_URL"
  echo "$APPIMAGETOOL_SHA256  $dir/appimagetool.AppImage" | sha256sum -c -
  chmod +x "$dir/appimagetool.AppImage"
  # Unpacked: no FUSE needed to run it, here or in a container.
  (cd "$dir" && ./appimagetool.AppImage --appimage-extract >/dev/null)
  [ -x "$dir/squashfs-root/AppRun" ] || die "appimagetool did not unpack to $dir/squashfs-root"
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$dir/squashfs-root/AppRun" >"$bin/appimagetool"
  chmod +x "$bin/appimagetool"
  "$bin/appimagetool" --version 2>&1 | head -3 || true
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >>"$GITHUB_PATH"; fi
  echo "appimagetool: $bin/appimagetool"
}

phase_libnode() {
  local dir="$TMP/libnode"
  rm -rf "$dir" && mkdir -p "$dir"
  command -v cc >/dev/null || die "no C compiler (cc) for the addon fixture"
  command -v readelf >/dev/null || die "no readelf (binutils): the check would only note the addons"
  # A stub of a distribution's shared Node.js: one N-API-shaped symbol, the libnode soname.
  cat >"$dir/libnode.c" <<'EOF'
int napi_module_register_stub(void) { return 0; }
EOF
  # Two addons: one that calls into libnode (so it NEEDs it), one that resolves nothing from it.
  cat >"$dir/linked.c" <<'EOF'
extern int napi_module_register_stub(void);
int napi_register_module_v1(void) { return napi_module_register_stub(); }
EOF
  cat >"$dir/plain.c" <<'EOF'
int napi_register_module_v1(void) { return 0; }
EOF
  cc -shared -fPIC -Wl,-soname,"$LIBNODE_SONAME" -o "$dir/$LIBNODE_SONAME" "$dir/libnode.c"
  ln -sf "$LIBNODE_SONAME" "$dir/libnode.so"
  cc -shared -fPIC -o "$dir/linked.node" "$dir/linked.c" -Wl,--no-as-needed -L"$dir" -lnode
  cc -shared -fPIC -o "$dir/plain.node" "$dir/plain.c"
  readelf -d "$dir/linked.node" | grep -F "[$LIBNODE_SONAME]" ||
    die "the fixture addon does not NEED $LIBNODE_SONAME"
  if readelf -d "$dir/plain.node" | grep -F libnode; then die "the plain addon NEEDs libnode"; fi
  deno run -A "$ROOT/scripts/ci/desktop-libnode-check.ts" "$dir/linked.node" "$dir/plain.node" "$LIBNODE_SONAME"
}

# `key=value` of the [Desktop Entry] group of the .desktop file $1 for key $2 (empty when unset).
desktop_key() {
  awk -v key="$2" '
    /^\[/ { group = $0; next }
    group == "[Desktop Entry]" && index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$1"
}

phase_inspect() {
  local appimage root entries entry id name icon categories metainfo
  appimage="$(the_appimage "$1")"
  chmod +x "$appimage"
  rm -rf "$TMP/extract" && mkdir -p "$TMP/extract"
  # --appimage-extract needs no FUSE: the type2 runtime unpacks its own squashfs.
  (cd "$TMP/extract" && "$appimage" --appimage-extract >/dev/null)
  root="$TMP/extract/squashfs-root"
  [ -d "$root" ] || die "$appimage did not extract to $root"
  ls -la "$root" "$root/usr/share/applications" "$root/usr/share/metainfo" || true

  # The AppDir's own entry: exactly one .desktop at its root, the same under usr/share/applications.
  shopt -s nullglob
  entries=("$root"/*.desktop)
  shopt -u nullglob
  [ "${#entries[@]}" -eq 1 ] || die "expected one .desktop at the AppDir root, found ${#entries[@]}"
  entry="${entries[0]}"
  id="$(basename "$entry" .desktop)"
  cmp "$entry" "$root/usr/share/applications/$id.desktop" ||
    die "usr/share/applications/$id.desktop differs from the root entry"
  cat "$entry"
  name="$(desktop_key "$entry" Name)"
  icon="$(desktop_key "$entry" Icon)"
  categories="$(desktop_key "$entry" Categories)"
  [ -n "$name" ] || die "$id.desktop has no Name="
  [ -n "$icon" ] || die "$id.desktop has no Icon="
  [ -n "$categories" ] || die "$id.desktop has no Categories="
  [ "$icon" != AppIcon ] || die "$id.desktop still names the placeholder Icon=AppIcon"
  [ -f "$root/$icon.png" ] || [ -f "$root/$icon.svg" ] || die "Icon=$icon has no $icon.png / .svg in the AppDir"
  [ -e "$root/.DirIcon" ] || die "the AppDir has no .DirIcon"
  [ -x "$root/AppRun" ] || die "the AppDir has no executable AppRun"
  if command -v desktop-file-validate >/dev/null; then
    desktop-file-validate "$entry"
  else
    echo "::notice::desktop-file-validate not installed; the entry's keys were checked by hand"
  fi
  echo "entry: $id.desktop — Name=$name, Icon=$icon, Categories=$categories"

  # The AppStream metainfo: present, well-formed, a desktop-application naming this entry.
  shopt -s nullglob
  metainfo=("$root"/usr/share/metainfo/*.metainfo.xml "$root"/usr/share/metainfo/*.appdata.xml)
  shopt -u nullglob
  [ "${#metainfo[@]}" -ge 1 ] || die "no usr/share/metainfo/*.metainfo.xml (or .appdata.xml) in the AppDir"
  for m in "${metainfo[@]}"; do
    python3 -I - "$m" "$root/usr/share/applications" <<'EOF'
import os
import sys
import xml.etree.ElementTree as ET

path, apps = sys.argv[1], sys.argv[2]
root = ET.parse(path).getroot()  # raises (exit 1) on malformed XML
problems = []
if root.tag != "component":
    problems.append(f"root element is <{root.tag}>, not <component>")
if root.get("type") != "desktop-application":
    problems.append(f'component type is {root.get("type")!r}, not "desktop-application"')
for tag in ("id", "name", "summary", "metadata_license"):
    if not (root.findtext(tag) or "").strip():
        problems.append(f"no <{tag}>")
launchables = [l.text for l in root.findall("launchable") if l.get("type") == "desktop-id"]
if not launchables:
    problems.append('no <launchable type="desktop-id">')
for l in launchables:
    if not os.path.isfile(os.path.join(apps, l or "")):
        problems.append(f"launchable {l!r} is not in usr/share/applications")
if problems:
    print(f"{path}: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"metainfo: {os.path.basename(path)} is well-formed (id {root.findtext('id')})")
EOF
  done

  # AppStream's own validator over the AppDir. Installed here, after packaging, so appimagetool's
  # optional appstreamcli run never decided the build. Errors fail; warnings are reported.
  if ! command -v appstreamcli >/dev/null; then
    { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends appstream; } >/dev/null 2>&1 || true
  fi
  if command -v appstreamcli >/dev/null; then
    local out code=0
    out="$(appstreamcli validate-tree --no-net --explain "$root" 2>&1)" || code=$?
    # shellcheck disable=SC2001 # a regex (colour escapes), not a fixed string
    out="$(sed 's/\x1b\[[0-9;]*m//g' <<<"$out")"
    printf '%s\n' "$out"
    if grep -E '^[[:space:]]*E: ' <<<"$out" >/dev/null; then
      die "appstreamcli validate-tree reports errors in the AppDir (exit $code)"
    fi
    [ "$code" -eq 0 ] || echo "::notice::appstreamcli validate-tree exited $code with warnings only"
  else
    echo "::notice::appstreamcli not available (apt install appstream failed); skipped validate-tree"
  fi
  echo "inspect: $appimage ok"
}

phase_launch() {
  local appimage log pid args=() timeout="${APPIMAGE_SMOKE_TIMEOUT_S:-120}" stay=5 waited=0
  appimage="$(the_appimage "$1")"
  chmod +x "$appimage"
  if have_fuse; then
    echo "FUSE available: mounting the AppImage"
  else
    echo "no usable FUSE (/dev/fuse): --appimage-extract-and-run"
    args=(--appimage-extract-and-run)
  fi
  command -v xvfb-run >/dev/null || die "xvfb-run not installed (apt install xvfb xauth)"
  command -v dbus-run-session >/dev/null || die "dbus-run-session not installed (apt install dbus)"
  log="$TMP/launch.log"
  : >"$log"
  # Its own session and process group: the extract-and-run runtime forks AppRun, so killing the
  # group (Xvfb, D-Bus, the runtime, the app and its server) leaves nothing behind. A script's
  # background job is not a group leader (no job control), so setsid does not fork: $! leads it.
  setsid xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- "$appimage" "${args[@]}" >"$log" 2>&1 &
  pid=$!
  stop() {
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  }
  # The app's server is up (what desktop-launch-smoke.ts / desktop-run-smoke.ts wait for).
  while ! grep -q 'Listening on ' "$log"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      stop
      cat "$log"
      die "the AppImage exited before it started listening"
    fi
    if [ "$waited" -ge "$timeout" ]; then
      stop
      cat "$log"
      die "the AppImage did not start listening within ${timeout}s"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "ready after ${waited}s: $(grep -m1 'Listening on ' "$log")"
  # Up with its window: it must not die while the page loads.
  sleep "$stay"
  if ! kill -0 "$pid" 2>/dev/null; then
    stop
    cat "$log"
    die "the AppImage exited within ${stay}s of listening"
  fi
  stop
  cat "$log"
  if grep -q NotCapable "$log"; then die "the app hit a permission error (NotCapable)"; fi
  echo "launch: $appimage launched, listened and stayed up"
}

case "${1:-}" in
  appimagetool) phase_appimagetool ;;
  libnode) phase_libnode ;;
  inspect) phase_inspect "${2:?usage: inspect <dist>}" ;;
  launch) phase_launch "${2:?usage: launch <dist>}" ;;
  *)
    echo "usage: $0 appimagetool | libnode | inspect <dist> | launch <dist>" >&2
    exit 2
    ;;
esac
