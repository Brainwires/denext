#!/usr/bin/env bash
REAL="$HOME/.deno/bin/deno"
case "$1" in
  bundle|info) sub="$1"; shift; exec "$REAL" "$sub" --unstable-sloppy-imports "$@" ;;
  run)         shift; exec "$REAL" run --unstable-sloppy-imports "$@" ;;
  *)           exec "$REAL" "$@" ;;
esac
