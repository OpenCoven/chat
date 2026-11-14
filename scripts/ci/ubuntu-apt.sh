#!/usr/bin/env bash
# Installs Ubuntu packages through the first mirror that serves them, and leaves
# that mirror configured for later apt commands in the job.
#
#   bash scripts/ci/ubuntu-apt.sh package...
#   bash scripts/ci/ubuntu-apt.sh --select-only package...   # choose a mirror, install nothing
#
# Hosted runners have lost a different Ubuntu mirror on different days: Azure's
# (#597), Canonical's DNS (#598), then kernel.org's (unreachable from runners on
# 2026-11-11). So no single mirror is pinned. A mirror is used only once apt has
# a candidate for every package named. Ubuntu's suites, components, signing keys
# and apt verification are unchanged; only the host serving them changes.
set -euo pipefail

select_only=0
if [ "${1:-}" = --select-only ]; then
  select_only=1
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "usage: $0 [--select-only] package..." >&2
  exit 2
fi

mirrors=(
  https://mirrors.edge.kernel.org/ubuntu
  http://archive.ubuntu.com/ubuntu
  http://azure.archive.ubuntu.com/ubuntu
)
# Every host above, and Canonical's security host, so a second call can move on
# from the mirror an earlier call chose.
hosts='(mirrors[.]edge[.]kernel[.]org|azure[.]archive[.]ubuntu[.]com|archive[.]ubuntu[.]com|security[.]ubuntu[.]com)'

# UBUNTU_APT_ROOT is for the script's tests, which run it against a copy of /etc/apt.
root="${UBUNTU_APT_ROOT:-}"
files=()
for file in "$root"/etc/apt/apt-mirrors.txt "$root"/etc/apt/sources.list "$root"/etc/apt/sources.list.d/*.list "$root"/etc/apt/sources.list.d/*.sources; do
  if [ -f "$file" ]; then files+=("$file"); fi
done

point_at() {
  local mirror="$1" file
  for file in ${files[@]+"${files[@]}"}; do
    if [ "$file" = "$root/etc/apt/apt-mirrors.txt" ]; then
      # Sources that read this list keep their definitions and index identity.
      printf '%s\n' "$mirror" | sudo tee "$file" > /dev/null
    else
      sudo sed -E -i -e "s#https?://${hosts}/ubuntu#${mirror}#g" "$file"
    fi
  done
}

serves_all() {
  local package candidate
  for package in "$@"; do
    candidate="$(apt-cache policy "$package" 2>/dev/null | awk '/Candidate:/ { print $2; exit }')"
    if [ -z "$candidate" ] || [ "$candidate" = '(none)' ]; then
      echo "  no candidate for $package"
      return 1
    fi
  done
}

for mirror in "${mirrors[@]}"; do
  echo "Ubuntu mirror: trying $mirror"
  point_at "$mirror"
  # An unreachable mirror only warns here; serves_all is what decides.
  sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update || true
  if ! serves_all "$@"; then
    echo "::warning::Ubuntu mirror $mirror did not serve the packages; trying the next one"
    continue
  fi
  if [ "$select_only" = 1 ]; then
    echo "Ubuntu mirror: using $mirror"
    exit 0
  fi
  if sudo DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 install -y "$@"; then
    echo "Ubuntu mirror: installed through $mirror"
    exit 0
  fi
  echo "::warning::Installing through $mirror failed; trying the next one"
done
echo "::error::No Ubuntu mirror served: $*"
exit 1
