#!/usr/bin/env bash
# The macOS native lane: verify and install the published DMG on a fresh runner,
# record what the runner is, then drive the app with run.mjs.
# Usage: lane-mac.sh <release tag> <out dir> <arch: aarch64|x64>
set -uo pipefail
release="$1"
out="$2"
arch="${3:-aarch64}"
mkdir -p "$out"
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '%s\n' "$*" | tee -a "$out/environment.txt"; }

version="${release#v}"
asset="OpenCoven.Chat_${version}_${arch}.dmg"
work="$(mktemp -d)"
base="https://github.com/OpenCoven/chat/releases/download/${release}"
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || exit 1
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/$asset" "$base/$asset" || exit 1
checksum="$(cd "$work" && grep -F "  ${asset}" SHA256SUMS | shasum -a 256 -c - 2>&1)"
log "checksum: $checksum"
case "$checksum" in *": OK") ;; *) echo "::error::$asset does not match SHA256SUMS"; exit 1 ;; esac
sha="$(shasum -a 256 "$work/$asset" | cut -d' ' -f1)"
sums="$(shasum -a 256 "$work/SHA256SUMS" | cut -d' ' -f1)"

log "prior app data: $(ls -d "$HOME/Library/Application Support/ai.opencoven.chat" "$HOME/Library/WebKit/ai.opencoven.chat" 2>&1 | tr '\n' ' ')"
mount="$(hdiutil attach -nobrowse -readonly "$work/$asset" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
ditto "$mount/OpenCoven Chat.app" "/Applications/OpenCoven Chat.app"
hdiutil detach "$mount" -quiet
app="/Applications/OpenCoven Chat.app"
sign="$(codesign -dvvv "$app" 2>&1)"
cdhash="$(printf '%s\n' "$sign" | sed -n 's/^CDHash=//p')"
identifier="$(printf '%s\n' "$sign" | sed -n 's/^Identifier=//p')"
team="$(printf '%s\n' "$sign" | sed -n 's/^TeamIdentifier=//p')"
log "codesign: CDHash=$cdhash Identifier=$identifier Team=$team"
log "gatekeeper: $(spctl -a -vv "$app" 2>&1 | tr '\n' ' ')"
log "stapled: $(xcrun stapler validate "$app" 2>&1 | tail -1)"
log "quarantine: $(xattr -p com.apple.quarantine "$app" 2>&1)"

# The Dock covers the bottom of a small screen; hide it, and ask for a larger
# display mode where the runner's virtual display offers one.
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock autohide-delay -float 1000
killall Dock 2>/dev/null
if brew install displayplacer > "$out/displayplacer.txt" 2>&1; then
  displayplacer list >> "$out/displayplacer.txt" 2>&1
  id="$(displayplacer list 2>/dev/null | sed -n 's/^Persistent screen id: //p' | head -1)"
  mode="$(displayplacer list 2>/dev/null | grep -E 'res:(1920x1080|1680x1050|1600x900|1440x900)' | grep -v scaling:on | head -1)"
  res="$(printf '%s' "$mode" | sed -n 's/.*res:\([0-9]*x[0-9]*\).*/\1/p')"
  hz="$(printf '%s' "$mode" | sed -n 's/.*hz:\([0-9]*\).*/\1/p')"
  depth="$(printf '%s' "$mode" | sed -n 's/.*color_depth:\([0-9]*\).*/\1/p')"
  if [ -n "$id" ] && [ -n "$res" ]; then
    displayplacer "id:$id res:$res hz:${hz:-60} color_depth:${depth:-8} scaling:off origin:(0,0) degree:0" >> "$out/displayplacer.txt" 2>&1
  fi
fi
log "display: $(system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution' | head -1 | sed 's/^ *//')"

# Tab reaches every control only with keyboard navigation on (System Settings >
# Keyboard > Keyboard navigation); recorded with the results.
defaults write -g AppleKeyboardUIMode -int 2
# VoiceOver answers AppleScript only when these are set.
sudo mkdir -p /private/var/db/Accessibility
sudo bash -c 'printf a > /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'

swiftc -O -o "$out/native-mac" "$here/mac/NativeDriver.swift" || exit 1
log "helper trust: $(echo '{"cmd":"trust"}' | "$out/native-mac")"

cat > "$out/facts.json" <<EOF
{
  "release": "$release",
  "installer": "$asset",
  "installerSha256": "$sha",
  "sha256sumsSha256": "$sums",
  "checksum": "$checksum",
  "cdhash": "$cdhash",
  "identifier": "$identifier",
  "team": "$team",
  "macOS": "$(sw_vers -productVersion) ($(sw_vers -buildVersion)) $(uname -m)",
  "webkit": "$(defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info.plist CFBundleVersion 2>/dev/null)",
  "sip": "$(csrutil status 2>&1 | tr -d '"')",
  "keyboardNavigation": "AppleKeyboardUIMode $(defaults read -g AppleKeyboardUIMode 2>&1)",
  "profile": "fresh runner user; no prior ai.opencoven.chat data"
}
EOF

node "$here/run.mjs" --app "$app/Contents/MacOS/opencoven-chat" --out "$out" \
  --lane "macOS $(sw_vers -productVersion) $(uname -m), published ${arch} DMG ${release}" \
  --helper "$out/native-mac" --facts "$out/facts.json" \
  --japanese com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese --latin com.apple.keylayout.ABC
status=$?
log "TCC rows: $(sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' "select service, client from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServiceAppleEvents','kTCCServicePostEvent')" 2>&1 | tr '\n' ';' | cut -c1-1500)"
exit $status
