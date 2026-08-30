#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "phase1-linux-secret-service: Linux is required" >&2
  exit 1
fi

unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL GH_TOKEN GITHUB_TOKEN
: "${OPENCOVEN_UNIX_PRODUCER_REQUIRED:?}"
: "${OPENCOVEN_UNIX_PRODUCER_UID:?}"
: "${OPENCOVEN_UNIX_BROKER_UID:?}"
: "${OPENCOVEN_UNIX_CONTAINMENT:?}"
: "${OPENCOVEN_UNIX_CGROUP_PATH:?}"
: "${RUNNER_TEMP:?}"
[[ "$OPENCOVEN_UNIX_PRODUCER_REQUIRED" == "1" ]]
[[ "$OPENCOVEN_UNIX_PRODUCER_UID" == "$(id -u)" ]]
[[ "$OPENCOVEN_UNIX_PRODUCER_UID" != "$OPENCOVEN_UNIX_BROKER_UID" ]]
[[ "$OPENCOVEN_UNIX_CONTAINMENT" == "linux-cgroup-v2" ]]
grep -qx "0::$OPENCOVEN_UNIX_CGROUP_PATH" /proc/self/cgroup

if [[ "${OPENCOVEN_PHASE1_SECRET_SERVICE_INSIDE:-}" != "1" ]]; then
  runtime_root="$(mktemp -d "$RUNNER_TEMP/opencoven-dbus.XXXXXXXX")"
  chmod 700 "$runtime_root"
  root_identity="$(stat -c '%d:%i' "$runtime_root")"
  root_stamp="$(openssl rand -hex 32)"
  printf '%s\n' "$root_stamp" >"$runtime_root/.opencoven-owned-temp"
  chmod 600 "$runtime_root/.opencoven-owned-temp"
  exec env \
    OPENCOVEN_PHASE1_SECRET_SERVICE_INSIDE=1 \
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT="$runtime_root" \
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_IDENTITY="$root_identity" \
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_STAMP="$root_stamp" \
    XDG_RUNTIME_DIR="$runtime_root" \
    dbus-run-session -- bash "$0" "$@"
fi

runtime_root="${OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT:?}"
root_identity="${OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_IDENTITY:?}"
root_stamp="${OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_STAMP:?}"
[[ "$(realpath "$XDG_RUNTIME_DIR")" == "$(realpath "$runtime_root")" ]]
[[ "$(stat -c '%a' "$runtime_root")" == "700" ]]
[[ "$(stat -c '%u' "$runtime_root")" == "$OPENCOVEN_UNIX_PRODUCER_UID" ]]
[[ "$(stat -c '%d:%i' "$runtime_root")" == "$root_identity" ]]
[[ "$(cat "$runtime_root/.opencoven-owned-temp")" == "$root_stamp" ]]
[[ "${DBUS_SESSION_BUS_ADDRESS:-}" == unix:* ]]

mkdir -m 700 \
  "$runtime_root/home" \
  "$runtime_root/data" \
  "$runtime_root/config" \
  "$runtime_root/keyring"

keyring_pid=""
probe_service="opencoven-ci-probe-$$"
probe_user="secret-service-probe"

cleanup() {
  status=$?
  timeout --foreground 10s \
    secret-tool clear service "$probe_service" username "$probe_user" \
    >/dev/null 2>&1 || true
  if [[ -n "$keyring_pid" ]] && kill -0 "$keyring_pid" 2>/dev/null; then
    kill "$keyring_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$keyring_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$keyring_pid" 2>/dev/null; then
      kill -KILL "$keyring_pid" 2>/dev/null || true
    fi
    wait "$keyring_pid" 2>/dev/null || true
  fi
  if [[ -d "$runtime_root" ]] &&
    [[ ! -L "$runtime_root" ]] &&
    [[ "$(stat -c '%d:%i' "$runtime_root")" == "$root_identity" ]] &&
    [[ "$(cat "$runtime_root/.opencoven-owned-temp")" == "$root_stamp" ]]; then
    rm -rf -- "$runtime_root"
  else
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keyring_password="$(openssl rand -hex 32)"
printf '%s\n' "$keyring_password" |
  env \
    HOME="$runtime_root/home" \
    XDG_RUNTIME_DIR="$runtime_root" \
    XDG_DATA_HOME="$runtime_root/data" \
    XDG_CONFIG_HOME="$runtime_root/config" \
    GNOME_KEYRING_CONTROL="$runtime_root/keyring" \
    gnome-keyring-daemon \
      --foreground \
      --components=secrets \
      --unlock \
      >"$runtime_root/gnome-keyring.stdout" \
      2>"$runtime_root/gnome-keyring.stderr" &
keyring_pid=$!
unset keyring_password

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if timeout --foreground 2s \
    dbus-send \
      --session \
      --print-reply \
      --dest=org.freedesktop.DBus \
      /org/freedesktop/DBus \
      org.freedesktop.DBus.GetNameOwner \
      string:org.freedesktop.secrets \
      >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$keyring_pid" 2>/dev/null || break
  sleep 0.2
done
[[ "$ready" == "1" ]]

probe_secret="$(openssl rand -hex 32)"
printf '%s\n' "$probe_secret" |
  timeout --foreground 10s \
    env \
      HOME="$runtime_root/home" \
      XDG_RUNTIME_DIR="$runtime_root" \
      XDG_DATA_HOME="$runtime_root/data" \
      XDG_CONFIG_HOME="$runtime_root/config" \
      secret-tool store \
        --label=opencoven-ci-probe \
        service "$probe_service" \
        username "$probe_user" \
        >/dev/null
observed="$(
  timeout --foreground 10s \
    env \
      HOME="$runtime_root/home" \
      XDG_RUNTIME_DIR="$runtime_root" \
      XDG_DATA_HOME="$runtime_root/data" \
      XDG_CONFIG_HOME="$runtime_root/config" \
      secret-tool lookup \
        service "$probe_service" \
        username "$probe_user"
)"
[[ "$observed" == "$probe_secret" ]]
unset observed probe_secret

timeout --foreground 10s \
  env \
    HOME="$runtime_root/home" \
    XDG_RUNTIME_DIR="$runtime_root" \
    XDG_DATA_HOME="$runtime_root/data" \
    XDG_CONFIG_HOME="$runtime_root/config" \
    secret-tool clear \
      service "$probe_service" \
      username "$probe_user" \
      >/dev/null
if timeout --foreground 10s \
  env \
    HOME="$runtime_root/home" \
    XDG_RUNTIME_DIR="$runtime_root" \
    XDG_DATA_HOME="$runtime_root/data" \
    XDG_CONFIG_HOME="$runtime_root/config" \
    secret-tool lookup \
      service "$probe_service" \
      username "$probe_user" \
      >/dev/null 2>&1; then
  exit 1
fi

export HOME="$runtime_root/home"
export XDG_RUNTIME_DIR="$runtime_root"
export XDG_DATA_HOME="$runtime_root/data"
export XDG_CONFIG_HOME="$runtime_root/config"
node scripts/phase1-conformance.mjs "$@"
