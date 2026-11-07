#!/usr/bin/env bash
# The Linux native lane: verify and install the published .deb or AppImage on a
# fresh runner (not a container, so the accessibility bus is real), record what
# the runner is, then drive the app with run.mjs under X with Orca and IBus.
# Usage: lane-linux.sh <release tag> <out dir> <deb|appimage>
set -uo pipefail
release="$1"
out="$2"
kind="${3:-deb}"
mkdir -p "$out"
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '%s\n' "$*" | tee -a "$out/environment.txt"; }

if [ -z "${LANE_INNER:-}" ]; then
  # IBus Anthy is in universe, which the runner's sources may leave out.
  sudo add-apt-repository -y universe > "$out/apt.txt" 2>&1
  sudo apt-get update -qq >> "$out/apt.txt" 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb openbox xdotool xclip \
    at-spi2-core python3-pyatspi dbus-x11 orca speech-dispatcher ibus ibus-gtk3 \
    imagemagick sqlite3 libfuse2t64 >> "$out/apt.txt" 2>&1 || { tail -20 "$out/apt.txt"; exit 1; }
  # A Japanese IBus engine: Anthy, or Mozc where this release has no Anthy.
  japanese=""
  for candidate in "ibus-anthy anthy" "ibus-mozc mozc-jp"; do
    set -- $candidate
    if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1" >> "$out/apt.txt" 2>&1; then
      japanese="$2"
      break
    fi
  done
  log "Japanese IBus engine: ${japanese:-none installable}"
  version="${release#v}"
  if [ "$kind" = appimage ]; then asset="OpenCoven.Chat_${version}_amd64.AppImage"; else asset="OpenCoven.Chat_${version}_amd64.deb"; fi
  work="$(mktemp -d)"
  base="https://github.com/OpenCoven/chat/releases/download/${release}"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || exit 1
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 -o "$work/$asset" "$base/$asset" || exit 1
  checksum="$(cd "$work" && grep -F "  ${asset}" SHA256SUMS | sha256sum -c - 2>&1)"
  log "checksum: $checksum"
  case "$checksum" in *": OK") ;; *) echo "::error::$asset does not match SHA256SUMS"; exit 1 ;; esac
  log "prior app data: $(ls -d "$HOME/.local/share/ai.opencoven.chat" "$HOME/.config/ai.opencoven.chat" 2>&1 | tr '\n' ' ')"
  if [ "$kind" = appimage ]; then
    app="$HOME/Applications/$asset"
    mkdir -p "$HOME/Applications"
    cp "$work/$asset" "$app"
    chmod +x "$app"
  else
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$work/$asset" >> "$out/apt.txt" 2>&1 || exit 1
    app="$(command -v opencoven-chat)"
  fi
  # The default browser, with its first-run pages off; Chrome stays installed and unused.
  for dir in /usr/lib/firefox/distribution /etc/firefox/policies; do
    sudo mkdir -p "$dir"
    printf '%s\n' '{"policies":{"OverrideFirstRunPage":"","OverridePostUpdatePage":"","DontCheckDefaultBrowser":true,"DisableTelemetry":true}}' | sudo tee "$dir/policies.json" > /dev/null
  done
  xdg-settings set default-web-browser firefox.desktop 2>>"$out/environment.txt"
  webkit="$(dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null)"
  cat > "$out/facts.json" <<EOF
{
  "release": "$release",
  "installer": "$asset",
  "installerSha256": "$(sha256sum "$work/$asset" | cut -d' ' -f1)",
  "sha256sumsSha256": "$(sha256sum "$work/SHA256SUMS" | cut -d' ' -f1)",
  "checksum": "$checksum",
  "installed": "$app",
  "distro": "$(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r)",
  "webkitgtk": "$webkit",
  "firefox": "$(firefox --version 2>/dev/null)",
  "orca": "$(orca --version 2>/dev/null)",
  "profile": "fresh runner user; no prior ai.opencoven.chat data"
}
EOF
  LANE_INNER=1 LANE_APP="$app" LANE_JAPANESE="$japanese" exec dbus-run-session -- "$0" "$release" "$out" "$kind"
fi

export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 > "$out/xvfb.log" 2>&1 &
sleep 2
openbox > "$out/openbox.log" 2>&1 &
sleep 1
/usr/libexec/at-spi-bus-launcher --launch-immediately > "$out/at-spi.log" 2>&1 &
sleep 1
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null
gsettings set org.gnome.desktop.a11y.applications screen-reader-enabled true 2>/dev/null
export GNOME_ACCESSIBILITY=1 ACCESSIBILITY_ENABLED=1
export GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus QT_IM_MODULE=ibus
# The runner has no audio device, and speech-dispatcher then stops answering
# Orca's CANCEL, which hangs Orca on the first key. Orca runs without a speech
# server instead: its debug log still records every utterance it would speak
# ("SPEECH OUTPUT"), generated from the accessibility tree as for a person.
mkdir -p "$HOME/.local/share/orca"
cat > "$HOME/.local/share/orca/orca-customizations.py" <<'PY'
import orca.speech
orca.speech.init = lambda *args, **kwargs: None
PY
log "Orca: no speech server on this runner (no audio device); utterances read from its debug log"
ibus-daemon -drx
sleep 3
log "ibus engines: $(ibus list-engine 2>/dev/null | grep -E 'anthy|mozc|xkb:us::eng' | tr -s ' ' | tr '\n' ';')"
ibus engine xkb:us::eng 2>>"$out/environment.txt"
log "default browser: $(xdg-settings get default-web-browser 2>&1)"

node "$here/run.mjs" --app "$LANE_APP" --out "$out" \
  --lane "$(. /etc/os-release && echo "$PRETTY_NAME"), published ${kind} ${release}" \
  --facts "$out/facts.json" ${LANE_JAPANESE:+--japanese "$LANE_JAPANESE"} --latin xkb:us::eng
exit $?
