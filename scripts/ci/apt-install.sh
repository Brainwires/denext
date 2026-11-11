#!/usr/bin/env bash
# Installs Debian packages for a CI job without depending on one good apt run.
#
#   scripts/ci/apt-install.sh [--with-recommends] <package | ./local.deb>...
#   scripts/ci/apt-install.sh --configure
#
# - A package already installed is skipped, and with every package present
#   nothing is fetched at all: our self-hosted Linux images (biscuits'
#   denext-ci-linux and denext-ci-linux-2204) carry every package these jobs
#   name, so a job there downloads nothing. A local `.deb` path is always
#   installed (apt fetches its dependencies).
# - Every apt run after this one, including apt-get calls another tool makes
#   (Playwright's `install --with-deps`), gets the same retries and timeouts
#   from an apt.conf.d drop-in; `--configure` writes only that.
# - Otherwise apt runs with its own retries and timeouts (Acquire::Retries,
#   Acquire::http(s)::Timeout, a dpkg lock wait), each `apt-get update` /
#   `install` under `timeout`, and the whole try is repeated with a backoff.
#   From the third try on, the Ubuntu archive sources point at a fallback
#   mirror (GitHub's images use azure.archive.ubuntu.com, whose lookups have
#   failed with exit 100), so one mirror or one DNS name can't fail the job.
#
# Env: APT_INSTALL_TRIES (default 4), APT_INSTALL_MIRRORS (space-separated
# fallback archive URLs, tried in turn; default per architecture),
# APT_INSTALL_DELAY (the first backoff, seconds; default 15), APT_ETC (default
# /etc/apt; the tests point it elsewhere).
set -euo pipefail

sudo=
if [ "$(id -u)" != 0 ]; then sudo=sudo; fi
etc=${APT_ETC:-/etc/apt}

# apt's own retries and timeouts for every apt run in this job.
configure() {
  $sudo mkdir -p "$etc/apt.conf.d"
  printf '%s\n' \
    'Acquire::Retries "5";' \
    'Acquire::http::Timeout "30";' \
    'Acquire::https::Timeout "30";' \
    'DPkg::Lock::Timeout "300";' |
    $sudo tee "$etc/apt.conf.d/80-denext-ci-retries" >/dev/null
}
if [ "${1:-}" = --configure ]; then
  configure
  echo "apt-install.sh: apt retries and timeouts configured ($etc/apt.conf.d/80-denext-ci-retries)"
  exit 0
fi

recommends=(--no-install-recommends)
if [ "${1:-}" = --with-recommends ]; then
  recommends=()
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "::error::apt-install.sh: no packages named" >&2
  exit 1
fi

missing=()
for pkg in "$@"; do
  case "$pkg" in
    */*) missing+=("$pkg"); continue ;; # a local .deb
  esac
  if [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != installed ]; then
    missing+=("$pkg")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "apt-install.sh: already installed, nothing to fetch: $*"
  exit 0
fi
echo "apt-install.sh: installing ${missing[*]}"

export DEBIAN_FRONTEND=noninteractive
configure

apt_opts=(
  -o Acquire::Retries=5
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o DPkg::Lock::Timeout=300
  -o Dpkg::Use-Pty=0
)

case "$(dpkg --print-architecture)" in
  amd64 | i386)
    default_mirrors="http://archive.ubuntu.com/ubuntu http://mirrors.edge.kernel.org/ubuntu"
    ;;
  *)
    default_mirrors="http://ports.ubuntu.com/ubuntu-ports"
    ;;
esac
read -r -a mirrors <<<"${APT_INSTALL_MIRRORS:-$default_mirrors}"

# Points every Ubuntu archive / security / ports source at $1 (both the
# one-line sources.list format and 24.04's deb822 .sources files).
use_mirror() {
  local url=$1 f
  for f in "$etc/sources.list" "$etc"/sources.list.d/*.list "$etc"/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    # -i with a suffix: the same on GNU and BSD sed.
    $sudo sed -E -i.apt-install-bak \
      "s#https?://([a-z0-9.-]+\.)?(archive|security)\.ubuntu\.com/ubuntu/?#$url/#g; s#https?://([a-z0-9.-]+\.)?ports\.ubuntu\.com/ubuntu-ports/?#$url/#g; s#https?://mirrors\.edge\.kernel\.org/ubuntu/?#$url/#g" \
      "$f"
    $sudo rm -f "$f.apt-install-bak"
  done
  echo "apt-install.sh: apt sources now use $url"
}

# man-db triggers can take minutes on hosted runners.
$sudo apt-get -qq remove --purge -y man-db >/dev/null 2>&1 || true

tries=${APT_INSTALL_TRIES:-4}
delay=${APT_INSTALL_DELAY:-15}
for ((try = 1; try <= tries; try++)); do
  if [ "$try" -ge 3 ] && [ "${#mirrors[@]}" -gt 0 ]; then
    use_mirror "${mirrors[$(((try - 3) % ${#mirrors[@]}))]}"
  fi
  if timeout 600 $sudo apt-get "${apt_opts[@]}" update -q &&
    timeout 1200 $sudo apt-get "${apt_opts[@]}" install -y ${recommends[@]+"${recommends[@]}"} "${missing[@]}"; then
    exit 0
  fi
  if [ "$try" -lt "$tries" ]; then
    echo "::warning::apt-install.sh: try $try of $tries failed; again in ${delay}s"
    sleep "$delay"
    delay=$((delay * 2))
  fi
done
echo "::error::apt-install.sh: could not install ${missing[*]} after $tries tries (the last two on a fallback mirror)" >&2
exit 1
