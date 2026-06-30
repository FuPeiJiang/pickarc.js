#!/usr/bin/env bash
set -euo pipefail

TERMUX_TAG=v0.118.3
TERMUX_APK='termux-app_v0.118.3+github-debug_x86_64.apk'
TERMUX_APK_URL="https://github.com/termux/termux-app/releases/download/${TERMUX_TAG}/termux-app_v0.118.3%2Bgithub-debug_x86_64.apk"
TERMUX_SUMS_URL="https://github.com/termux/termux-app/releases/download/${TERMUX_TAG}/termux-app_v0.118.3%2Bgithub-debug_sha256sums"

ENTER_TAG=v0.1.0
ENTER_ASSET=adb-termux-enter.x86_64.android36
ENTER_URL="https://github.com/FuPeiJiang/adb-termux-enter/releases/download/${ENTER_TAG}/${ENTER_ASSET}"
ENTER_SUMS_URL="https://github.com/FuPeiJiang/adb-termux-enter/releases/download/${ENTER_TAG}/SHA256SUMS"

BUN_VERSION="${BUN_VERSION:-1.3.14}"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-android.zip"

if ! command -v unzip >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y unzip
fi

cd "$RUNNER_TEMP"

curl -fsSLo "$TERMUX_APK" "$TERMUX_APK_URL"
curl -fsSLo termux-sha256sums "$TERMUX_SUMS_URL"
sha256sum -c termux-sha256sums --ignore-missing

curl -fsSLo "$ENTER_ASSET" "$ENTER_URL"
curl -fsSLo SHA256SUMS "$ENTER_SUMS_URL"
sha256sum -c SHA256SUMS --ignore-missing
chmod 755 "$ENTER_ASSET"

curl -fsSLo bun-android.zip "$BUN_URL"
mkdir -p bun-android
unzip -q bun-android.zip -d bun-android
BUN_BIN="$(find bun-android -type f -name bun | head -n 1)"

if [ -z "$BUN_BIN" ]; then
  echo "bun binary not found in $BUN_URL"
  exit 1
fi

tar \
  --exclude .git \
  --exclude node_modules \
  --exclude 'core' \
  --exclude 'core.*' \
  -cf pickarc.tar \
  -C "$GITHUB_WORKSPACE" \
  .

adb wait-for-device
adb root
adb wait-for-device

if [ "$(adb shell id -u | tr -d '\r')" != "0" ]; then
  echo "Android emulator must provide a root adb shell"
  exit 1
fi

adb install -r -d "$TERMUX_APK"
adb shell am start -W -n com.termux/.app.TermuxActivity

for _ in $(seq 1 120); do
  if adb shell 'test -x /data/data/com.termux/files/usr/bin/bash' >/dev/null 2>&1; then
    break
  fi

  sleep 1
done

adb shell 'test -x /data/data/com.termux/files/usr/bin/bash'

adb push "$ENTER_ASSET" /data/local/tmp/adb-termux-enter
adb shell 'chmod 755 /data/local/tmp/adb-termux-enter'

adb push "$BUN_BIN" /data/local/tmp/bun
adb shell 'chmod 755 /data/local/tmp/bun'

adb push pickarc.tar /data/local/tmp/pickarc.tar
adb shell 'chmod 644 /data/local/tmp/pickarc.tar'

adb shell /data/local/tmp/adb-termux-enter bash <<'TERMUX'
set -eux

rm -rf "$HOME/pickarc.js"
mkdir -p "$HOME/bin" "$HOME/pickarc.js"
cp /data/local/tmp/bun "$HOME/bin/bun"
chmod 755 "$HOME/bin/bun"

export PATH="$HOME/bin:$PATH"

tar -xf /data/local/tmp/pickarc.tar -C "$HOME/pickarc.js"
cd "$HOME/pickarc.js"

bun --version
bun test
TERMUX
