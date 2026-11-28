#!/usr/bin/env bash
# Installs both .deb files in order. Run on a disposable Ubuntu guest.
set -euo pipefail
bundle=$(realpath "$1")
out=$(realpath -m "$2")
repo=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$out/bin" "$out/profile"
exec > >(tee "$out/upgrade.log") 2>&1
cd "$out"
mapfile -t candidates < <(find "$bundle" -type f -name '*.deb')
test "${#candidates[@]}" = 1
candidate=${candidates[0]}
curl -fsSL --retry 3 -o published.deb https://github.com/OpenCoven/chat/releases/download/v0.1.3/Coven.Chat_0.1.3_amd64.deb
curl -fsSL --retry 3 -o cli.tar.gz https://github.com/OpenCoven/coven/releases/download/v0.4.10/coven-v0.4.10-linux-x64.tar.gz
sha256sum -c <<'SUMS'
a827ce8f319443bda773d4b4de8fcc842b0f1313fb2b50ce2c7cd53b4ddf8f07  published.deb
01589044d05f1dd40823c218531386c6cdc89648a5a3ca4056a0b672c80db7cc  cli.tar.gz
SUMS
tar xf cli.tar.gz -C bin
sha256sum "$candidate"
sudo apt-get update -qq
sudo apt-get install -y -qq xvfb openbox x11-utils xdotool xclip at-spi2-core python3-pyatspi dbus-x11 "$out/published.deb"
drive() {
  dpkg-query -W -f='Installed ${Package} ${Version}\n' "$(dpkg-deb -f "$2" Package)"
  xvfb-run -a -s '-screen 0 1440x1000x24 -noreset' dbus-run-session -- bash -c '
    set -eu
    for _ in {1..60}; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
    xdpyinfo >/dev/null
    openbox --sm-disable > "$2/openbox-$1.log" 2>&1 &
    wm=$!
    for _ in {1..60}; do
      kill -0 "$wm" || { cat "$2/openbox-$1.log"; exit 1; }
      xprop -root _NET_SUPPORTING_WM_CHECK | grep -Eq "window id # 0x[1-9a-f]" && break
      sleep 0.2
    done
    xprop -root _NET_SUPPORTING_WM_CHECK | grep -Eq "window id # 0x[1-9a-f]"
    /usr/libexec/at-spi-bus-launcher --launch-immediately > "$2/atspi-$1.log" 2>&1 &
    gsettings set org.gnome.desktop.interface toolkit-accessibility true
    dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null
    exec node "$3/scripts/native-acceptance/retained-attachments.mjs" "$1" "$(command -v opencoven-chat)" "$2/profile" "$2/bin/coven"
  ' bash "$1" "$out" "$repo"
}
drive seed "$out/published.deb"
sudo apt-get install -y -qq "$candidate"
drive verify "$candidate"
