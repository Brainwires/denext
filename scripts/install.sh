#!/bin/sh
# denext installer — fetches the released `denext` binary for this platform.
#
#   curl -fsSL https://denext.dev/install.sh | sh
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. It is all you need — Deno itself is not: after installing the binary the script runs
# `denext toolchain install`, which downloads denext's own Deno build (SHA-256-verified) into
# Deno's cache, and every verb runs on it (`denext task dev`, `denext test`, `denext fmt` …).
# When no `deno` is on your PATH it also runs `denext toolchain link`, so `deno` is that toolchain
# (a link at ~/.denext/bin/deno); an existing `deno` is never replaced or shadowed. Either
# step failing (offline, say) is one warning, not a failed install: the binary downloads the
# toolchain on first need instead.
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin/`); default: ~/.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched (never on a mismatch)
#   DENEXT_NO_TOOLCHAIN  `1` skips `denext toolchain install` (and the link): the toolchain then
#                    downloads on the first command that needs it
#   DENEXT_NO_DENO_LINK  `1` skips `denext toolchain link` (no `deno` is put on your PATH)
#   DENEXT_ARTIFACTS a local directory holding the release files (`denext-<target>.tar.gz` and
#                    `SHA256SUMS` or `<archive>.sha256`) to install from instead of GitHub — for
#                    testing a build; the checksum is still required and checked
#   GITHUB_TOKEN / GH_TOKEN  sent (as a Bearer header, to api.github.com only) for the latest-
#                    version lookup, whose unauthenticated limit is 60 requests an hour per IP.
#                    Without one, or when the API refuses, the version comes from the
#                    github.com/…/releases/latest redirect instead.
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

# One release file ($1, by name) into $2: from DENEXT_ARTIFACTS when it is set, else downloaded
# from the release. Fails when the file is not there.
release_file() {
  if [ -n "${DENEXT_ARTIFACTS:-}" ]; then
    [ -f "$DENEXT_ARTIFACTS/$1" ] && cp "$DENEXT_ARTIFACTS/$1" "$2"
  else
    fetch "https://github.com/$REPO/releases/download/$VERSION/$1" -o "$2"
  fi
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
  if release_file SHA256SUMS "$TMP/SHA256SUMS" 2>/dev/null; then
    line="$(grep " $ASSET\$" "$TMP/SHA256SUMS" 2>/dev/null | head -1 || true)"
    if [ -n "$line" ]; then
      echo "$line" | cut -d' ' -f1
      return 0
    fi
  fi
  if release_file "$ASSET.sha256" "$TMP/$ASSET.sha256" 2>/dev/null; then
    cut -d' ' -f1 <"$TMP/$ASSET.sha256"
  fi
}

# The latest stable release's tag (`v2.5.0`), or nothing. The API first — with a token when one
# is set, its header fed through stdin so the token never shows in a process listing, and only
# on this api.github.com call (never on a download, which redirects off GitHub). Then, for a
# rate-limited API (shared CI runners and office NATs exhaust 60/hour), the tag the web page's
# `releases/latest` redirect lands on.
latest_tag() {
  api="https://api.github.com/repos/$REPO/releases/latest"
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -n "$token" ]; then
    json="$(printf 'Authorization: Bearer %s\n' "$token" | fetch -H @- "$api" 2>/dev/null || true)"
  else
    json="$(fetch "$api" 2>/dev/null || true)"
  fi
  tag="$(printf '%s\n' "$json" | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
  if [ -z "$tag" ]; then
    final="$(fetch -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
      2>/dev/null || true)"
    case "$final" in */releases/tag/*) tag="${final##*/releases/tag/}" ;; esac
  fi
  # Only ever a version tag: anything else (an error page's URL, a stray quote) is no answer.
  case "$tag" in v[0-9]*) ;; *) tag="" ;; esac
  case "$tag" in *[!A-Za-z0-9.+-]*) tag="" ;; esac
  printf '%s\n' "$tag"
}

main() {
  INSTALL_DIR="${DENEXT_INSTALL:-$HOME/.denext}"
  BIN_DIR="$INSTALL_DIR/bin"
  TARGET="$(target)"

  VERSION="${DENEXT_VERSION:-}"
  if [ -z "$VERSION" ] && [ -n "${DENEXT_ARTIFACTS:-}" ]; then
    VERSION="local"
  elif [ -z "$VERSION" ]; then
    # `releases/latest` is the newest NON-prerelease: an rc tag is published as a prerelease and
    # never becomes "latest", so this resolves a stable version unless one is asked for.
    VERSION="$(latest_tag)"
  fi
  [ -n "$VERSION" ] || {
    echo "denext: could not determine the latest release; set DENEXT_VERSION." >&2
    exit 1
  }

  ASSET="denext-$TARGET.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  if [ -n "${DENEXT_ARTIFACTS:-}" ]; then
    echo "denext: installing $ASSET from $DENEXT_ARTIFACTS"
  else
    echo "denext: downloading $VERSION for $TARGET"
  fi
  release_file "$ASSET" "$TMP/$ASSET" || {
    echo "denext: could not get $ASSET (${DENEXT_ARTIFACTS:-release $VERSION})." >&2
    exit 1
  }

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

  install_toolchain "$BIN_DIR/denext"
}

# Install denext's Deno toolchain through the new binary, and — when this machine has no `deno`
# — link `deno` to it. Never fatal: a failure is one warning, and the binary downloads the
# toolchain on the first command that needs it. An existing `deno` is never replaced: the link
# is made only when PATH has none, and `toolchain link` itself refuses to overwrite a file it
# did not create.
install_toolchain() {
  [ "${DENEXT_NO_TOOLCHAIN:-}" = "1" ] && return 0
  echo "denext: installing denext's Deno toolchain"
  if ! "$1" toolchain install; then
    echo "denext: warning — the Deno toolchain could not be installed now; it downloads on the" >&2
    echo "  first command that needs it (or run \`denext toolchain install\`)." >&2
    return 0
  fi
  if command -v deno >/dev/null 2>&1; then
    echo "denext: keeping your deno ($(command -v deno)); denext runs its own toolchain anyway"
    return 0
  fi
  [ "${DENEXT_NO_DENO_LINK:-}" = "1" ] && return 0
  if ! "$1" toolchain link; then
    echo "denext: warning — could not link \`deno\` to the toolchain (\`denext deno …\` still" >&2
    echo "  runs it)." >&2
  fi
}

main "$@"
