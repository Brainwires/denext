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
# (a link at ~/.denext/bin/deno); an existing `deno` is never replaced, shadowed or used by
# denext. Either step failing (offline, say) is one warning, not a failed install: the binary
# downloads the toolchain on the first command that needs it instead (and a command that can't
# get it stops with the fix, never running another Deno).
#
# Environment:
#   DENEXT_VERSION   the release tag to install (`v2.5.0`); default: the latest stable release
#   DENEXT_INSTALL   where to install (the binary lands in its `bin/`); default: ~/.denext
#   DENEXT_INSECURE  `1` installs even when no checksum can be fetched (never on a mismatch)
#   DENEXT_NO_TOOLCHAIN  `1` skips `denext toolchain install` (and the link): the toolchain then
#                    downloads on the first command that needs it
#   DENEXT_NO_DENO_LINK  `1` skips `denext toolchain link` (no `deno` is put on your PATH)
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
#   --uninstall         remove the binary, the `deno` link `toolchain link` made, and every PATH
#                       block this script wrote
#
# A script run through a pipe can't change the PATH of the shell that started it; what it can do is
# add one marked block (`# >>> denext >>>` … `# <<< denext <<<`) to your shell's startup file, so
# every new shell has it, and print the command that puts it on PATH in the current one. On a
# terminal it asks first. A re-run replaces the block, never adds a second one.
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
  parse_args "$@"
  INSTALL_DIR="${DENEXT_INSTALL:-$HOME/.denext}"
  BIN_DIR="$INSTALL_DIR/bin"
  if [ "$UNINSTALL" = "1" ]; then
    uninstall
    return 0
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

  install_toolchain "$BIN_DIR/denext"
  setup_path
}

# The command line: the PATH mode (MODIFY_PATH: `current`, `all`, `no`, or `` to ask) and
# UNINSTALL. DENEXT_MODIFY_PATH is the same choice as an environment variable; a flag wins.
parse_args() {
  UNINSTALL=0
  MODIFY_PATH="$(path_mode "${DENEXT_MODIFY_PATH:-}")"
  while [ $# -gt 0 ]; do
    case "$1" in
      --modify-path | --modify-path=current | --modify-path=1 | --modify-path=yes) MODIFY_PATH=current ;;
      --modify-path=all) MODIFY_PATH=all ;;
      --no-modify-path | --modify-path=0 | --modify-path=no) MODIFY_PATH=no ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help)
        echo "usage: curl -fsSL https://denext.dev/install.sh | sh -s -- [options]"
        echo "  --modify-path       add denext to PATH in your login shell's startup file"
        echo "  --modify-path=all   ...and in every other installed shell's"
        echo "  --no-modify-path    change no startup file"
        echo "  --uninstall         remove denext and the PATH blocks this script added"
        exit 0
        ;;
      *)
        echo "denext: unknown option $1 (--modify-path[=all], --no-modify-path, --uninstall)" >&2
        exit 2
        ;;
    esac
    shift
  done
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

# File $1 without the marked block, on stdout.
without_block() {
  awk -v s="$BLOCK_START" -v e="$BLOCK_END" '
    $0 == s { skip = 1; next }
    skip && $0 == e { skip = 0; next }
    !skip { print }
  ' "$1"
}

# Write stdin over file $1 in place (`cat >` keeps a symlinked dotfile a symlink, and its mode).
overwrite() {
  tmp_rc="$1.denext-tmp.$$"
  cat >"$tmp_rc" && cat "$tmp_rc" >"$1"
  rm -f "$tmp_rc"
}

# Add the block to file $1 (replacing an earlier one); prints what it did.
add_block() {
  rc="$1"
  mkdir -p "$(dirname "$rc")"
  if has_block "$rc"; then
    { without_block "$rc"; path_block "$rc"; } | overwrite "$rc"
    echo "denext: updated the PATH block in $(pretty "$rc")"
    return 0
  fi
  if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then echo >>"$rc"; fi
  path_block "$rc" >>"$rc"
  echo "denext: added denext to PATH in $(pretty "$rc")"
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

# --uninstall: the `deno` link `toolchain link` made (only its own), the binary, the PATH blocks
# in every shell's startup files, then bin/ and the install directory when nothing else is left.
uninstall() {
  if [ -x "$BIN_DIR/denext" ] && has_toolchain_verb "$BIN_DIR/denext"; then
    "$BIN_DIR/denext" toolchain unlink >/dev/null 2>&1 || true
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
  echo "  (denext's Deno toolchain cache stays; \`denext toolchain uninstall --all\` before"
  echo "  this removes it)"
}

# Install denext's Deno toolchain through the new binary, and — when this machine has no `deno`
# — link `deno` to it. Never fatal: a failure is one warning, and the binary downloads the
# toolchain on the first command that needs it. An existing `deno` is never replaced: the link
# is made only when PATH has none, and `toolchain link` itself refuses to overwrite a file it
# did not create.
install_toolchain() {
  [ "${DENEXT_NO_TOOLCHAIN:-}" = "1" ] && return 0
  if ! has_toolchain_verb "$1"; then
    echo "denext: $("$1" --version) predates denext's Deno toolchain (denext 4.0); skipping that"
    echo "  step — this release runs on the deno on your PATH."
    return 0
  fi
  echo "denext: installing denext's Deno toolchain"
  if ! "$1" toolchain install; then
    echo "denext: warning — the Deno toolchain could not be installed now; it downloads on the" >&2
    echo "  first command that needs it (or run \`denext toolchain install\`)." >&2
    return 0
  fi
  if command -v deno >/dev/null 2>&1; then
    echo "denext: denext uses its own Deno ($(toolchain_version "$1")); your deno at" \
      "$(command -v deno | sed "s|^$HOME/|~/|") is not changed or used by denext"
    return 0
  fi
  [ "${DENEXT_NO_DENO_LINK:-}" = "1" ] && return 0
  if ! "$1" toolchain link; then
    echo "denext: warning — could not link \`deno\` to the toolchain (\`denext deno …\` still" >&2
    echo "  runs it)." >&2
  fi
}

# The Deno toolchain version the binary at $1 pins (`2.9.7-denext.22`), or `the pinned build`.
toolchain_version() {
  v="$("$1" toolchain status --json 2>/dev/null | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -n 1)"
  echo "${v:-the pinned build}"
}

# Whether the binary at $1 has the `toolchain` verb, which denext 4.0 added: an older release
# (DENEXT_VERSION=v3.x) answers it with `unknown command`. A version it cannot read is assumed new.
has_toolchain_verb() {
  major="$("$1" --version 2>/dev/null | sed -n 's/^denext \([0-9][0-9]*\)\..*/\1/p' | head -n 1)"
  [ -z "$major" ] || [ "$major" -ge 4 ]
}

main "$@"
