#!/bin/sh
# Run a command in a headless Linux desktop session for the window test (CI and local):
#
#   - Xvfb (a display), xfwm4 (maximize is a window-manager request on X11),
#   - a private D-Bus session with an unlocked Secret Service (gnome-keyring, for secureStore),
#   - a notification server (dunst, for the notification checks).
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

exec xvfb-run -a -s "-screen 0 1920x1080x24" dbus-run-session -- sh -c '
  printf ci | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  xfwm4 --compositor=off >/dev/null 2>&1 &
  dunst >/dev/null 2>&1 &
  sleep 2
  exec "$@"
' session "$@"
