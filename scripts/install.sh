#!/bin/sh
# denext installer — fetches the released `denext` binary for this platform.
#
#   curl -fsSL https://denext.dev/install.sh | sh
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. You do not need it — `deno run -A jsr:@denext/denext/cli <verb>` does the same thing.
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin/`); default: ~/.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched (never on a mismatch)
#
# Everything lives in main(), called on the last line, so a download that is cut short runs
# nothing: `sh` executes a truncated script only up to where it stopped, and that is never
# past the call.
set -eu

REPO="Brainwires/denext"

# `curl` for a release URL: HTTPS only (no scheme downgrade through a redirect), TLS 1.2+.
fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL "$@"
}

target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os-$arch" in
    Darwin-arm64) echo "aarch64-apple-darwin" ;;
    Darwin-x86_64) echo "x86_64-apple-darwin" ;;
    Linux-aarch64 | Linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
    Linux-x86_64) echo "x86_64-unknown-linux-gnu" ;;
    *)
      echo "denext: no prebuilt binary for $os-$arch (a Windows archive is on the release page)." >&2
      echo "  Use the CLI from JSR instead:" >&2
      echo "    deno install -A -g -n denext jsr:@denext/denext/cli" >&2
      exit 1
      ;;
  esac
}

# The SHA-256 of a file, with whichever tool this machine has.
digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The published checksum for $ASSET: the release's combined SHA256SUMS first (one file covers
# every platform), else the per-archive `$ASSET.sha256` beside it — both written by
# .github/workflows/publish.yml. Prints the hex digest, or nothing when neither can be fetched.
published_digest() {
  base="https://github.com/$REPO/releases/download/$VERSION"
  if fetch "$base/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
    line="$(grep " $ASSET\$" "$TMP/SHA256SUMS" 2>/dev/null | head -1 || true)"
    if [ -n "$line" ]; then
      echo "$line" | cut -d' ' -f1
      return 0
    fi
  fi
  if fetch "$base/$ASSET.sha256" -o "$TMP/$ASSET.sha256" 2>/dev/null; then
    cut -d' ' -f1 <"$TMP/$ASSET.sha256"
  fi
}

main() {
  INSTALL_DIR="${DENEXT_INSTALL:-$HOME/.denext}"
  BIN_DIR="$INSTALL_DIR/bin"
  TARGET="$(target)"

  VERSION="${DENEXT_VERSION:-}"
  if [ -z "$VERSION" ]; then
    # `releases/latest` is the newest NON-prerelease: an rc tag is published as a prerelease and
    # never becomes "latest", so this resolves a stable version unless one is asked for.
    VERSION="$(fetch "https://api.github.com/repos/$REPO/releases/latest" |
      grep '"tag_name"' | head -1 | cut -d'"' -f4)"
  fi
  [ -n "$VERSION" ] || {
    echo "denext: could not determine the latest release; set DENEXT_VERSION." >&2
    exit 1
  }

  ASSET="denext-$TARGET.tar.gz"
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  echo "denext: downloading $VERSION for $TARGET"
  fetch "$URL" -o "$TMP/$ASSET"

  # A binary that will run with the user's permissions is never installed unverified. A missing
  # checksum is as fatal as a wrong one — an attacker who can swap the archive can drop the
  # checksum too — unless DENEXT_INSECURE=1 says, loudly, that this is deliberate.
  expected="$(published_digest)"
  if [ -z "$expected" ]; then
    if [ "${DENEXT_INSECURE:-}" = "1" ]; then
      echo "denext: WARNING — no checksum could be fetched for $ASSET; installing UNVERIFIED" >&2
      echo "  because DENEXT_INSECURE=1 is set. Unset it to require verification." >&2
    else
      echo "denext: no checksum could be fetched for $ASSET — not installing." >&2
      echo "  Every release publishes SHA256SUMS; check https://github.com/$REPO/releases/tag/$VERSION" >&2
      echo "  (DENEXT_INSECURE=1 installs anyway, unverified)." >&2
      exit 1
    fi
  else
    actual="$(digest "$TMP/$ASSET")"
    if [ "$actual" != "$expected" ]; then
      echo "denext: checksum verification FAILED for $ASSET — not installing." >&2
      echo "  expected $expected" >&2
      echo "  got      $actual" >&2
      exit 1
    fi
    echo "denext: checksum verified"
  fi

  mkdir -p "$BIN_DIR"
  tar xzf "$TMP/$ASSET" -C "$TMP"
  mv "$TMP/denext" "$BIN_DIR/denext"
  chmod +x "$BIN_DIR/denext"

  # An unsigned macOS download carries the quarantine attribute; strip it so the binary runs.
  if [ "$(uname -s)" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$BIN_DIR/denext" 2>/dev/null || true
  fi

  echo "denext: installed $("$BIN_DIR/denext" --version) to $BIN_DIR/denext"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo
      echo "Add it to your PATH:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac

  # The binary is only the CLI: `dev`, `build`, `start` and every other verb that loads a
  # project's modules run them in a `deno` child, so without Deno those verbs cannot work.
  if ! command -v deno >/dev/null 2>&1; then
    echo >&2
    echo "denext: warning — \`deno\` is not on your PATH. The binary needs it for every verb that" >&2
    echo "  loads a project (dev, build, start, …): https://deno.com/ → \`curl -fsSL https://deno.land/install.sh | sh\`" >&2
  fi
}

main "$@"
