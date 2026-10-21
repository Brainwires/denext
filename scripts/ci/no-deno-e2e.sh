#!/bin/sh
# A machine with NO Deno, made to work by the `denext` executable alone (.github/workflows/e2e.yml,
# job `no-deno`). Runs inside a clean container: the CI job mounts a directory holding a locally
# built release (`denext-<target>.tar.gz` + `SHA256SUMS`) and scripts/install.sh at /art.
#
#   docker run --rm -v "$PWD/dist/no-deno:/art:ro" debian:bookworm-slim \
#     sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates procps && sh /art/no-deno-e2e.sh'
#
# It installs with the installer (DENEXT_ARTIFACTS, the link opted out so not even a `deno` link
# exists), then scaffolds an app and runs it through `denext` only: `denext task dev` serves,
# `denext build` + `denext start` serve, `denext test`, `denext fmt`, `denext lint` and
# `denext task build` work. With the toolchain turned off and no Deno it must refuse with the fix.
# Last, the installer's default links `deno` to the toolchain. Every wait is bounded.
set -eu

ART="${ART:-/art}"
export HOME="${E2E_HOME:-/tmp/no-deno-home}"
mkdir -p "$HOME"
cd "$HOME"

fail() {
  echo "no-deno e2e: FAIL — $*" >&2
  exit 1
}

# Wait (bounded) for $1 to answer, saving the body to $2.
wait_for() {
  for _ in $(seq 1 150); do
    if curl -fsS "$1" -o "$2" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

if command -v deno >/dev/null 2>&1; then fail "deno is on PATH ($(command -v deno))"; fi
echo "ok: no deno on this machine"

DENEXT_ARTIFACTS="$ART" DENEXT_NO_DENO_LINK=1 sh "$ART/install.sh"
export PATH="$HOME/.denext/bin:$PATH"
if command -v deno >/dev/null 2>&1; then fail "the installer linked deno despite the opt-out"; fi
denext --version
denext toolchain status

denext create my-app --yes
cd my-app
mkdir -p tests
cat > tests/smoke.test.ts <<'TS'
// denext's Deno (src/build/deno-version.ts isDenextDenoVersion): `2.9.7-denext.N` up to
// 2.9.7-denext.22, the fork's own `3.0.0-rc.N` from 3.0.0-rc.1 on.
const DENEXT_DENO = /^(\d+\.\d+\.\d+-denext\.\d+|3\.0\.0-rc\.\d+)(\+[0-9A-Za-z.-]+)?$/;
Deno.test("the app's tests run on denext's toolchain", () => {
  const v = Deno.version.deno;
  if (!DENEXT_DENO.test(v)) throw new Error(`stock deno ${v}`);
  // Only the toolchain has the built-in Postgres client.
  if (typeof (Deno as unknown as { SQL?: unknown }).SQL !== "function") throw new Error(`no Deno.SQL on ${v}`);
});
TS

echo "--- denext task dev"
denext task dev > /tmp/no-deno-dev.log 2>&1 &
dev=$!
if ! wait_for http://localhost:3000/ /tmp/no-deno-dev.html; then
  tail -40 /tmp/no-deno-dev.log
  fail "denext task dev never served"
fi
pkill -TERM -P "$dev" 2>/dev/null || true
kill "$dev" 2>/dev/null || true
grep -q "<title>" /tmp/no-deno-dev.html || fail "the dev page has no <title>"
echo "ok: denext task dev served"

echo "--- denext build && denext start"
denext build
denext start --port 3100 > /tmp/no-deno-start.log 2>&1 &
start=$!
if ! wait_for http://localhost:3100/ /tmp/no-deno-start.html; then
  tail -40 /tmp/no-deno-start.log
  fail "denext start never served"
fi
pkill -TERM -P "$start" 2>/dev/null || true
kill "$start" 2>/dev/null || true
echo "ok: denext start served"

echo "--- denext test / fmt / lint / task build"
denext test
denext fmt
denext fmt --check
denext lint
denext task build

echo "--- no toolchain and no deno: one error naming the fix"
if DENEXT_DENO=stock denext fmt --check > /tmp/no-deno-refusal.log 2>&1; then
  fail "denext fmt ran with no Deno at all"
fi
grep -q "denext toolchain install" /tmp/no-deno-refusal.log ||
  { cat /tmp/no-deno-refusal.log; fail "the refusal does not name the fix"; }
echo "ok: refused with the fix"

echo "--- the installer's default links deno to the toolchain"
DENEXT_ARTIFACTS="$ART" sh "$ART/install.sh"
# denext's Deno: 3.0.0-rc.N on (its own version), 2.9.7-denext.N before (src/build/deno-version.ts).
deno --version | head -1 | grep -Eq -- '^deno ([0-9]+\.[0-9]+\.[0-9]+-denext\.[0-9]+|3\.0\.0-rc\.[0-9]+)([+ ]|$)' ||
  fail "deno is not the toolchain"
deno task build
echo "no-deno e2e: ALL OK"
