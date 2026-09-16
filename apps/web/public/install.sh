#!/bin/sh
# denext installer — fetches the released `denext` binary for this platform.
#
#   curl -fsSL https://denext.dev/install.sh | sh
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. You do not need it — `deno run -A jsr:@denext/denext/cli <verb>` does the same thing.
set -eu

REPO="Brainwires/denext"
INSTALL_DIR="${DENEXT_INSTALL:-$HOME/.denext}"
BIN_DIR="$INSTALL_DIR/bin"

target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os-$arch" in
    Darwin-arm64) echo "aarch64-apple-darwin" ;;
    Darwin-x86_64) echo "x86_64-apple-darwin" ;;
    Linux-aarch64 | Linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
    Linux-x86_64) echo "x86_64-unknown-linux-gnu" ;;
    *)
      echo "denext: no prebuilt binary for $os-$arch." >&2
      echo "  Use the CLI from JSR instead:" >&2
      echo "    deno install -A -n denext jsr:@denext/denext/cli" >&2
      exit 1
      ;;
  esac
}

TARGET="$(target)"
VERSION="${DENEXT_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
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
curl -fsSL "$URL" -o "$TMP/$ASSET"

# The checksum is published beside the archive; verify when it is there.
if curl -fsSL "$URL.sha256" -o "$TMP/$ASSET.sha256" 2>/dev/null ||
  curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/denext-$TARGET.sha256" \
    -o "$TMP/$ASSET.sha256" 2>/dev/null; then
  (cd "$TMP" && shasum -a 256 -c "$ASSET.sha256" >/dev/null 2>&1) ||
    (cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null 2>&1) || {
    echo "denext: checksum verification FAILED — not installing." >&2
    exit 1
  }
  echo "denext: checksum verified"
else
  echo "denext: warning — no checksum published for this asset" >&2
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
