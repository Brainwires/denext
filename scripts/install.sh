#!/bin/sh
# denext installer — fetches the released `denext` binary for this platform.
#
#   curl -fsSL https://denext.dev/install.sh | sh
#
# The binary is a CLI, not a second copy of the framework: inside a project it defers to the
# denext version that project pins, so `denext build` builds exactly what `deno task build`
# would. It is all you need — Deno itself is not: after installing the binary the script runs
# `denext runtime upgrade`, which installs the newest denext runtime (denext's own Deno build) this
# denext supports, verified by the binary against the signed runtime channel, and makes it this
# machine's default; every verb runs on it (`denext task dev`, `denext test`, `denext fmt` …).
# When no `deno` is on your PATH it also runs `denext runtime link`, so `deno` is that runtime
# (a link at ~/.denext/bin/deno); an existing `deno` is never replaced, shadowed or used by
# denext. When `runtime upgrade` fails (the channel can't be read) it installs the runtime release
# this denext bundles instead (`denext runtime install`), and links that. A step that still fails
# (offline, say) is one warning, not a failed install: the binary downloads its runtime on the
# first command that needs it instead (and a command that can't get it stops with the fix, never
# running another Deno). This script never reads the channel itself: every runtime check is the
# binary's.
#
# A release from before `denext runtime` (DENEXT_VERSION=v4.20.1, say) gets the step it knew:
# `denext toolchain install` (+ `toolchain link`), or nothing before 4.0.
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin/`); default: ~/.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched, or when the release's
#                    build attestation can't be verified (never on a checksum mismatch)
#   DENEXT_REQUIRE_ATTESTATION  `1` refuses to install unless the archive's build attestation is
#                    verified (needs the GitHub CLI, `gh`, signed in)
#   DENEXT_NO_RUNTIME  `1` skips `denext runtime upgrade` (and the link): the runtime then
#                    downloads on the first command that needs it
#   DENEXT_NO_DENO_LINK  `1` skips `denext runtime link` (no `deno` is put on your PATH)
#   DENEXT_RUNTIME_ONLY  `1` is --runtime-only
#   DENEXT_RUNTIME_VERSION  a runtime version (`3.0.0-denext.<n>`) is --runtime=<version>
#   DENEXT_MODIFY_PATH  where to add denext's bin to PATH: `1` (your login shell's rc file),
#                    `all` (every installed shell's), `0` (nowhere) — the same as the flags below
#   DENEXT_ARTIFACTS a local directory holding the release files (`denext-<target>.tar.gz` and
#                    `SHA256SUMS` or `<archive>.sha256`) to install from instead of GitHub — for
#                    testing a build; the checksum is still required and checked
#   GITHUB_TOKEN / GH_TOKEN  sent (as a Bearer header, to api.github.com only) for the latest-
#                    version lookup, whose unauthenticated limit is 60 requests an hour per IP.
#                    Without one, or when the API refuses, the version comes from the
#                    github.com/…/releases/latest redirect instead.
#
# Flags (after `sh -s --`, e.g. `curl -fsSL https://denext.dev/install.sh | sh -s -- --no-modify-path`):
#   --modify-path       add denext's bin to PATH in your login shell's rc file (the default when
#                       there is no terminal to ask on)
#   --modify-path=all   …and in every other installed shell's (bash, zsh, fish, nushell, ~/.profile)
#   --no-modify-path    change no rc file (the script prints the line to add)
#   --runtime-only      move only the runtime: with denext already installed here, skip the binary
#                       and run `denext runtime upgrade` (the newest runtime it supports, past the
#                       dependency-age hold); without one, install both as usual
#   --runtime=<version> install that runtime release and make it this machine's default
#                       (`denext runtime install <version>` + `denext runtime use <version>`); with
#                       --runtime-only, on the denext already installed
#   --uninstall         remove the binary, the `deno` link `runtime link` made, and every PATH
#                       block this script wrote
#
# With --runtime-only or --runtime=<version> the runtime is what was asked for, so its step
# failing fails the run (exit 1); in a plain install it stays one warning.
#
# A script run through a pipe can't change the PATH of the shell that started it; what it can do is
# add one marked block (`# >>> denext >>>` … `# <<< denext <<<`) to your shell's startup file, so
# every new shell has it, and print the command that puts it on PATH in the current one. On a
# terminal it asks first. A re-run replaces the block, never adds a second one.
#
# Everything lives in main(), called on the last line inside `{ …; }`, so a download that is
# cut short runs nothing: `sh` executes a truncated script only up to where it stopped, never
# past the call, and a call cut inside that line is an unclosed `{`, which sh refuses to run
# (a bare `main "$@"` cut to `main` would run main without its flags: `--uninstall` would install).
set -eu

REPO="Brainwires/denext"

# Fetch a release URL: HTTPS only (no scheme downgrade through a redirect), TLS 1.2+, with curl,
# or GNU wget on a machine without it. A leading `--progress` draws a progress bar on stderr when
# it is a terminal (and nothing in a log or CI); every other fetch is quiet.
fetch() {
  quiet=-s
  if [ "${1:-}" = "--progress" ]; then
    shift
    if [ -t 2 ]; then quiet=--progress-bar; fi
  fi
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fSL "$quiet" "$@"
  elif command -v wget >/dev/null 2>&1; then
    fetch_wget "$quiet" "$@"
  else
    echo "denext: the installer needs curl or wget." >&2
    return 1
  fi
}

# fetch() through wget: the same arguments as the curl call (`-o <file>`, `-H @-`,
# `-o /dev/null -w '%{url_effective}'`). A token header fed on stdin is dropped (wget takes headers
# only on its command line, where any user could read it): the latest-version lookup then falls
# back to the releases/latest redirect.
fetch_wget() {
  bar="$1"
  shift
  out=-
  header=""
  wfmt=""
  url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) out="$2"; shift ;;
      -H) header="$2"; shift ;;
      -w) wfmt="$2"; shift ;;
      -*) ;;
      *) url="$1" ;;
    esac
    shift
  done
  if [ "$header" = "@-" ]; then
    cat >/dev/null
    case "$url" in https://api.github.com/*) return 1 ;; esac
  fi
  if [ -n "$wfmt" ]; then
    # Where the redirects end (curl's `%{url_effective}`): the last Location wget was sent.
    wget --https-only --secure-protocol=TLSv1_2 -S --spider "$url" 2>&1 |
      sed -n 's/^ *[Ll]ocation: *//p' | tr -d '\r' | tail -n 1
    return 0
  fi
  if [ "$bar" = "--progress-bar" ] && wget --help 2>/dev/null | grep -q -- --show-progress; then
    wget --https-only --secure-protocol=TLSv1_2 -q --show-progress -O "$out" "$url"
  else
    wget --https-only --secure-protocol=TLSv1_2 -q -O "$out" "$url"
  fi
}

target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  # A shell under Rosetta 2 reports x86_64 on an Apple silicon Mac: install the native build.
  if [ "$os-$arch" = "Darwin-x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch=arm64
  fi
  if [ "$os" = "Linux" ] && is_musl; then
    echo "denext: this Linux uses musl libc (Alpine, say); denext's Linux binaries and its Deno" >&2
    echo "  runtime are built for glibc and do not run here. Use a glibc-based system or image" >&2
    echo "  (Debian, Ubuntu, Fedora, the distroless/cc images…)." >&2
    exit 1
  fi
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

# Whether this Linux's C library is musl: what `ldd --version` names, else (no ldd) the musl
# loader's presence.
is_musl() {
  if command -v ldd >/dev/null 2>&1; then
    case "$(ldd --version 2>&1 || true)" in *musl* | *MUSL* | *Musl*) return 0 ;; esac
    return 1
  fi
  for loader in /lib/ld-musl-*; do [ -e "$loader" ] && return 0; done
  return 1
}

# One release file ($1, by name) into $2: from DENEXT_ARTIFACTS when it is set, else downloaded
# from the release (with a progress bar on a terminal when $3 is `--progress`). Fails when the
# file is not there.
release_file() {
  if [ -n "${DENEXT_ARTIFACTS:-}" ]; then
    [ -f "$DENEXT_ARTIFACTS/$1" ] && cp "$DENEXT_ARTIFACTS/$1" "$2"
  else
    fetch ${3:-} "https://github.com/$REPO/releases/download/$VERSION/$1" -o "$2"
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

# A private folder (mode 0700) to download and verify in, which the GitHub CLI can read, rather
# than /tmp: the snap store's gh has a private /tmp, and its `home` interface grants only the
# non-hidden paths under $HOME (not ~/.cache). Without a snap gh it is under the user's cache
# (`$XDG_CACHE_HOME/denext`, else `~/.cache/denext`); with one, under `$XDG_CACHE_HOME/denext`
# when that is a non-hidden folder under $HOME, else `$HOME/denext-install-XXXXXX`. Only when
# none can be made does it fall back to the system temp folder. The caller removes it on exit.
install_tmpdir() {
  cache="${XDG_CACHE_HOME:-${HOME:-}/.cache}"
  if gh_is_snap; then
    if [ -n "${XDG_CACHE_HOME:-}" ] && visible_under_home "$XDG_CACHE_HOME" &&
      mkdir -p "$XDG_CACHE_HOME/denext" 2>/dev/null &&
      private_dir "$XDG_CACHE_HOME/denext" install-XXXXXX; then
      return 0
    fi
    case "${HOME:-}" in /*) private_dir "$HOME" denext-install-XXXXXX && return 0 ;; esac
  else
    case "$cache" in
      /*) mkdir -p "$cache/denext" 2>/dev/null && private_dir "$cache/denext" install-XXXXXX &&
        return 0 ;;
    esac
  fi
  dir="$(mktemp -d)"
  chmod 700 "$dir"
  echo "$dir"
}

# Make (and print) a mode-0700 folder from the `mktemp` template `$2` in the folder `$1`.
private_dir() {
  dir="$(mktemp -d "$1/$2" 2>/dev/null)" || return 1
  chmod 700 "$dir"
  echo "$dir"
}

# Whether `$1` is under $HOME with no hidden (dot) folder on the way: what a snap can read.
visible_under_home() {
  case "${HOME:-}" in /*) ;; *) return 1 ;; esac
  case "$1" in "$HOME"/*) ;; *) return 1 ;; esac
  case "/${1#"$HOME"/}" in */.*) return 1 ;; esac
  return 0
}

# Whether `gh` is the snap store's: found as `.../snap/bin/gh`, or resolving into /snap/.
gh_is_snap() {
  gh_path="$(command -v gh 2>/dev/null)" || return 1
  case "$gh_path" in */snap/bin/gh) return 0 ;; esac
  gh_real="$(readlink -f "$gh_path" 2>/dev/null || echo "$gh_path")"
  case "$gh_real" in /snap/*) return 0 ;; esac
  return 1
}

# Whether gh's output says it could not open the file it was given (not a failed verification).
gh_cannot_open() {
  case "$1" in *"open local artifact"* | *"no such file or directory"*) return 0 ;; esac
  return 1
}

# The checksum proves the archive is the one the release lists, not that the release is
# denext's: whoever can replace a release's files can replace SHA256SUMS too. Every archive also
# carries a build-provenance attestation (Sigstore, signed by GitHub for publish.yml on this
# repository), which the GitHub CLI verifies: with `gh` installed and signed in, the archive must
# pass `gh attestation verify` or nothing is installed. Without it the install goes ahead on the
# checksum and says so, unless DENEXT_REQUIRE_ATTESTATION=1. A local DENEXT_ARTIFACTS build has
# no attestation and skips this.
verify_attestation() {
  if [ -n "${DENEXT_ARTIFACTS:-}" ]; then return 0; fi
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    if [ "${DENEXT_REQUIRE_ATTESTATION:-}" = "1" ]; then
      echo "denext: DENEXT_REQUIRE_ATTESTATION=1 needs the GitHub CLI (gh), signed in, to verify" >&2
      echo "  the release's build attestation — not installing." >&2
      exit 1
    fi
    echo "denext: build attestation not checked (install and sign in to the GitHub CLI, gh, to"
    echo "  verify it; DENEXT_REQUIRE_ATTESTATION=1 makes it required)"
    return 0
  fi
  # A gh from before `gh attestation` (2.49) can't verify one: as if there were no gh.
  if ! gh attestation verify --help >/dev/null 2>&1; then
    if [ "${DENEXT_REQUIRE_ATTESTATION:-}" = "1" ]; then
      echo "denext: DENEXT_REQUIRE_ATTESTATION=1, but this GitHub CLI ($(gh --version 2>/dev/null |
        head -n 1)) has no \`gh attestation\`; update gh — not installing." >&2
      exit 1
    fi
    echo "denext: build attestation not checked (this GitHub CLI has no \`gh attestation\`;"
    echo "  update gh to verify it; DENEXT_REQUIRE_ATTESTATION=1 makes it required)"
    return 0
  fi
  if gh_out="$(gh attestation verify "$1" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/publish.yml" 2>&1)"; then
    echo "denext: build attestation verified (built by $REPO's publish workflow)"
    return 0
  fi
  if gh_is_snap && gh_cannot_open "$gh_out"; then
    # Not a missing attestation: the snap's confinement hides the downloaded file from gh.
    echo "denext: the GitHub CLI here is a snap ($(command -v gh)), and snap confinement means it" >&2
    echo "  cannot read the downloaded archive ($1), so its build attestation was not verified." >&2
    if [ "${DENEXT_INSECURE:-}" != "1" ]; then
      echo "  Not installing. A snap can read only non-hidden folders under your home: make sure" >&2
      echo "  \$HOME is writable, or point XDG_CACHE_HOME at a non-hidden folder under your home" >&2
      echo "  (XDG_CACHE_HOME=\$HOME/denext-cache; the installer downloads into \$XDG_CACHE_HOME/denext)," >&2
      echo "  or install gh from apt or https://github.com/cli/cli/releases instead of the snap," >&2
      echo "  then run this again." >&2
      exit 1
    fi
  fi
  if [ "${DENEXT_INSECURE:-}" = "1" ]; then
    echo "denext: WARNING — the build attestation of $ASSET could not be verified; installing on" >&2
    echo "  the checksum alone because DENEXT_INSECURE=1 is set." >&2
    return 0
  fi
  echo "denext: the build attestation of $ASSET could not be verified — not installing." >&2
  echo "  \`gh attestation verify $ASSET --repo $REPO\` said:" >&2
  printf '%s\n' "$gh_out" | sed 's/^/    /' >&2
  echo "  A network problem (gh reaches GitHub and Sigstore), a gh token without access, or a" >&2
  echo "  release with no attestation (denext 4.9.0 and earlier) fails this as well as a" >&2
  echo "  tampered archive: retry once the cause is fixed. DENEXT_INSECURE=1 installs on the" >&2
  echo "  checksum alone." >&2
  exit 1
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
  parse_args "$@"
  INSTALL_DIR="${DENEXT_INSTALL:-$HOME/.denext}"
  BIN_DIR="$INSTALL_DIR/bin"
  # `runtime link` / `unlink` put `deno` in $DENEXT_INSTALL/bin: name the directory this run
  # resolved, so the link lands beside the binary in the bin/ that goes on PATH.
  DENEXT_INSTALL="$INSTALL_DIR"
  export DENEXT_INSTALL
  if [ "$UNINSTALL" = "1" ]; then
    uninstall
    return 0
  fi
  if [ "$RUNTIME_ONLY" = "1" ]; then
    if [ -x "$BIN_DIR/denext" ]; then
      runtime_only "$BIN_DIR/denext"
      return 0
    fi
    echo "denext: no denext at $BIN_DIR/denext yet: installing it and its runtime"
  fi
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
  TMP="$(install_tmpdir)"
  trap 'rm -rf "$TMP"' EXIT

  if [ -n "${DENEXT_ARTIFACTS:-}" ]; then
    echo "denext: installing $ASSET from $DENEXT_ARTIFACTS"
  else
    echo "denext: downloading $VERSION for $TARGET"
  fi
  release_file "$ASSET" "$TMP/$ASSET" --progress || {
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
  verify_attestation "$TMP/$ASSET"

  tar xzf "$TMP/$ASSET" -C "$TMP"
  chmod +x "$TMP/denext"
  # An unsigned macOS download carries the quarantine attribute; strip it so the binary runs.
  if [ "$(uname -s)" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$TMP/denext" 2>/dev/null || true
  fi
  # The binary must run here before it replaces anything: a C library it can't load (an older
  # glibc than it was built for) fails this, and the install with it.
  if ! installed_version="$("$TMP/denext" --version 2>&1)"; then
    echo "denext: the downloaded denext does not run on this machine — not installing." >&2
    printf '  %s\n' "$installed_version" >&2
    echo "  denext's Linux build needs glibc 2.27 or newer (\`ldd --version\` shows this system's)." >&2
    exit 1
  fi
  mkdir -p "$BIN_DIR"
  mv "$TMP/denext" "$BIN_DIR/denext"
  BINARY_INSTALLED=1

  echo "denext: installed $installed_version to $BIN_DIR/denext"

  install_runtime "$BIN_DIR/denext"
  setup_path
}

# The command line: the PATH mode (MODIFY_PATH: `current`, `all`, `no`, or `` to ask) and
# UNINSTALL. DENEXT_MODIFY_PATH is the same choice as an environment variable; a flag wins.
parse_args() {
  UNINSTALL=0
  BINARY_INSTALLED=0
  RUNTIME_ONLY=0
  [ "${DENEXT_RUNTIME_ONLY:-}" = "1" ] && RUNTIME_ONLY=1
  RUNTIME_VERSION="${DENEXT_RUNTIME_VERSION:-}"
  MODIFY_PATH="$(path_mode "${DENEXT_MODIFY_PATH:-}")"
  while [ $# -gt 0 ]; do
    case "$1" in
      --runtime-only) RUNTIME_ONLY=1 ;;
      --runtime=*) RUNTIME_VERSION="${1#--runtime=}" ;;
      --runtime)
        echo "denext: --runtime takes a version: --runtime=<version> (3.0.0-denext.<n>)" >&2
        exit 2
        ;;
      --modify-path | --modify-path=current | --modify-path=1 | --modify-path=yes) MODIFY_PATH=current ;;
      --modify-path=all) MODIFY_PATH=all ;;
      --no-modify-path | --modify-path=0 | --modify-path=no) MODIFY_PATH=no ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help)
        echo "usage: curl -fsSL https://denext.dev/install.sh | sh -s -- [options]"
        echo "  --modify-path       add denext to PATH in your login shell's startup file"
        echo "  --modify-path=all   ...and in every other installed shell's"
        echo "  --no-modify-path    change no startup file"
        echo "  --runtime-only      update only the runtime of the denext installed here"
        echo "  --runtime=<version> install that runtime release and make it the default"
        echo "  --uninstall         remove denext, the deno link and the PATH blocks this script added"
        exit 0
        ;;
      *)
        echo "denext: unknown option $1 (--modify-path[=all], --no-modify-path, --runtime-only," \
          "--runtime=<version>, --uninstall)" >&2
        exit 2
        ;;
    esac
    shift
  done
  check_runtime_version "$RUNTIME_VERSION"
  if [ "${DENEXT_NO_RUNTIME:-}" = "1" ] && { [ "$RUNTIME_ONLY" = "1" ] || [ -n "$RUNTIME_VERSION" ]; }; then
    echo "denext: DENEXT_NO_RUNTIME=1 skips the runtime, which --runtime-only / --runtime=<version>" \
      "ask for: nothing to do" >&2
    exit 2
  fi
}

# A --runtime=<version> is a runtime release version (`3.0.0-denext.<n>`): checked here only for
# its shape, so it never reaches a command line as anything else; the binary checks the rest.
check_runtime_version() {
  [ -z "$1" ] && return 0
  case "$1" in
    *[!A-Za-z0-9.+-]* | -*)
      echo "denext: --runtime=$1 is not a runtime version (3.0.0-denext.<n>)" >&2
      exit 2
      ;;
  esac
}

# DENEXT_MODIFY_PATH's value as a mode (see parse_args); an unknown value is fatal.
path_mode() {
  case "$1" in
    "") echo "" ;;
    1 | yes | true | current) echo current ;;
    all) echo all ;;
    0 | no | false | none) echo no ;;
    *)
      echo "denext: DENEXT_MODIFY_PATH=$1 is not one of 1, all, 0" >&2
      exit 2
      ;;
  esac
}

# The marked block's first and last lines (what --uninstall and a re-run look for).
BLOCK_START="# >>> denext >>>"
BLOCK_END="# <<< denext <<<"

# $1 with $HOME spelled `$HOME` (for an rc file that may be shared between machines).
home_relative() {
  case "$1" in
    "$HOME"/*) printf '%s\n' "\$HOME/${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# $1 with $HOME shown as `~` (for messages).
pretty() {
  case "$1" in
    "$HOME"/*) printf '%s\n' "~/${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# The shell name of a path (`/bin/zsh` → zsh, `-zsh` → zsh).
shell_name() {
  name="${1##*/}"
  name="${name#-}"
  case "$name" in
    zsh | bash | fish | nu) echo "$name" ;;
    *) echo sh ;;
  esac
}

# The file bash reads for a login shell on macOS (Terminal opens login shells): the first of
# ~/.bash_profile, ~/.bash_login and ~/.profile that exists — creating ~/.bash_profile when
# ~/.profile exists would stop bash reading ~/.profile — else ~/.bash_profile.
bash_login_file() {
  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -e "$f" ] && { echo "$f"; return 0; }
  done
  echo "$HOME/.bash_profile"
}

# nushell's env.nu (`$nu.env-path`), when `nu` is installed.
nu_env_file() {
  command -v nu >/dev/null 2>&1 || return 0
  nu -n -c '$nu.env-path' 2>/dev/null | head -n 1
}

# The startup files of shell $1, one per line.
rc_files() {
  case "$1" in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      echo "$HOME/.bashrc"
      [ "$(uname -s)" = "Darwin" ] && bash_login_file
      ;;
    fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/denext.fish" ;;
    nu) nu_env_file ;;
    *) echo "$HOME/.profile" ;;
  esac
  return 0
}

# The block that puts $BIN_DIR on PATH, in the syntax of the shell that reads file $1.
path_block() {
  dir="$(home_relative "$BIN_DIR")"
  echo "$BLOCK_START"
  echo "# Added by the denext installer: puts denext on PATH. Remove it with"
  echo "#   curl -fsSL https://denext.dev/install.sh | sh -s -- --uninstall"
  case "$1" in
    *.fish)
      echo "if not contains -- \"$dir\" \$PATH"
      echo "  set -gx PATH \"$dir\" \$PATH"
      echo "end"
      ;;
    *.nu)
      dir="$BIN_DIR"
      echo "\$env.PATH = (\$env.PATH | split row (char esep) | where {|p| \$p != '$dir' } | prepend '$dir')"
      ;;
    *)
      echo "case \":\${PATH}:\" in"
      echo "  *\":$dir:\"*) ;;"
      echo "  *) export PATH=\"$dir:\$PATH\" ;;"
      echo "esac"
      ;;
  esac
  echo "$BLOCK_END"
}

# File $1 without the marked block, on stdout. A start marker with no end marker after it (an
# edited file) drops only that marker line: every line after it is kept.
without_block() {
  awk -v s="$BLOCK_START" -v e="$BLOCK_END" '
    !skip && $0 == s { skip = 1; n = 0; next }
    skip && $0 == e { skip = 0; n = 0; next }
    skip { held[++n] = $0; next }
    { print }
    END { for (i = 1; i <= n; i++) print held[i] }
  ' "$1"
}

# Write stdin over file $1 in place (`cat >` keeps a symlinked dotfile a symlink, and its mode).
overwrite() {
  tmp_rc="$1.denext-tmp.$$"
  status=0
  { cat >"$tmp_rc" && cat "$tmp_rc" >"$1"; } 2>/dev/null || status=1
  rm -f "$tmp_rc"
  return "$status"
}

# Add the block to file $1 (replacing an earlier one); prints what it did. A file it can't
# write (read-only, owned by root) is one warning with the lines to add by hand, never a failed
# install: the binary is already in place.
add_block() {
  rc="$1"
  if ! write_block "$rc"; then
    echo "denext: warning — could not write $(pretty "$rc"); add these lines to it yourself:" >&2
    path_block "$rc" | sed 's/^/  /' >&2
  fi
}

# add_block's write: status 1 when file $1 (or its folder) can't be written.
write_block() {
  mkdir -p "$(dirname "$1")" 2>/dev/null || return 1
  if has_block "$1"; then
    { without_block "$1"; path_block "$1"; } | overwrite "$1" || return 1
    echo "denext: updated the PATH block in $(pretty "$1")"
    return 0
  fi
  if [ -e "$1" ] && [ ! -w "$1" ]; then return 1; fi
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then
    { echo >>"$1"; } 2>/dev/null || return 1
  fi
  { path_block "$1" >>"$1"; } 2>/dev/null || return 1
  echo "denext: added denext to PATH in $(pretty "$1")"
}

# Remove the block from file $1 (and the file, when it is fish's conf.d file and now empty).
remove_block() {
  rc="$1"
  has_block "$rc" || return 0
  without_block "$rc" | overwrite "$rc"
  case "$rc" in */conf.d/denext.fish) [ -s "$rc" ] || rm -f "$rc" ;; esac
  echo "denext: removed denext's PATH block from $(pretty "$rc")"
}

# The installed shells other than $1, space-separated (each found by `command -v`).
other_shells() {
  others=""
  for sh_name in zsh bash fish nu; do
    [ "$sh_name" = "$1" ] && continue
    command -v "$sh_name" >/dev/null 2>&1 && others="$others $sh_name"
  done
  echo "${others# }"
}

# Ask $1 on the terminal (fd 3, opened by setup_path); default $2 (y or n). Prints y or n. The
# end of input answers the default.
ask() {
  printf '%s ' "$1" >&2
  if ! IFS= read -r answer <&3; then
    echo >&2
    answer=""
  fi
  case "$answer" in
    [Yy]*) echo y ;;
    [Nn]*) echo n ;;
    *) echo "$2" ;;
  esac
}

# The terminal to ask on: /dev/tty when this process has one (`curl … | sh` reads the script from
# stdin, so stdin is never it), else nothing. DENEXT_TTY names another file (the tests' answers).
prompt_input() {
  tty="${DENEXT_TTY:-/dev/tty}"
  if (: <"$tty") 2>/dev/null; then echo "$tty"; fi
}

# Whether file $1 holds the marked block.
has_block() {
  [ -f "$1" ] && grep -qxF "$BLOCK_START" "$1"
}

# Put $BIN_DIR on PATH for new shells (per MODIFY_PATH, asking when unset and there is a
# terminal) and say how to use it in this one.
setup_path() {
  current="$(shell_name "${SHELL:-sh}")"
  mode="$MODIFY_PATH"
  first="$(rc_files "$current" | head -n 1)"
  # A re-run (an upgrade) keeps the block it wrote up to date without asking again.
  if [ -z "$mode" ] && [ -n "$first" ] && has_block "$first"; then mode=current; fi
  if [ -z "$mode" ]; then
    input="$(prompt_input)"
    if [ -n "$input" ]; then
      exec 3<"$input"
      if [ "$(ask "denext: add denext to PATH in $(pretty "${first:-$HOME/.profile}")? [Y/n]" y)" = y ]; then
        mode=current
        others="$(other_shells "$current")"
        if [ -n "$others" ] &&
          [ "$(ask "denext: also add it to your other installed shells ($(echo "$others" | sed 's/ /, /g'))? [y/N]" n)" = y ]; then
          mode=all
        fi
      else
        mode=no
      fi
      exec 3<&-
    else
      mode=current
    fi
  fi

  if [ "$mode" != "no" ]; then
    shells="$current"
    [ "$mode" = "all" ] && shells="$current $(other_shells "$current") sh"
    # One per line (a path may hold spaces: nushell's on macOS does), each once.
    for sh_name in $shells; do rc_files "$sh_name"; done | awk 'NF && !seen[$0]++' |
      while IFS= read -r rc; do add_block "$rc"; done
  fi

  case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac
  echo
  echo "This script ran in its own process, so it could not change the PATH of the shell you"
  echo "started it from. To use denext in this shell now, run:"
  case "$current" in
    fish) echo "  set -gx PATH \"$BIN_DIR\" \$PATH" ;;
    nu) echo "  \$env.PATH = (\$env.PATH | prepend '$BIN_DIR')" ;;
    *) echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  if [ "$mode" = "no" ]; then
    echo "and add that line to your shell's startup file to keep it (or re-run with --modify-path)."
  else
    case "$current" in
      zsh | bash) echo "or reload your startup file:  source $(pretty "$first")" ;;
    esac
    echo "or start a new login shell:   exec \$SHELL -l"
  fi
}

# --uninstall: the `deno` link `runtime link` (or an older release's `toolchain link`) made (only
# its own), the binary, the PATH blocks in every shell's startup files, then bin/ and the install
# directory when nothing else is left.
uninstall() {
  if [ -x "$BIN_DIR/denext" ]; then
    case "$(runtime_verb "$BIN_DIR/denext")" in
      runtime) denext_at_home "$BIN_DIR/denext" runtime unlink >/dev/null 2>&1 || true ;;
      toolchain) denext_at_home "$BIN_DIR/denext" toolchain unlink >/dev/null 2>&1 || true ;;
    esac
  fi
  rm -f "$BIN_DIR/denext"
  {
    for sh_name in zsh bash fish nu sh; do rc_files "$sh_name"; done
    echo "$HOME/.bash_profile"
    echo "$HOME/.bash_login"
  } | awk 'NF && !seen[$0]++' | while IFS= read -r rc; do remove_block "$rc"; done
  rmdir "$BIN_DIR" 2>/dev/null || true
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  echo "denext: removed denext from $INSTALL_DIR"
  echo "  (denext's runtime cache stays; \`denext runtime uninstall --all\` before this removes"
  echo "  it)"
}

# Run the binary at $1 with the rest as its arguments, from the install directory rather than
# the caller's: inside a project the binary defers to the denext that project pins, which may be
# one without the verb asked for, and the runtime steps are this machine's, not a project's.
denext_at_home() {
  bin="$1"
  shift
  (cd "$INSTALL_DIR" 2>/dev/null || cd /; "$bin" "$@")
}

# Which runtime verb the binary at $1 has: `runtime` (`denext runtime …`), `toolchain` (denext 4.0
# up to the runtime channel) or `none` (before 4.0). Read from its --help, which runs no project
# code and downloads nothing; a binary whose help names neither is taken by its version: before
# 4.0 `none`, else (an unreadable answer) the current `runtime`.
runtime_verb() {
  help="$(denext_at_home "$1" --help 2>/dev/null || true)"
  case "$help" in
    *"denext runtime "*) echo runtime ;;
    *"denext toolchain "*) echo toolchain ;;
    *)
      major="$("$1" --version 2>/dev/null | sed -n 's/^denext \([0-9][0-9]*\)\..*/\1/p' | head -n 1)"
      if [ -n "$major" ] && [ "$major" -lt 4 ]; then echo none; else echo runtime; fi
      ;;
  esac
}

# --runtime-only with denext installed: move only its runtime. A binary from before `denext
# runtime` can't, and says how to get one that can.
runtime_only() {
  if [ "$(runtime_verb "$1")" != runtime ]; then
    echo "denext: $("$1" --version) at $1 predates \`denext runtime\`, so --runtime-only can't move" >&2
    echo "  its runtime. Run the installer without --runtime-only to install the latest denext and" >&2
    echo "  its runtime." >&2
    exit 1
  fi
  echo "denext: $("$1" --version) is installed; updating only its runtime"
  install_runtime "$1"
}

# Install the runtime through the binary at $1: the newest one it supports (`runtime upgrade`,
# which also makes it this machine's default), or the --runtime=<version> asked for (`runtime
# install` + `runtime use`); then, when this machine has no `deno`, link `deno` to it. Every check
# (the signed channel, the release document's hash, each archive's SHA-256, the hold) is the
# binary's. In a plain install a failed `runtime upgrade` falls back to `runtime install` (the
# release this denext bundles), and a failure of that too is one warning: the binary downloads its
# runtime on the first command that needs it; with --runtime-only or --runtime=<version> a failure
# fails the run. An
# existing `deno` is never replaced: the link is made only when PATH has none, and `runtime link`
# itself refuses to overwrite a file it did not create.
install_runtime() {
  [ "${DENEXT_NO_RUNTIME:-}" = "1" ] && return 0
  verb="$(runtime_verb "$1")"
  if [ "$verb" != runtime ]; then
    if [ -n "$RUNTIME_VERSION" ]; then
      echo "denext: $("$1" --version) predates \`denext runtime\`, so it can't install runtime" >&2
      echo "  $RUNTIME_VERSION; install a newer denext (leave DENEXT_VERSION unset)." >&2
      exit 1
    fi
    if [ "$verb" = toolchain ]; then install_toolchain "$1"; else no_toolchain_note "$1"; fi
    return 0
  fi
  if [ -n "$RUNTIME_VERSION" ]; then
    echo "denext: installing denext runtime $RUNTIME_VERSION"
    if ! denext_at_home "$1" runtime install "$RUNTIME_VERSION" ||
      ! denext_at_home "$1" runtime use "$RUNTIME_VERSION"; then
      runtime_failed "denext runtime install $RUNTIME_VERSION && denext runtime use $RUNTIME_VERSION"
      return 0
    fi
  else
    echo "denext: installing the newest denext runtime this denext supports"
    if ! denext_at_home "$1" runtime upgrade; then
      # --runtime-only asked for the newest runtime: nothing else stands in for it.
      [ "$RUNTIME_ONLY" = "1" ] && runtime_failed "denext runtime upgrade"
      # A plain install falls back to the release this denext bundles (`runtime install` with no
      # version: the selected release, found without the channel), so a channel that can't be
      # read (not published yet, unreachable) still leaves a runtime and the `deno` link.
      echo "denext: the newest runtime could not be installed (see above); installing the" \
        "runtime this denext bundles instead" >&2
      if ! denext_at_home "$1" runtime install; then
        runtime_failed "denext runtime install"
        return 0
      fi
    fi
  fi
  link_deno "$1" runtime
}

# The runtime step failed: fatal when the runtime was what this run was for (--runtime-only,
# --runtime=<version>), else one warning naming the command to run later.
runtime_failed() {
  if [ "$RUNTIME_ONLY" = "1" ] || [ -n "$RUNTIME_VERSION" ]; then
    if [ "$BINARY_INSTALLED" = "1" ]; then
      # The binary is in place: it still goes on PATH, and the message says so.
      setup_path
      echo "denext: denext is installed at $BIN_DIR/denext, but the runtime could not be" \
        "installed (see above)." >&2
    else
      echo "denext: the runtime could not be installed (see above); nothing else changed." >&2
    fi
    [ -n "$RUNTIME_VERSION" ] &&
      echo "  Check the version: \`denext runtime list\` shows the releases this denext can use." >&2
    echo "  Fix the cause and run \`$1\` (or this installer again)." >&2
    exit 1
  fi
  echo "denext: warning — the denext runtime could not be installed now; it downloads on the" >&2
  echo "  first command that needs it (or run \`$1\`)." >&2
}

# With the runtime in place: tell a machine that has its own `deno` that it is left alone, else
# link `deno` to the runtime (`<verb> link`, $2 being `runtime` or an older release's `toolchain`).
link_deno() {
  if command -v deno >/dev/null 2>&1; then
    echo "denext: denext uses its own Deno ($(runtime_version "$1" "$2")); your deno at" \
      "$(command -v deno | sed "s|^$HOME/|~/|") is not changed or used by denext"
    return 0
  fi
  [ "${DENEXT_NO_DENO_LINK:-}" = "1" ] && return 0
  if ! denext_at_home "$1" "$2" link; then
    echo "denext: warning — could not link \`deno\` to the $2 (\`denext deno …\` still runs it)." >&2
  fi
}

# A release older than 4.0 has no runtime step at all.
no_toolchain_note() {
  echo "denext: $("$1" --version) predates denext's Deno toolchain (denext 4.0); skipping that"
  echo "  step — this release runs on the deno on your PATH."
}

# A release from denext 4.0 until `denext runtime` (DENEXT_VERSION=v4.20.1): its own step,
# `toolchain install` (+ `toolchain link`), with the same never-fatal rules.
install_toolchain() {
  echo "denext: installing denext's Deno toolchain"
  if ! denext_at_home "$1" toolchain install; then
    echo "denext: warning — the Deno toolchain could not be installed now; it downloads on the" >&2
    echo "  first command that needs it (or run \`denext toolchain install\`)." >&2
    return 0
  fi
  link_deno "$1" toolchain
}

# The runtime version the binary at $1 runs (`3.0.0-denext.<n>`), from `runtime version --json` (or
# an older release's `toolchain status --json`, $2 = `toolchain`), or `the pinned build`.
runtime_version() {
  if [ "$2" = toolchain ]; then
    json="$(denext_at_home "$1" toolchain status --json 2>/dev/null || true)"
  else
    json="$(denext_at_home "$1" runtime version --json 2>/dev/null || true)"
  fi
  # `runtime version --json` nests it as `runtime.version` (indented 4); `toolchain status --json`
  # has it at the top (indented 2).
  indent="    "
  [ "$2" = toolchain ] && indent="  "
  v="$(printf '%s\n' "$json" | sed -n "s/^$indent\"version\": \"\([^\"]*\)\".*/\1/p" | head -n 1)"
  echo "${v:-the pinned build}"
}

{ main "$@"; exit; }
