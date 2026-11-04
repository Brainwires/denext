#!/bin/sh
# The release binary has to RUN, not merely link (.github/workflows/publish.yml, every leg that can
# execute its binary: x86_64 Linux where it is built, aarch64 Linux and macOS on their own runners):
#
#   sh scripts/ci/binary-smoke.sh <path to denext> <version>
#
# `--version` proves it starts and knows it is a binary (and that the tag matches the version baked
# into it: the two are bumped separately), `--help` proves the verb table (metadata only) loads,
# `completions bash` proves a verb's implementation loads on demand (it is embedded only through
# `--include src/cli/lazy-modules.generated.ts`; without it every verb fails while `--version` and
# `--help` still pass), and `build` in a directory that pins no denext proves the refusal path (a
# binary never builds an app in its own process) exits 1 with the message the docs quote, rather
# than crashing or, worse, building with the binary's own framework.
set -eu

bin="$1"
version="$2"
case "$bin" in /*) ;; *) bin="$PWD/$bin" ;; esac

"$bin" --version | tee /dev/stderr | grep -Fx "denext $version (binary)" >/dev/null
"$bin" --help | grep -F "Usage" >/dev/null
"$bin" completions bash | grep -F "_denext_complete()" >/dev/null
scratch="$(mktemp -d)"
set +e
out="$(cd "$scratch" && "$bin" build 2>&1)"
code=$?
set -e
rm -rf "$scratch"
printf '%s\n' "$out"
[ "$code" -eq 1 ] || { echo "::error::expected exit 1 from an unpinned build, got $code"; exit 1; }
printf '%s\n' "$out" | grep -F "pins no denext" >/dev/null
echo "binary smoke: $bin ($version) ok"
