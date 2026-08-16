#!/usr/bin/env bash
# verify-dropin.sh — reproducible "drop-in" verifier for denext.
#
# Clones a pinned third-party Next.js App Router app, converts its package.json
# to a denext deno.json (convert.ts), then drives it through the denext pipeline
# and records exactly where "drop-in" holds and where it breaks.
#
# Run from anywhere:  bash examples/next-compat-feasibility/verify-dropin.sh
# Swap the app:       APP_NAME=x APP_REPO=<git-url> APP_REF=<sha> bash …/verify-dropin.sh
# Reuse a clone:      SKIP_SETUP=1 bash …/verify-dropin.sh
#
# Clones/logs go to a temp dir (outside the repo); REPORT.md is written next to
# this script as the committed latest result.
set -uo pipefail

# ---- config (swap the app via env vars) --------------------------------------
APP_NAME="${APP_NAME:-shadcn-next-template}"
APP_REPO="${APP_REPO:-https://github.com/shadcn-ui/next-template.git}"
APP_REF="${APP_REF:-main}"   # pin to a SHA for full reproducibility

HERE="$(cd "$(dirname "$0")" && pwd)"
# Repo root is two levels up from examples/next-compat-feasibility/.
DENEXT="${DENEXT:-$(cd "$HERE/../.." && pwd)}"
OUT="${OUT:-${TMPDIR:-/tmp}/denext-dropin/$APP_NAME}"
WORK="$OUT/app"
LOGS="$OUT/logs"; mkdir -p "$LOGS"
REPORT="$HERE/REPORT.md"
DENO="${DENO_BIN:-deno}"

step() { echo "=== $* ==="; }
mark() { echo "$1|$2|$3" >> "$LOGS/results.psv"; }  # stage|status|note
: > "$LOGS/results.psv"

# ---- 0. tooling --------------------------------------------------------------
step "tooling"
"$DENO" --version | head -1 || { echo "no deno"; exit 1; }
command -v npm >/dev/null && npm --version || echo "npm: MISSING (npm-dep resolution will fall back to Deno)"

# ---- 1. clone (pinned) -------------------------------------------------------
step "clone $APP_REPO @ $APP_REF"
if [ -n "${SKIP_SETUP:-}" ] && [ -d "$WORK/node_modules" ]; then
  SHA="$(cd "$WORK" && git rev-parse --short HEAD 2>/dev/null || echo reused)"
  mark clone PASS "$SHA (reused)"
  mark install PASS "reused node_modules"
else
rm -rf "$WORK"; mkdir -p "$WORK"
if git clone --depth 1 --branch "$APP_REF" "$APP_REPO" "$WORK" >"$LOGS/1-clone.log" 2>&1 \
   || git clone "$APP_REPO" "$WORK" >>"$LOGS/1-clone.log" 2>&1; then
  ( cd "$WORK" && [ "$APP_REF" != "main" ] && git checkout "$APP_REF" >>"$LOGS/1-clone.log" 2>&1 )
  SHA="$(cd "$WORK" && git rev-parse --short HEAD)"
  mark clone PASS "$SHA"
else
  mark clone FAIL "see 1-clone.log"; SHA="?"
fi

fi  # end reuse-guard

# ---- 2. install npm deps (populate node_modules for compat bundling) ----------
step "npm install"
if grep -q "^install|PASS|reused" "$LOGS/results.psv"; then
  :  # already reused above
elif command -v npm >/dev/null; then
  ( cd "$WORK" && npm install --no-audit --no-fund --legacy-peer-deps ) >"$LOGS/2-install.log" 2>&1 \
    && mark install PASS "node_modules populated" \
    || mark install WARN "npm install had errors (see 2-install.log)"
else
  mark install SKIP "no npm; relying on Deno --node-modules-dir=auto"
fi

# ---- 3. convert package.json -> deno.json ------------------------------------
step "convert"
"$DENO" run -A "$HERE/convert.ts" --app "$WORK" --denext "$DENEXT" --write \
  >"$LOGS/3-convert.log" 2>&1
CONV=$?
sed -n '1,80p' "$LOGS/3-convert.log"
if [ $CONV -eq 0 ]; then mark convert PASS "no hard blockers";
elif [ $CONV -eq 2 ]; then mark convert WARN "converted with FLAGGED deps / pages-router (see 3-convert.log)";
else mark convert FAIL "converter crashed"; fi

# ---- 4. type/parse smoke: can Deno even load the root layout+page? -----------
step "module-load smoke (deno check on app/)"
ROOTPAGE="$(ls "$WORK/app/page.tsx" "$WORK/src/app/page.tsx" 2>/dev/null | head -1)"
if [ -n "$ROOTPAGE" ]; then
  ( cd "$WORK" && "$DENO" check --unstable-sloppy-imports "$ROOTPAGE" ) >"$LOGS/4-check.log" 2>&1 \
    && mark check PASS "root page type-checks against denext" \
    || mark check FAIL "see 4-check.log (first errors below)"
  grep -E "error|TS[0-9]+" "$LOGS/4-check.log" | head -15
else
  mark check SKIP "no app/page.tsx found"
fi

# ---- 5. denext build (the real drop-in test) ---------------------------------
step "denext build"
( cd "$WORK" && "$DENO" run -A "$DENEXT/cli.ts" build . ) >"$LOGS/5-build.log" 2>&1 \
  && mark build PASS "unmodified app built" \
  || mark build FAIL "see 5-build.log (first errors below)"
grep -iE "error|fail|cannot|unexpected|not found" "$LOGS/5-build.log" | head -25

# ---- 6. render smoke: start + curl the homepage ------------------------------
step "render smoke"
if grep -q "^build|PASS" "$LOGS/results.psv"; then
  cd "$WORK"
  "$DENO" run -A "$DENEXT/cli.ts" start . --port 8912 >"$LOGS/6-serve.log" 2>&1 &
  SERVE_PID=$!
  cd "$HERE"
  # poll up to 25s for the port to accept a connection
  OK=""
  for _ in $(seq 1 25); do
    if curl -fsS "http://localhost:8912/" -o "$LOGS/6-home.html" 2>>"$LOGS/6-serve.log"; then OK=1; break; fi
    kill -0 "$SERVE_PID" 2>/dev/null || break   # server died
    sleep 1
  done
  if [ -n "$OK" ]; then
    BYTES=$(wc -c < "$LOGS/6-home.html")
    HASROOT=$(grep -c "denext-root\|<body" "$LOGS/6-home.html" 2>/dev/null || echo 0)
    mark render PASS "homepage served, ${BYTES} bytes (body markers: ${HASROOT})"
  else
    mark render FAIL "server did not serve / within 25s (see 6-serve.log)"
  fi
  kill "$SERVE_PID" 2>/dev/null
else
  mark render SKIP "build failed; nothing to serve"
fi

# ---- 7. write REPORT.md ------------------------------------------------------
step "REPORT"
{
  echo "# denext drop-in verification — $APP_NAME"
  echo
  echo "| field | value |"
  echo "|---|---|"
  echo "| app | $APP_REPO |"
  echo "| ref | $APP_REF ($SHA) |"
  echo "| denext | $DENEXT |"
  echo "| date | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
  echo
  echo "## Stage results"
  echo
  echo "| stage | status | note |"
  echo "|---|---|---|"
  while IFS='|' read -r s st note; do echo "| $s | $st | $note |"; done < "$LOGS/results.psv"
  echo
  echo "## Conversion detail"
  echo '```'
  cat "$LOGS/3-convert.log"
  echo '```'
  echo
  echo "Logs: \`$LOGS\`"
} > "$REPORT"
echo "wrote $REPORT"
cat "$LOGS/results.psv"
