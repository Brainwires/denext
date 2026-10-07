#!/bin/sh
# Run a command in a headless Linux desktop session for the window test (CI and local):
#
#   - Xvfb (a display), xfwm4 (maximize is a window-manager request on X11),
#   - a private D-Bus session with an unlocked Secret Service (gnome-keyring, for secureStore),
#   - a notification server (dunst, for the notification checks).
#
# The command starts once all three are up: the window manager has set
# `_NET_SUPPORTING_WM_CHECK` on the root window (xprop, from x11-utils) and the D-Bus session has
# owners for org.freedesktop.Notifications and org.freedesktop.secrets (dbus-send); polled every
# 0.1 s for up to 30 s, never a fixed sleep.
#
# XDG_DATA_HOME / XDG_CONFIG_HOME point at a scratch folder (KITCHEN_SINK_XDG, else a temp dir),
# so a fresh "login" keyring is created there and the user's own keyring and settings are never
# touched. The window test computes the app's data folder from the same variables.
#
#   e2e/linux-session.sh deno task test:window
set -eu

xdg="${KITCHEN_SINK_XDG:-$(mktemp -d)}"
mkdir -p "$xdg/data/keyrings" "$xdg/config"
export XDG_DATA_HOME="$xdg/data" XDG_CONFIG_HOME="$xdg/config"
# A default collection named "login", created and unlocked with a known password, so nothing ever
# prompts (a prompt has no one to answer it on a headless display).
printf login > "$XDG_DATA_HOME/keyrings/default"

for tool in xprop dbus-send; do
  command -v "$tool" >/dev/null 2>&1 || { echo "linux-session: $tool is required" >&2; exit 1; }
done

exec xvfb-run -a -s "-screen 0 1920x1080x24" dbus-run-session -- sh -c '
  printf ci | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  xfwm4 --compositor=off >/dev/null 2>&1 &
  dunst >/dev/null 2>&1 &
  owned() {
    dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
      org.freedesktop.DBus.NameHasOwner "string:$1" 2>/dev/null | grep -q "boolean true"
  }
  ready() {
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" &&
      owned org.freedesktop.Notifications && owned org.freedesktop.secrets
  }
  tries=0
  until ready; do
    tries=$((tries + 1))
    if [ "$tries" -ge 300 ]; then
      echo "linux-session: the window manager, dunst or the Secret Service is not up after 30 s" >&2
      exit 1
    fi
    sleep 0.1
  done
  exec "$@"
' session "$@"
