#!/bin/bash
# Desktop CI (.github/workflows/desktop-ci.yml, job `installers-linux`): an installed package's app
# starts, listens and stays up under a headless display server, one of
#
#   bash scripts/ci/desktop-linux-launch-smoke.sh x11 <command...>       Xvfb (xvfb-run)
#   bash scripts/ci/desktop-linux-launch-smoke.sh wayland <command...>   Weston's headless backend
#
# The Wayland leg unsets DISPLAY and sets GDK_BACKEND=wayland, so GTK cannot fall back to X11: the
# app either reaches the compositor or exits. Both run the app in its own D-Bus session and its own
# process group, killed as a group at the end. Runs on the runner (the .deb) and inside a Fedora
# container (the .rpm), so it needs only bash, coreutils, util-linux's setsid and the display
# server: xvfb-run + xauth, or weston.
set -euo pipefail

mode="${1:?usage: $0 x11|wayland <command...>}"
shift
[ "$#" -gt 0 ] || { echo "usage: $0 x11|wayland <command...>" >&2; exit 2; }

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/linux-launch.XXXXXX")"
TIMEOUT="${LAUNCH_SMOKE_TIMEOUT_S:-120}"
STAY=5
log="$TMP/app.log"
: >"$log"
compositor=""

die() {
  echo "::error::$*" >&2
  exit 1
}

command -v dbus-run-session >/dev/null || die "dbus-run-session not installed"
command -v setsid >/dev/null || die "setsid (util-linux) not installed"

case "$mode" in
  x11)
    command -v xvfb-run >/dev/null || die "xvfb-run not installed"
    setsid xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- "$@" >"$log" 2>&1 &
    pid=$!
    ;;
  wayland)
    command -v weston >/dev/null || die "weston not installed"
    export XDG_RUNTIME_DIR="$TMP/xdg"
    mkdir -m 0700 "$XDG_RUNTIME_DIR"
    socket=denext-smoke
    # The pixman renderer draws clients' shm buffers in memory: no GPU, no DRM device. Weston 12+
    # spells it --renderer=pixman, older releases --use-pixman.
    renderer=(--renderer=pixman)
    weston --help 2>&1 | grep -q -- '--renderer' || renderer=(--use-pixman)
    weston --backend=headless "${renderer[@]}" --socket="$socket" --width=1280 --height=800 \
      --idle-time=0 >"$TMP/weston.log" 2>&1 &
    compositor=$!
    for _ in $(seq 1 50); do
      [ -S "$XDG_RUNTIME_DIR/$socket" ] && break
      kill -0 "$compositor" 2>/dev/null || { cat "$TMP/weston.log"; die "weston exited before it listened"; }
      sleep 0.2
    done
    [ -S "$XDG_RUNTIME_DIR/$socket" ] || { cat "$TMP/weston.log"; die "weston did not create its socket"; }
    echo "weston: $(head -n 3 "$TMP/weston.log" | tr '\n' ' ')"
    # No DISPLAY: under Wayland only, GTK must reach the compositor or fail.
    setsid env -u DISPLAY WAYLAND_DISPLAY="$socket" GDK_BACKEND=wayland \
      dbus-run-session -- "$@" >"$log" 2>&1 &
    pid=$!
    ;;
  *) die "unknown mode $mode (x11 or wayland)" ;;
esac

stop() {
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [ -n "$compositor" ]; then
    kill -TERM "$compositor" 2>/dev/null || true
    wait "$compositor" 2>/dev/null || true
  fi
}
fail() {
  stop
  cat "$log"
  [ -z "$compositor" ] || cat "$TMP/weston.log"
  die "$*"
}

waited=0
while ! grep -q 'Listening on ' "$log"; do
  kill -0 "$pid" 2>/dev/null || fail "the app exited before it started listening ($mode)"
  [ "$waited" -lt "$TIMEOUT" ] || fail "the app did not start listening within ${TIMEOUT}s ($mode)"
  sleep 1
  waited=$((waited + 1))
done
echo "ready after ${waited}s: $(grep -m1 'Listening on ' "$log")"
# Up with its window: it must not die while the page loads.
sleep "$STAY"
kill -0 "$pid" 2>/dev/null || fail "the app exited within ${STAY}s of listening ($mode)"
stop
cat "$log"
if grep -q NotCapable "$log"; then die "the app hit a permission error (NotCapable)"; fi
if [ "$mode" = wayland ] && grep -Eiq 'cannot open display|Failed to open display|Gtk-WARNING.*cannot open' "$log"; then
  die "GTK did not reach the Wayland compositor"
fi
echo "launch ($mode): $* launched, listened and stayed up"
