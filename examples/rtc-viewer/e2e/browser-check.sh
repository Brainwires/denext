#!/bin/sh
# Runs e2e/browser-check.ts against a dev server and the CLI sender, all on loopback.
#   sh examples/rtc-viewer/e2e/browser-check.sh [--engine webkit] [--case cli-auto]
# from the repository root, on a machine with Playwright's browsers
# (`deno run -A npm:playwright-core@1.63.0 install chromium webkit`). $DENO is denext's Deno
# (`denext runtime path`); the CLI sender needs its WebRTC.
set -eu
DENO="${DENO:-deno}"
PORT="${RTC_PORT:-3317}"
URL="http://127.0.0.1:$PORT"
LOGS="${RTC_LOGS:-${TMPDIR:-/tmp}/rtc-viewer-check}"
mkdir -p "$LOGS"

setsid "$DENO" run -A cli.ts dev examples/rtc-viewer --host 127.0.0.1 --port "$PORT" \
  >"$LOGS/dev.log" 2>&1 &
DEV=$!
# Each child leads its own process group (setsid): stop the whole group.
cleanup() {
  kill -TERM "-$DEV" 2>/dev/null || true
  if [ -n "${SEND:-}" ]; then kill -TERM "-$SEND" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

i=0
until curl -fsS -o /dev/null "$URL/"; do
  i=$((i + 1))
  [ "$i" -gt 120 ] && { echo "dev server did not start"; tail -20 "$LOGS/dev.log"; exit 1; }
  sleep 1
done

DENO_WEBRTC_LOOPBACK_ONLY=1 setsid "$DENO" run --allow-net --allow-env \
  examples/rtc-viewer/cli/send.ts --url "$URL" --room cli --source pattern ${RTC_SEND_ARGS:-} \
  >"$LOGS/send.log" 2>&1 &
SEND=$!

"$DENO" run -A --config deno.json examples/rtc-viewer/e2e/browser-check.ts --url "$URL" "$@"
