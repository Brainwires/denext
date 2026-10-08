#!/bin/sh
# Run a command in a nested desktop session with the window manager (or Wayland compositor) of your
# choice, so the window test covers tiling and stacking window managers without switching the real
# login session (and without a VM):
#
#   e2e/wm-session.sh --wm i3 -- deno task test:window
#   e2e/wm-session.sh --wm openbox -- deno task test:window --backend cef
#   e2e/wm-session.sh --wm xfwm4 --display xephyr -- deno task test:window
#   e2e/wm-session.sh --wayland weston -- sh -c 'deno task drive start && deno task drive probe;
#     deno task drive stop'
#
# The session ends when the command does (drive mode runs as one `sh -c`). Headless Wayland
# compositors give no client keyboard focus, which the window test's clipboard checks need: run the
# window test in an X11 session, and drive mode in either.
#
# X11 (`--wm <name>`): a private X server, `--display xvfb` (the default: headless, for SSH and CI)
# or `--display xephyr` (a nested window on your current $DISPLAY, to watch it), 1920x1080, and
# the window manager:
#
#   i3        tiling; i3bar runs with its XEmbed system tray (the runtime's tray on X11)
#   openbox   stacking
#   xfwm4     stacking (as linux-session.sh, which CI runs)
#   <other>   any window manager binary that sets _NET_SUPPORTING_WM_CHECK (fluxbox, icewm, …)
#
# Wayland (`--wayland <compositor>`), headless backends:
#
#   weston    stacking (its desktop shell); dunst draws on a hidden Xvfb (weston has no layer
#             shell), so Xvfb is needed too
#   sway      tiling (wlroots)
#
# Every session also gets what linux-session.sh gives the window test: a private D-Bus session bus,
# gnome-keyring's Secret Service unlocked with a known password, and dunst (a notification server
# whose `dunstctl` the drive mode's `click-notification` uses), with XDG_DATA_HOME /
# XDG_CONFIG_HOME in a scratch folder (KITCHEN_SINK_XDG, else a temp dir) and XDG_RUNTIME_DIR in a
# private one, so your own keyring, its sockets and your settings are never touched. XDG_SESSION_TYPE and XDG_CURRENT_DESKTOP name the session. The
# command starts once the window manager is up (X11: it set _NET_SUPPORTING_WM_CHECK on the root
# window; Wayland: the compositor's socket exists) and the bus has a Secret Service and a
# notification server, polled every 0.1 s for up to 30 s. Everything the script started stops when
# the command exits, and the script exits with the command's status.
#
# Dependencies (Debian / Ubuntu package names; the README's "Window managers" section has a
# container recipe):
#
#   always    dbus (dbus-run-session), x11-utils (xprop), gnome-keyring, libsecret-1-0, dunst
#   X11       xvfb (Xvfb) or xserver-xephyr (Xephyr), and the window manager: i3-wm, openbox,
#             xfwm4, …
#   Wayland   weston, or sway
#   the app   libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0 libayatana-appindicator3-1 (WebView),
#             libglib2.0-bin (gio, which moveToTrash runs);
#             CEF also needs libnss3 libatk-bridge2.0-0 libcups2 libxkbcommon0 libgbm1 libasound2t64
set -eu

usage() {
  sed -n '2,14p' "$0" >&2
  exit 2
}

wm=""
wayland=""
display="xvfb"
while [ $# -gt 0 ]; do
  case "$1" in
    --wm) wm="${2:?--wm needs a window manager}"; shift 2 ;;
    --wm=*) wm="${1#--wm=}"; shift ;;
    --wayland) wayland="${2:?--wayland needs a compositor}"; shift 2 ;;
    --wayland=*) wayland="${1#--wayland=}"; shift ;;
    --display) display="${2:?--display needs xvfb or xephyr}"; shift 2 ;;
    --display=*) display="${1#--display=}"; shift ;;
    --) shift; break ;;
    -h | --help) usage ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || usage
if [ -n "$wm" ] && [ -n "$wayland" ]; then
  echo "wm-session: --wm (X11) and --wayland pick different sessions: choose one" >&2
  exit 2
fi
[ -n "$wm" ] || [ -n "$wayland" ] || wm="xfwm4"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "wm-session: $1 is required ($2)" >&2; exit 1; }
}
need dbus-run-session "dbus"
need dbus-send "dbus"
need gnome-keyring-daemon "gnome-keyring"
if [ -n "$wm" ]; then
  case "$display" in
    xvfb) need Xvfb "xvfb" ;;
    xephyr)
      need Xephyr "xserver-xephyr"
      [ -n "${DISPLAY:-}" ] || { echo "wm-session: Xephyr needs a \$DISPLAY to open on" >&2; exit 1; }
      ;;
    *) echo "wm-session: --display is xvfb or xephyr (got $display)" >&2; exit 2 ;;
  esac
  need xprop "x11-utils"
  need "$wm" "the window manager"
else
  case "$wayland" in
    weston | sway) need "$wayland" "the compositor" ;;
    *) echo "wm-session: --wayland is weston or sway (got $wayland)" >&2; exit 2 ;;
  esac
fi

scratch="$(mktemp -d)"
xdg="${KITCHEN_SINK_XDG:-$scratch/xdg}"
mkdir -p "$xdg/data/keyrings" "$xdg/config" "$scratch/run"
chmod 700 "$scratch/run"
export XDG_DATA_HOME="$xdg/data" XDG_CONFIG_HOME="$xdg/config"
# A private runtime dir too: the nested gnome-keyring's control socket must not replace the real
# session's ($XDG_RUNTIME_DIR/keyring/control).
export XDG_RUNTIME_DIR="$scratch/run"
# A default collection named "login", created and unlocked with a known password (a prompt has no
# one to answer it here).
printf login >"$XDG_DATA_HOME/keyrings/default"
export WMS_WM="$wm" WMS_WAYLAND="$wayland" WMS_DISPLAY="$display" WMS_SCRATCH="$scratch"

status=0
dbus-run-session -- sh -c '
  set -u
  pids=""
  cleanup() {
    for p in $pids; do kill "$p" 2>/dev/null || true; done
    wait 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
  log="$WMS_SCRATCH/session.log"
  if [ -n "$WMS_WM" ]; then
    # The first free display number from :90 (a lock file or a socket means taken).
    n=90
    while [ -e "/tmp/.X$n-lock" ] || [ -e "/tmp/.X11-unix/X$n" ]; do n=$((n + 1)); done
    if [ "$WMS_DISPLAY" = xephyr ]; then
      Xephyr ":$n" -screen 1920x1080 -br -ac -nolisten tcp -noreset >>"$log" 2>&1 &
    else
      Xvfb ":$n" -screen 0 1920x1080x24 -ac -nolisten tcp -noreset >>"$log" 2>&1 &
    fi
    pids="$!"
    export DISPLAY=":$n" XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP="$WMS_WM"
    unset WAYLAND_DISPLAY WAYLAND_SOCKET
    tries=0
    until xprop -root >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -lt 300 ] || { echo "wm-session: the X server did not start (log: $log)" >&2; exit 1; }
      sleep 0.1
    done
    case "$WMS_WM" in
      i3)
        # A minimal config (no first-run wizard): i3bar with its XEmbed tray, no status command.
        printf "%s\n" "# i3 config file (v4)" "font pango:monospace 8" "bar {" "  position top" "}" \
          >"$WMS_SCRATCH/i3.conf"
        i3 -c "$WMS_SCRATCH/i3.conf" >>"$log" 2>&1 &
        ;;
      xfwm4) xfwm4 --compositor=off >>"$log" 2>&1 & ;;
      *) "$WMS_WM" >>"$log" 2>&1 & ;;
    esac
    pids="$pids $!"
    wm_ready() { xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; }
  else
    export XDG_SESSION_TYPE=wayland
    export XDG_CURRENT_DESKTOP="$WMS_WAYLAND" WAYLAND_DISPLAY=wayland-kitchen-sink
    unset DISPLAY
    if [ "$WMS_WAYLAND" = weston ]; then
      weston --backend=headless --socket="$WAYLAND_DISPLAY" --width=1920 --height=1080 \
        >>"$log" 2>&1 &
    else
      # sway names its own socket: point WAYLAND_DISPLAY at it once it exists.
      printf "%s\n" "output HEADLESS-1 resolution 1920x1080" >"$WMS_SCRATCH/sway.conf"
      WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c "$WMS_SCRATCH/sway.conf" \
        >>"$log" 2>&1 &
    fi
    pids="$!"
    wm_ready() {
      if [ "$WMS_WAYLAND" = sway ]; then
        for s in "$XDG_RUNTIME_DIR"/wayland-*; do
          case "$s" in *.lock) continue ;; esac
          [ -S "$s" ] && WAYLAND_DISPLAY="${s##*/}" && export WAYLAND_DISPLAY && return 0
        done
        return 1
      fi
      [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]
    }
  fi
  printf ci | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
  if command -v dunst >/dev/null 2>&1; then
    if [ "$WMS_WAYLAND" = weston ] && command -v Xvfb >/dev/null 2>&1; then
      # weston has no layer shell for dunst to draw on: give it a hidden X display of its own
      # (it only has to own org.freedesktop.Notifications; dunstctl still clicks).
      n=90
      while [ -e "/tmp/.X$n-lock" ] || [ -e "/tmp/.X11-unix/X$n" ]; do n=$((n + 1)); done
      Xvfb ":$n" -screen 0 1280x800x24 -ac -nolisten tcp >>"$log" 2>&1 &
      pids="$pids $!"
      env -u WAYLAND_DISPLAY DISPLAY=":$n" dunst >>"$log" 2>&1 &
    else
      dunst >>"$log" 2>&1 &
    fi
    pids="$pids $!"
  fi
  owned() {
    dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
      org.freedesktop.DBus.NameHasOwner "string:$1" 2>/dev/null | grep -q "boolean true"
  }
  ready() {
    wm_ready && owned org.freedesktop.secrets &&
      { ! command -v dunst >/dev/null 2>&1 || owned org.freedesktop.Notifications; }
  }
  tries=0
  until ready; do
    tries=$((tries + 1))
    if [ "$tries" -ge 300 ]; then
      echo "wm-session: the session is not up after 30 s (log: $log)" >&2
      exit 1
    fi
    sleep 0.1
  done
  echo "wm-session: ${WMS_WM:-$WMS_WAYLAND} on ${DISPLAY:-$WAYLAND_DISPLAY} (log: $log)" >&2
  "$@"
' wm-session "$@" || status=$?
if [ "$status" -eq 0 ]; then
  rm -rf "$scratch"
else
  echo "wm-session: exit $status; the session's log and scratch folder are kept in $scratch" >&2
fi
exit "$status"
