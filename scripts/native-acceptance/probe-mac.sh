#!/usr/bin/env bash
# What a fresh macOS runner offers the native lane, against the published DMG.
# Usage: probe-mac.sh <release tag> <out dir>
set -uo pipefail
release="$1"
out="$2"
mkdir -p "$out"
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '%s\n' "$*" | tee -a "$out/probe.txt"; }

version="${release#v}"
asset="OpenCoven.Chat_${version}_aarch64.dmg"
work="$(mktemp -d)"
cd "$work"
base="https://github.com/OpenCoven/chat/releases/download/${release}"
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o SHA256SUMS "$base/SHA256SUMS"
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$asset" "$base/$asset"
log "checksum: $(grep -F "  ${asset}" SHA256SUMS | shasum -a 256 -c - 2>&1)"
log "macOS: $(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(uname -m)"
log "WebKit: $(defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info.plist CFBundleVersion 2>/dev/null)"
log "SIP: $(csrutil status 2>&1)"
mount="$(hdiutil attach -nobrowse -readonly "$asset" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
log "image accepted: $(spctl -a -t open --context context:primary-signature -vv "$asset" 2>&1 | tr '\n' ' ')"
cp -R "$mount/OpenCoven Chat.app" /Applications/
hdiutil detach "$mount" -quiet
app="/Applications/OpenCoven Chat.app"
log "app CDHash: $(codesign -dvvv "$app" 2>&1 | grep -E '^CDHash=' )"
log "app identifier: $(codesign -dvvv "$app" 2>&1 | grep -E '^Identifier=')"
log "app accepted: $(spctl -a -vv "$app" 2>&1 | tr '\n' ' ')"
log "stapled: $(xcrun stapler validate "$app" 2>&1 | tail -1)"
log "prior app data: $(ls -d "$HOME/Library/Application Support/ai.opencoven.chat" "$HOME/Library/WebKit/ai.opencoven.chat" 2>&1 | tr '\n' ' ')"

swiftc -O -o "$work/native" "$here/mac/NativeDriver.swift"
log "helper trust: $(echo '{"cmd":"trust"}' | "$work/native")"

open "$app"
pid=""
for _ in $(seq 1 60); do
  pid="$(pgrep -f "OpenCoven Chat.app/Contents/MacOS/opencoven-chat" | head -1)"
  [ -n "$pid" ] && break
  sleep 1
done
log "app pid: ${pid:-none}"
sleep 12
printf '%s\n' "{\"cmd\":\"target\",\"pid\":${pid:-0}}" '{"cmd":"activate"}' '{"cmd":"windows"}' \
  '{"cmd":"tree","depth":60}' '{"cmd":"focused"}' '{"cmd":"frontmost"}' \
  | "$work/native" > "$out/ax.jsonl" 2>&1
log "ax lines: $(wc -l < "$out/ax.jsonl"), first window: $(sed -n 3p "$out/ax.jsonl" | cut -c1-300)"
grep -o '"desc":"[^"]*"\|"title":"[^"]*"\|"value":"[^"]*"' "$out/ax.jsonl" | sort -u | head -60 >> "$out/probe.txt"

screencapture -x "$out/screen.png" 2>>"$out/probe.txt"
log "screenshot bytes: $(stat -f %z "$out/screen.png" 2>/dev/null || echo none)"

# A Japanese input method, selected the way the lane will select it.
printf '%s\n' '{"cmd":"selectInputSource","id":"com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese"}' \
  '{"cmd":"inputSources"}' '{"cmd":"selectInputSource","id":"com.apple.keylayout.ABC"}' \
  | "$work/native" >> "$out/probe.txt" 2>&1

# VoiceOver, controlled through AppleScript.
defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool YES
sudo mkdir -p /private/var/db/Accessibility
sudo bash -c 'printf a > /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'
defaults write com.apple.VoiceOverTraining doNotShowSplashScreen -bool true
/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter
sleep 8
log "VoiceOver running: $(pgrep -x VoiceOver || echo no)"
log "VoiceOver output: $(osascript -e 'tell application "VoiceOver" to output "probe"' 2>&1)"
sleep 1
log "VoiceOver last phrase: $(osascript -e 'tell application "VoiceOver" to get content of last phrase' 2>&1)"
osascript -e 'tell application "VoiceOver" to quit' >/dev/null 2>&1
log "TCC rows: $(sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "select service, client from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServiceAppleEvents','kTCCServicePostEvent')" 2>&1 | tr '\n' ';' | cut -c1-1500)"
pkill -f "OpenCoven Chat.app/Contents/MacOS/opencoven-chat" || true
exit 0
