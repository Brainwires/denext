#!/usr/bin/env bash
# Builds both release APKs of the scroll bench on a Linux build host over SSH (JDK 21 and the
# Android SDK at ~/Android/Sdk there), then copies them back. The web export is built HERE
# (denext, the repo's cli.ts); Gradle and Metro run on the host.
#
#   examples/scroll-bench/build-apks.sh [host] [local-out-dir]
#
# Host scratch layout: ~/scroll-bench-build/{src/{shared,native,web},throwaway.jks,logs/}.
# Both APKs are signed with a THROWAWAY key generated on the host (CN=Throwaway Bench,
# password "android", alias "throwaway"); never a real key, never committed.
# x86_64 only (the Android emulator on an Intel Mac); drop -PreactNativeArchitectures for all ABIs.
set -euo pipefail

HOST="${1:-biscuits}"
OUT="${2:-$(pwd)/apks}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# 1. The denext production export + Capacitor copy (local; light).
(cd "$HERE/web" && deno task export && node_modules/.bin/cap copy android)

# 2. Sources to the host (node_modules are installed there from the lockfiles).
ssh "$HOST" "mkdir -p ~/scroll-bench-build/src ~/scroll-bench-build/logs"
rsync -a --delete --exclude node_modules --exclude 'android/app/build' --exclude 'android/build' \
  --exclude 'android/.gradle' --exclude .denext \
  "$HERE/shared" "$HERE/native" "$HERE/web" "$HOST:scroll-bench-build/src/"

# 3. Build on the host.
ssh "$HOST" "bash -lic '
set -e
export ANDROID_HOME=\$HOME/Android/Sdk
cd ~/scroll-bench-build
[ -f throwaway.jks ] || keytool -genkeypair -keystore throwaway.jks -storepass android \
  -keypass android -alias throwaway -keyalg RSA -keysize 2048 -validity 3650 -dname \"CN=Throwaway Bench\"
SIGN=\"-Pandroid.injected.signing.store.file=\$HOME/scroll-bench-build/throwaway.jks \
  -Pandroid.injected.signing.store.password=android -Pandroid.injected.signing.key.alias=throwaway \
  -Pandroid.injected.signing.key.password=android\"
(cd src/native && npm ci --no-audit --no-fund)
(cd src/native/android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 \$SIGN) \
  > logs/rn-gradle.log 2>&1
(cd src/web && npm ci --no-audit --no-fund)
(cd src/web/android && ./gradlew assembleRelease \$SIGN) > logs/cap-gradle.log 2>&1
cp src/native/android/app/build/outputs/apk/release/app-release.apk scroll-bench-rn-release.apk
cp src/web/android/app/build/outputs/apk/release/app-release.apk scroll-bench-denext-release.apk
'"

# 4. Back to the Mac.
rsync -a "$HOST:scroll-bench-build/scroll-bench-*-release.apk" "$OUT/"
ls -la "$OUT"/scroll-bench-*-release.apk
