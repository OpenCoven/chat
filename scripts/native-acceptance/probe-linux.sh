#!/usr/bin/env bash
# What a fresh Ubuntu runner offers the native lane, against the published .deb.
# Usage: probe-linux.sh <release tag> <out dir>   (run as the runner user, with sudo)
set -uo pipefail
release="$1"
out="$2"
mkdir -p "$out"
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '%s\n' "$*" | tee -a "$out/probe.txt"; }

if [ -z "${PROBE_INNER:-}" ]; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb openbox xdotool xclip \
    at-spi2-core python3-pyatspi dbus-x11 orca speech-dispatcher ibus ibus-anthy \
    imagemagick > "$out/apt.txt" 2>&1
  version="${release#v}"
  asset="OpenCoven.Chat_${version}_amd64.deb"
  work="$(mktemp -d)"
  base="https://github.com/OpenCoven/chat/releases/download/${release}"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/$asset" "$base/$asset"
  log "checksum: $(cd "$work" && grep -F "  ${asset}" SHA256SUMS | sha256sum -c - 2>&1)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$work/$asset" >> "$out/apt.txt" 2>&1
  log "installed: $(dpkg -s open-coven-chat 2>/dev/null | grep -E '^(Package|Version)' | tr '\n' ' ') $(command -v opencoven-chat)"
  log "distro: $(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r)"
  log "WebKitGTK: $(dpkg -l 'libwebkit2gtk-4.1-0' 2>/dev/null | awk '/^ii/{print $3}')"
  log "prior app data: $(ls -d "$HOME/.local/share/ai.opencoven.chat" 2>&1)"
  PROBE_INNER=1 exec dbus-run-session -- "$0" "$release" "$out"
fi

export DISPLAY=:99
Xvfb :99 -screen 0 1600x1000x24 &
sleep 2
openbox &
sleep 1
/usr/libexec/at-spi-bus-launcher --launch-immediately &
sleep 1
log "at-spi bus: $(dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress 2>&1 | tail -1)"
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null
ibus-daemon -drx
sleep 2
ibus engine anthy 2>>"$out/probe.txt"
log "ibus engine: $(ibus engine 2>&1)"
ibus engine xkb:us::eng 2>/dev/null
export GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus QT_IM_MODULE=ibus

app="$(command -v opencoven-chat)"
"$app" > "$out/app.log" 2>&1 &
pid=$!
sleep 15
log "app pid: $pid ($(ps -o comm= -p "$pid"))"
printf '%s\n' "{\"cmd\":\"target\",\"pid\":$pid}" '{"cmd":"activate"}' '{"cmd":"windows"}' \
  '{"cmd":"tree","depth":60}' '{"cmd":"focused"}' \
  | python3 "$here/linux/native_driver.py" > "$out/atspi.jsonl" 2>&1
log "atspi lines: $(wc -l < "$out/atspi.jsonl"), first: $(head -1 "$out/atspi.jsonl" | cut -c1-200)"
grep -o '"name": "[^"]*"' "$out/atspi.jsonl" | sort -u | head -60 >> "$out/probe.txt"
import -window root "$out/screen.png" 2>>"$out/probe.txt"
log "screenshot bytes: $(stat -c %s "$out/screen.png" 2>/dev/null || echo none)"

orca --replace --debug-file="$out/orca.log" > "$out/orca.out" 2>&1 &
sleep 10
xdotool key Tab
sleep 2
xdotool key Tab
sleep 3
log "orca running: $(pgrep -x orca || echo no); speech lines: $(grep -c 'SPEECH OUTPUT' "$out/orca.log" 2>/dev/null)"
grep 'SPEECH OUTPUT' "$out/orca.log" 2>/dev/null | head -8 >> "$out/probe.txt"
kill "$pid" 2>/dev/null
exit 0
