#!/bin/bash
# The Dock helper's end-to-end check (desktop.app.dock "while-window-open"), on a macOS host with a
# logged-in GUI session (a GitHub-hosted runner: it opens windows and resets the Dock's recent apps,
# so never run it on a workstation). Packages this fixture (ad hoc signed), installs it in
# /Applications, and over three open / close cycles asserts: the app stays accessory; a window open
# shows the helper's Dock tile, a Foreground app System Events lists by the app's name; a Dock click
# and a switch to the helper bring the app to the front; closing the window (the third cycle: the
# helper's Quit, which quits the app) removes the tile and leaves the Dock's recent apps empty.
#
#   deno task desktop:package && bash e2e.sh        (OUT=<dir> for the results; SKIP_PACKAGE=1)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/e2e-out}"
mkdir -p "$OUT"
LOG="$OUT/raw.log"
SUM="$OUT/summary.md"
: >"$LOG"
: >"$SUM"
NAME=DockHelperProbe
APP_ID=dev.denext.dock-helper-probe
HELPER_ID=$APP_ID.dock
DATA="$HOME/Library/Application Support/$APP_ID"
APP=/Applications/$NAME.app
FAILS=0

log() { echo "$*" | tee -a "$LOG"; }
row() { # step cycle ok detail
  local mark=PASS
  [ "$3" = 1 ] || { mark=FAIL; FAILS=$((FAILS + 1)); }
  echo "| $1 | $2 | $mark | $4 |" >>"$SUM"
  log "  [$mark] $1 #$2: $4"
}
recents() {
  python3 - "$HELPER_ID" "$APP_ID" <<'PY'
import plistlib, subprocess, sys
d = plistlib.loads(subprocess.run(["defaults", "export", "com.apple.dock", "-"], capture_output=True).stdout)
out = []
for it in d.get("recent-apps", []):
    td = it.get("tile-data", {})
    out.append(f"{td.get('bundle-identifier', '?')} {td.get('file-data', {}).get('_CFURLString', '?')}")
print(" | ".join(out) if out else "(none)")
PY
}
dock_items() {
  osascript -e 'tell application "System Events" to get name of every UI element of list 1 of process "Dock"' 2>&1 | tr '\n' ' '
}
se_helper() {
  osascript -e "tell application \"System Events\" to get {name, background only} of (every application process whose bundle identifier is \"$HELPER_ID\")" 2>&1 | tr '\n' ' '
}
app_type() { # bundle id -> Foreground / UIElement / none
  local asn
  asn=$(lsappinfo find "bundleid=$1" 2>/dev/null | head -1 | sed -E 's/^ASN:(0x[0-9a-f]+-0x[0-9a-f]+).*/\1/')
  [ -n "$asn" ] || { echo none; return; }
  lsappinfo info -only applicationtype "ASN:$asn" 2>/dev/null | sed -E 's/.*="([A-Za-z]+)".*/\1/' | tr -d '\n'
}
front() { lsappinfo info -only bundleid "$(lsappinfo front)" 2>/dev/null | sed -E 's/.*="([^"]+)".*/\1/' | tr -d '\n'; }
helper_pid() { pgrep -f "dock-helper/$NAME.app/Contents/MacOS/$NAME" | head -1; }
wait_dock() {
  for _ in $(seq 1 30); do pgrep -x Dock >/dev/null && break; sleep 0.5; done
  sleep 4
}
cmdn=0
cmd() {
  cmdn=$((cmdn + 1))
  echo "$1" >"$DATA/e2e/cmd-$cmdn"
}
wait_state() { # line count
  for _ in $(seq 1 120); do
    [ "$(grep -cx "$1" "$DATA/e2e/state.log" 2>/dev/null)" -ge "$2" ] && return 0
    sleep 0.25
  done
  log "  timeout waiting for '$1' x$2"
  return 1
}

sw_vers | tee -a "$LOG"
uname -m | tee -a "$LOG"
{
  echo "## Dock helper e2e — macOS $(sw_vers -productVersion) $(uname -m)"
  echo
  echo "| step | cycle | result | detail |"
  echo "|---|---|---|---|"
} >>"$SUM"

if [ "${SKIP_PACKAGE:-}" != 1 ]; then
  (cd "$HERE" && deno task desktop:package) >>"$LOG" 2>&1 || {
    log "packaging failed"
    tail -60 "$LOG"
    exit 1
  }
fi
BUILT="$HERE/dist/$NAME.app"
row package 0 $([ -d "$BUILT/Contents/Helpers/$NAME.app" ] && echo 1 || echo 0) "helper in Contents/Helpers"
codesign --verify --deep --strict "$BUILT" >>"$LOG" 2>&1
row codesign 0 $([ $? = 0 ] && echo 1 || echo 0) "codesign --verify --deep --strict"
[ -w /Applications ] || sudo chmod a+w /Applications
rm -rf "$APP" "$DATA"
ditto "$BUILT" "$APP"

defaults write com.apple.dock show-recents -bool true
defaults write com.apple.dock recent-apps -array
killall Dock
wait_dock
if [ "$(recents)" != "(none)" ]; then
  defaults write com.apple.dock recent-apps -array
  killall Dock
  wait_dock
fi
log "recents reset: $(recents)"

open "$APP"
for _ in $(seq 1 120); do [ -f "$DATA/e2e/state.log" ] && break; sleep 0.5; done
wait_state ready 1
sleep 2
t=$(app_type $APP_ID)
row launch 0 $([ "$t" = UIElement ] && [ -z "$(helper_pid)" ] && echo 1 || echo 0) "app=$t helper=$(helper_pid)"

for i in 1 2 3; do
  cmd open
  wait_state opened "$i"
  sleep 3
  t=$(app_type $APP_ID)
  h=$(app_type $HELPER_ID)
  dock=$(dock_items)
  se=$(se_helper)
  row open "$i" $([ "$t" = UIElement ] && [ "$h" = Foreground ] && echo "$dock" | grep -q "$NAME" && echo "$se" | grep -q "^$NAME, false" && echo 1 || echo 0) \
    "app=$t helper=$h se=[$se] tile=$(echo "$dock" | grep -q "$NAME" && echo yes || echo no) front=$(front)"
  [ "$i" = 1 ] && screencapture -x "$OUT/open-1.png" 2>>"$LOG"
  if [ "$i" = 1 ]; then
    diff -r "$APP/Contents/Helpers/$NAME.app" "$DATA/dock-helper/$NAME.app" >>"$LOG" 2>&1
    row copy "$i" $([ $? = 0 ] && echo 1 || echo 0) "data-folder copy matches the bundled helper"
  fi
  open -a Finder
  sleep 2
  osascript -e "tell application \"System Events\" to tell process \"Dock\" to click UI element \"$NAME\" of list 1" >>"$LOG" 2>&1
  sleep 2
  f=$(front)
  row dock-click "$i" $([ "$f" = "$APP_ID" ] && echo 1 || echo 0) "front=$f"
  open -a Finder
  sleep 2
  osascript -e "tell application \"System Events\" to set frontmost of (first application process whose bundle identifier is \"$HELPER_ID\") to true" >>"$LOG" 2>&1
  sleep 2
  f=$(front)
  row switch-to "$i" $([ "$f" = "$APP_ID" ] && echo 1 || echo 0) "front=$f"
  if [ "$i" = 3 ]; then
    # The helper's Quit (the Dock menu's): the app quits.
    osascript -e "tell application id \"$HELPER_ID\" to quit" >>"$LOG" 2>&1
    for _ in $(seq 1 40); do pgrep -f "$APP/Contents/MacOS" >/dev/null || break; sleep 0.25; done
    sleep 5
    gone=$([ -z "$(pgrep -f "$APP/Contents/MacOS")" ] && [ -z "$(helper_pid)" ] && echo 1 || echo 0)
    r=$(recents)
    row quit "$i" $([ "$gone" = 1 ] && [ "$r" = "(none)" ] && echo 1 || echo 0) "app and helper gone=$gone recents=$r"
  else
    cmd close
    wait_state closed "$i"
    sleep 5
    dock=$(dock_items)
    r=$(recents)
    row close "$i" $([ -z "$(helper_pid)" ] && ! echo "$dock" | grep -q "$NAME" && [ "$r" = "(none)" ] && [ "$(app_type $APP_ID)" = UIElement ] && echo 1 || echo 0) \
      "helper=$(helper_pid) tile=$(echo "$dock" | grep -q "$NAME" && echo yes || echo no) recents=$r app=$(app_type $APP_ID)"
  fi
done

sleep 10
r=$(recents)
row settled 0 $([ "$r" = "(none)" ] && echo 1 || echo 0) "recents=$r"
defaults read com.apple.dock recent-apps >>"$LOG" 2>&1
echo "----- state.log" >>"$LOG"
cat "$DATA/e2e/state.log" >>"$LOG" 2>&1
cat "$SUM"
[ "$FAILS" = 0 ] || { echo "$FAILS check(s) failed"; exit 1; }
