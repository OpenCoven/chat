#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: unix-producer-supervisor.sh --platform PLATFORM --source PATH --destination PATH --temp-root PATH --handoff-helper PATH --command PATH [--command-arg VALUE ...] [--validator-revision REVISION] [--tool-path PATH] [--timeout-seconds N]" >&2
  exit 2
}

platform=
source_path=
destination_path=
temp_root=
handoff_helper=
command_path=
tool_path='/usr/bin:/bin:/usr/sbin:/sbin'
timeout_seconds=3300
validator_revision=
command_arguments=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) [[ $# -ge 2 ]] || usage; platform=$2; shift 2 ;;
    --source) [[ $# -ge 2 ]] || usage; source_path=$2; shift 2 ;;
    --destination) [[ $# -ge 2 ]] || usage; destination_path=$2; shift 2 ;;
    --temp-root) [[ $# -ge 2 ]] || usage; temp_root=$2; shift 2 ;;
    --handoff-helper) [[ $# -ge 2 ]] || usage; handoff_helper=$2; shift 2 ;;
    --command) [[ $# -ge 2 ]] || usage; command_path=$2; shift 2 ;;
    --command-arg) [[ $# -ge 2 ]] || usage; command_arguments+=("$2"); shift 2 ;;
    --validator-revision) [[ $# -ge 2 ]] || usage; validator_revision=$2; shift 2 ;;
    --tool-path) [[ $# -ge 2 ]] || usage; tool_path=$2; shift 2 ;;
    --timeout-seconds) [[ $# -ge 2 ]] || usage; timeout_seconds=$2; shift 2 ;;
    *) usage ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo 'unix-producer-supervisor: trusted root execution is required' >&2
  exit 1
fi
if [[ -z "$platform" || -z "$source_path" || -z "$destination_path" ||
      -z "$temp_root" || -z "$handoff_helper" || -z "$command_path" ]]; then
  usage
fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]{0,4}$ ]] || (( timeout_seconds > 7200 )); then
  echo 'unix-producer-supervisor: timeout is invalid' >&2
  exit 1
fi
if [[ -n "$validator_revision" && ! "$validator_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'unix-producer-supervisor: validator revision is invalid' >&2
  exit 1
fi

host_os="$(uname -s)"
host_arch="$(uname -m)"
case "$platform:$host_os:$host_arch" in
  linux-x64:Linux:x86_64) containment=linux-cgroup-v2 ;;
  darwin-arm64:Darwin:arm64) containment=macos-uid ;;
  *)
    echo 'unix-producer-supervisor: platform does not match the native host' >&2
    exit 1
    ;;
esac

broker_uid="${SUDO_UID:-}"
broker_gid="${SUDO_GID:-}"
broker_name="${SUDO_USER:-}"
if [[ ! "$broker_uid" =~ ^[0-9]+$ || ! "$broker_gid" =~ ^[0-9]+$ ||
      -z "$broker_name" || "$broker_name" == root ||
      "$(id -u "$broker_name")" != "$broker_uid" ||
      "$(id -g "$broker_name")" != "$broker_gid" ]]; then
  echo 'unix-producer-supervisor: original workflow broker identity is unavailable' >&2
  exit 1
fi

canonical_directory() {
  local path=$1
  [[ -d "$path" && ! -L "$path" ]] || return 1
  (cd "$path" && pwd -P)
}

canonical_file() {
  local path=$1
  local parent name
  parent="$(canonical_directory "$(dirname "$path")")" || return 1
  name="$(basename "$path")"
  [[ -f "$parent/$name" && ! -L "$parent/$name" ]] || return 1
  printf '%s/%s\n' "$parent" "$name"
}

source_path="$(canonical_directory "$source_path")" ||
  { echo 'unix-producer-supervisor: source root is unsafe' >&2; exit 1; }
temp_root="$(canonical_directory "$temp_root")" ||
  { echo 'unix-producer-supervisor: temporary root is unsafe' >&2; exit 1; }
handoff_helper="$(canonical_file "$handoff_helper")" ||
  { echo 'unix-producer-supervisor: handoff helper is unsafe' >&2; exit 1; }
command_path="$(canonical_file "$command_path")" ||
  { echo 'unix-producer-supervisor: restricted command is unsafe' >&2; exit 1; }
if [[ "$destination_path" != /* ]]; then
  destination_path="$(pwd -P)/$destination_path"
fi
destination_parent="$(canonical_directory "$(dirname "$destination_path")")" ||
  { echo 'unix-producer-supervisor: destination parent is unsafe' >&2; exit 1; }
destination_path="$destination_parent/$(basename "$destination_path")"
[[ ! -e "$destination_path" && ! -L "$destination_path" ]] ||
  { echo 'unix-producer-supervisor: destination already exists' >&2; exit 1; }

stat_owner() {
  if [[ "$host_os" == Darwin ]]; then
    /usr/bin/stat -f '%u' "$1"
  else
    /usr/bin/stat -c '%u' "$1"
  fi
}
stat_mode() {
  if [[ "$host_os" == Darwin ]]; then
    /usr/bin/stat -f '%Lp' "$1"
  else
    /usr/bin/stat -c '%a' "$1"
  fi
}
stat_links() {
  if [[ "$host_os" == Darwin ]]; then
    /usr/bin/stat -f '%l' "$1"
  else
    /usr/bin/stat -c '%h' "$1"
  fi
}
stat_identity() {
  if [[ "$host_os" == Darwin ]]; then
    /usr/bin/stat -f '%d %i' "$1"
  else
    /usr/bin/stat -c '%d %i' "$1"
  fi
}

for trusted_file in "$handoff_helper" "$command_path"; do
  mode="$(stat_mode "$trusted_file")"
  if [[ "$(stat_owner "$trusted_file")" != "$broker_uid" ||
        "$(stat_links "$trusted_file")" != 1 ||
        $((8#$mode & 8#022)) -ne 0 ]]; then
    echo 'unix-producer-supervisor: trusted input ownership or mode is unsafe' >&2
    exit 1
  fi
done
temp_mode="$(stat_mode "$temp_root")"
destination_mode="$(stat_mode "$destination_parent")"
if [[ "$(stat_owner "$temp_root")" != "$broker_uid" ||
      $((8#$temp_mode & 8#022)) -ne 0 ||
      "$(stat_owner "$destination_parent")" != "$broker_uid" ||
      $((8#$destination_mode & 8#022)) -ne 0 ]]; then
  echo 'unix-producer-supervisor: broker roots are not private and exactly owned' >&2
  exit 1
fi
case ":$tool_path:" in
  *$'\n'*|*$'\r'*) echo 'unix-producer-supervisor: tool path is malformed' >&2; exit 1 ;;
esac
old_ifs=$IFS
IFS=:
canonical_tool_path=
for tool_directory in $tool_path; do
  if [[ "$tool_directory" != /* || ! -d "$tool_directory" ]]; then
    echo 'unix-producer-supervisor: tool path contains an unsafe directory' >&2
    exit 1
  fi
  physical_tool_directory="$(cd "$tool_directory" && pwd -P)"
  if [[ -z "$canonical_tool_path" ]]; then
    canonical_tool_path="$physical_tool_directory"
  elif [[ ":$canonical_tool_path:" != *":$physical_tool_directory:"* ]]; then
    canonical_tool_path="$canonical_tool_path:$physical_tool_directory"
  fi
done
IFS=$old_ifs
tool_path="$canonical_tool_path"

nonce="$(/usr/bin/openssl rand -hex 8)"
[[ "$nonce" =~ ^[0-9a-f]{16}$ ]] ||
  { echo 'unix-producer-supervisor: nonce generation failed' >&2; exit 1; }
producer_name="ocv${nonce}"
producer_group="ocg${nonce}"
handoff_group="och${nonce}"
isolated_root="$(mktemp -d "$temp_root/opencoven-unix-producer.XXXXXXXX")"
chmod 711 "$isolated_root"
chmod 711 "$temp_root"
temp_root_relaxed=1
producer_root="$isolated_root/producer"
workspace="$isolated_root/source"
artifact_workspace="$producer_root/workspace"
trusted_root="$isolated_root/trusted"
source_record="$artifact_workspace/.artifacts/client-v1-conformance-$platform.json"
trusted_command="$trusted_root/producer-command"
trusted_handoff="$trusted_root/unix-artifact-handoff"

producer_uid=
producer_gid=
handoff_gid=
producer_pid=
cgroup_path=
cgroup_relative=
producer_created=0
producer_deleted=0
producer_group_created=0
producer_contained=0
handoff_group_created=0
broker_group_added=0
containment_proved=0
held_directories=0

macos_uid_processes() {
  /bin/ps -axo uid=,pid= | /usr/bin/awk -v expected="$producer_uid" \
    '$1 == expected && $2 ~ /^[0-9]+$/ { print $2 }'
}

lock_macos_account() {
  /usr/bin/dscl . -create "/Users/$producer_name" UserShell /usr/bin/false
  /usr/bin/dscl . -create "/Users/$producer_name" AuthenticationAuthority ';DisabledUser;'
  /usr/bin/dscl . -create "/Users/$producer_name" Password '*'
}

drain_macos_uid() {
  local attempt zero_count pids pid
  zero_count=0
  for attempt in $(/usr/bin/jot 240 1 240); do
    pids="$(macos_uid_processes)"
    if [[ -z "$pids" ]]; then
      zero_count=$((zero_count + 1))
      if (( zero_count >= 3 )); then
        return 0
      fi
    else
      zero_count=0
      while IFS= read -r pid; do
        [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
      done <<<"$pids"
    fi
    /bin/sleep 0.05
  done
  return 1
}

drain_linux_cgroup() {
  local attempt events
  [[ -n "$cgroup_path" && -f "$cgroup_path/cgroup.kill" &&
     -f "$cgroup_path/cgroup.events" && -w "$cgroup_path/cgroup.kill" ]] || return 1
  printf '1\n' >"$cgroup_path/cgroup.kill" || return 1
  for attempt in $(/usr/bin/seq 1 400); do
    events="$(cat "$cgroup_path/cgroup.events")" || return 1
    if grep -qx 'populated 0' <<<"$events"; then
      rmdir "$cgroup_path" || return 1
      cgroup_path=
      return 0
    fi
    /bin/sleep 0.05
  done
  return 1
}

delete_producer_account() {
  if (( producer_deleted == 1 )); then
    return 0
  fi
  if [[ "$host_os" == Linux ]]; then
    if (( producer_created == 1 )); then
      /usr/sbin/userdel "$producer_name"
    fi
    if (( producer_group_created == 1 )); then
      /usr/sbin/groupdel "$producer_group"
      producer_group_created=0
    fi
    if { [[ -n "$producer_uid" ]] && getent passwd "$producer_uid" >/dev/null; } ||
       { [[ -n "$producer_gid" ]] && getent group "$producer_gid" >/dev/null; }; then
      return 1
    fi
  else
    if (( producer_created == 1 )); then
      lock_macos_account
      drain_macos_uid || return 1
      /usr/bin/dscl . -delete "/Users/$producer_name"
    fi
    if (( producer_group_created == 1 )); then
      /usr/sbin/dseditgroup -o delete "$producer_group"
      producer_group_created=0
    fi
    if { [[ -n "$producer_uid" ]] &&
         /usr/bin/dscl . -search /Users UniqueID "$producer_uid" 2>/dev/null | grep -q .; } ||
       { [[ -n "$producer_uid" ]] && [[ -n "$(macos_uid_processes)" ]]; }; then
      return 1
    fi
  fi
  producer_deleted=1
}

cleanup() {
  local original_status=$?
  local cleanup_failed=0
  trap - EXIT INT TERM
  if [[ -n "$producer_pid" ]] && kill -0 "$producer_pid" 2>/dev/null; then
    kill -KILL "$producer_pid" 2>/dev/null || cleanup_failed=1
    wait "$producer_pid" 2>/dev/null || true
  fi
  if [[ "$host_os" == Linux && -n "$cgroup_path" ]]; then
    drain_linux_cgroup || cleanup_failed=1
  elif [[ "$host_os" == Darwin && -n "$producer_uid" && $producer_created -eq 1 ]]; then
    lock_macos_account 2>/dev/null || cleanup_failed=1
    drain_macos_uid || cleanup_failed=1
  fi
  delete_producer_account 2>/dev/null || cleanup_failed=1
  if (( broker_group_added == 1 )); then
    if [[ "$host_os" == Linux ]]; then
      /usr/bin/gpasswd -d "$broker_name" "$handoff_group" >/dev/null 2>&1 ||
        cleanup_failed=1
    else
      /usr/sbin/dseditgroup -o edit -d "$broker_name" -t user "$handoff_group" \
        >/dev/null 2>&1 || cleanup_failed=1
    fi
    broker_group_added=0
  fi
  if (( handoff_group_created == 1 )); then
    if [[ "$host_os" == Linux ]]; then
      /usr/sbin/groupdel "$handoff_group" >/dev/null 2>&1 || cleanup_failed=1
    else
      /usr/sbin/dseditgroup -o delete "$handoff_group" >/dev/null 2>&1 ||
        cleanup_failed=1
    fi
    handoff_group_created=0
  fi
  if (( held_directories == 1 )); then
    exec 9<&-
    exec 8<&-
    exec 7<&-
    held_directories=0
  fi
  if [[ -n "$isolated_root" && -d "$isolated_root" && ! -L "$isolated_root" ]]; then
    rm -rf -- "$isolated_root" || cleanup_failed=1
  fi
  if [[ "${temp_root_relaxed:-0}" == 1 ]]; then
    chmod "$temp_mode" "$temp_root" || cleanup_failed=1
    temp_root_relaxed=0
  fi
  if (( original_status != 0 || cleanup_failed != 0 )); then
    exit 1
  fi
  exit 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$host_os" == Linux ]]; then
  /usr/sbin/groupadd --system "$producer_group"
  producer_group_created=1
  producer_gid="$(getent group "$producer_group" | cut -d: -f3)"
  /usr/sbin/useradd \
    --system \
    --gid "$producer_group" \
    --home-dir "$producer_root/home" \
    --no-create-home \
    --shell /usr/sbin/nologin \
    --password '!' \
    "$producer_name"
  producer_created=1
  producer_uid="$(id -u "$producer_name")"
  /usr/sbin/groupadd --system "$handoff_group"
  handoff_group_created=1
  handoff_gid="$(getent group "$handoff_group" | cut -d: -f3)"
else
  allocate_id() {
    local candidate
    candidate=40000
    while /usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk -v id="$candidate" \
            '$2 == id { found = 1 } END { exit !found }' ||
          /usr/bin/dscl . -list /Groups PrimaryGroupID | /usr/bin/awk -v id="$candidate" \
            '$2 == id { found = 1 } END { exit !found }' ||
          /bin/ps -axo uid= | /usr/bin/awk -v id="$candidate" \
            '$1 == id { found = 1 } END { exit !found }'; do
      candidate=$((candidate + 1))
      (( candidate < 60000 )) || return 1
    done
    printf '%s\n' "$candidate"
  }
  producer_uid="$(allocate_id)"
  producer_gid="$producer_uid"
  producer_guid="$(/usr/bin/uuidgen)"
  [[ "$producer_guid" =~ ^[0-9A-F-]{36}$ ]] ||
    { echo 'unix-producer-supervisor: ephemeral account GUID generation failed' >&2; exit 1; }
  /usr/sbin/dseditgroup -o create -i "$producer_gid" "$producer_group"
  producer_group_created=1
  /usr/bin/dscl . -create "/Users/$producer_name"
  /usr/bin/dscl . -create "/Users/$producer_name" GeneratedUID "$producer_guid"
  /usr/bin/dscl . -create "/Users/$producer_name" UniqueID "$producer_uid"
  /usr/bin/dscl . -create "/Users/$producer_name" PrimaryGroupID "$producer_gid"
  /usr/bin/dscl . -create "/Users/$producer_name" NFSHomeDirectory "$producer_root/home"
  /usr/bin/dscl . -create "/Users/$producer_name" RealName 'OpenCoven ephemeral producer'
  /usr/bin/dscl . -create "/Users/$producer_name" IsHidden 1
  lock_macos_account
  producer_created=1
  handoff_gid=$((producer_gid + 1))
  while /usr/bin/dscl . -list /Groups PrimaryGroupID | /usr/bin/awk -v id="$handoff_gid" \
          '$2 == id { found = 1 } END { exit !found }'; do
    handoff_gid=$((handoff_gid + 1))
  done
  /usr/sbin/dseditgroup -o create -i "$handoff_gid" "$handoff_group"
  handoff_group_created=1
fi
if [[ "$producer_uid" == "$broker_uid" || "$producer_uid" == 0 ||
      "$producer_gid" == "$broker_gid" || "$handoff_gid" == "$producer_gid" ]]; then
  echo 'unix-producer-supervisor: ephemeral identity is not distinct' >&2
  exit 1
fi
if [[ "$host_os" == Linux ]]; then
  observed_producer_uid="$(
    /usr/bin/setpriv --reuid="$producer_uid" --regid="$producer_gid" --init-groups /usr/bin/id -u
  )"
  [[ "$observed_producer_uid" == "$producer_uid" ]] ||
    { echo 'unix-producer-supervisor: restricted identity launch failed' >&2; exit 1; }
  if id -nG "$producer_name" | tr ' ' '\n' | grep -qxE 'root|sudo|wheel|admin'; then
    echo 'unix-producer-supervisor: ephemeral identity is privileged' >&2
    exit 1
  fi
else
  observed_producer_uid="$(/usr/bin/sudo -n -u "#$producer_uid" /usr/bin/id -u)" ||
    { echo 'unix-producer-supervisor: restricted identity launch failed' >&2; exit 1; }
  [[ "$observed_producer_uid" == "$producer_uid" ]] ||
    { echo 'unix-producer-supervisor: restricted identity launch changed UID' >&2; exit 1; }
  admin_membership="$(
    /usr/bin/dsmemberutil checkmembership -U "$producer_name" -G admin
  )" ||
    { echo 'unix-producer-supervisor: administrator membership query failed' >&2; exit 1; }
  [[ "$admin_membership" == *'is not a member'* ]] ||
    { echo 'unix-producer-supervisor: ephemeral identity is privileged' >&2; exit 1; }
fi
old_ifs=$IFS
IFS=:
for tool_directory in $tool_path; do
  if [[ "$host_os" == Linux ]]; then
    if /usr/bin/setpriv --reuid="$producer_uid" --regid="$producer_gid" --init-groups \
      /usr/bin/test -w "$tool_directory"; then
      echo 'unix-producer-supervisor: restricted identity can mutate a tool directory' >&2
      exit 1
    fi
  elif /usr/bin/sudo -n -u "#$producer_uid" /usr/bin/test -w "$tool_directory"; then
    echo 'unix-producer-supervisor: restricted identity can mutate a tool directory' >&2
    exit 1
  fi
done
IFS=$old_ifs

mkdir -p -m 700 \
  "$producer_root" \
  "$artifact_workspace" \
  "$artifact_workspace/.artifacts" \
  "$producer_root/home" \
  "$producer_root/temp" \
  "$producer_root/cache" \
  "$producer_root/config" \
  "$producer_root/data" \
  "$producer_root/cargo" \
  "$producer_root/rustup" \
  "$producer_root/corepack" \
  "$producer_root/pnpm-home" \
  "$producer_root/pnpm-store"
mkdir -m 755 "$workspace"
mkdir -m 555 "$trusted_root"
cp -a "$source_path/." "$workspace/"
if [[ -e "$workspace/node_modules" || -L "$workspace/node_modules" ]]; then
  echo 'unix-producer-supervisor: source checkout contains dependency output' >&2
  exit 1
fi
rm -rf -- "$workspace/.artifacts"
if [[ -e "$source_record" || -L "$source_record" ]]; then
  echo 'unix-producer-supervisor: source checkout contains a preexisting record' >&2
  exit 1
fi
cp "$command_path" "$trusted_command"
cp "$handoff_helper" "$trusted_handoff"
if [[ "$host_os" == Darwin ]]; then
  /bin/chmod -RN "$producer_root" "$workspace" "$trusted_root"
fi
chown root:0 "$trusted_root" "$trusted_command" "$trusted_handoff"
chmod 555 "$trusted_root" "$trusted_command"
chmod 500 "$trusted_handoff"
chown -R -h "$producer_uid:$producer_gid" \
  "$producer_root/home" \
  "$producer_root/temp" \
  "$producer_root/cache" \
  "$producer_root/config" \
  "$producer_root/data" \
  "$producer_root/cargo" \
  "$producer_root/rustup" \
  "$producer_root/corepack" \
  "$producer_root/pnpm-home" \
  "$producer_root/pnpm-store" \
  "$artifact_workspace"
chown "$producer_uid:$producer_gid" "$producer_root"
chmod 700 "$producer_root" "$artifact_workspace" "$artifact_workspace/.artifacts"
chown -R -h root:0 "$workspace"
chmod -R a+rX "$workspace"
chmod -R a-w "$workspace"
mkdir -m 700 "$workspace/node_modules"
chown "$producer_uid:$producer_gid" "$workspace/node_modules"

read -r root_device root_inode <<<"$(stat_identity "$producer_root")"
read -r workspace_device workspace_inode <<<"$(stat_identity "$artifact_workspace")"
read -r artifact_device artifact_inode <<<"$(stat_identity "$artifact_workspace/.artifacts")"
exec 7<"$producer_root"
exec 8<"$artifact_workspace"
exec 9<"$artifact_workspace/.artifacts"
held_directories=1

restricted_environment=(
  "HOME=$producer_root/home"
  "TMPDIR=$producer_root/temp"
  "TMP=$producer_root/temp"
  "TEMP=$producer_root/temp"
  "RUNNER_TEMP=$producer_root/temp"
  "GITHUB_WORKSPACE=$workspace"
  "XDG_CACHE_HOME=$producer_root/cache"
  "XDG_CONFIG_HOME=$producer_root/config"
  "XDG_DATA_HOME=$producer_root/data"
  "CARGO_HOME=$producer_root/cargo"
  "RUSTUP_HOME=$producer_root/rustup"
  "COREPACK_HOME=$producer_root/corepack"
  "PNPM_HOME=$producer_root/pnpm-home"
  "PNPM_STORE_DIR=$producer_root/pnpm-store"
  "PATH=$producer_root/cargo/bin:$tool_path"
  "LANG=C"
  "LC_ALL=C"
  "CI=1"
  "NO_COLOR=1"
  "GIT_TERMINAL_PROMPT=0"
  "GIT_CONFIG_GLOBAL=/dev/null"
  "GIT_CONFIG_NOSYSTEM=1"
  "GIT_NO_REPLACE_OBJECTS=1"
  "GIT_NO_LAZY_FETCH=1"
  "NPM_CONFIG_USERCONFIG=/dev/null"
  "NPM_CONFIG_PROXY="
  "NPM_CONFIG_HTTPS_PROXY="
  "HTTP_PROXY="
  "HTTPS_PROXY="
  "ALL_PROXY="
  "http_proxy="
  "https_proxy="
  "all_proxy="
  "OPENCOVEN_UNIX_PRODUCER_REQUIRED=1"
  "OPENCOVEN_UNIX_PRODUCER_PLATFORM=$platform"
  "OPENCOVEN_UNIX_PRODUCER_UID=$producer_uid"
  "OPENCOVEN_UNIX_PRODUCER_NAME=$producer_name"
  "OPENCOVEN_UNIX_BROKER_UID=$broker_uid"
  "OPENCOVEN_UNIX_CONTAINMENT=$containment"
  "OPENCOVEN_UNIX_WORKSPACE=$workspace"
  "OPENCOVEN_UNIX_ARTIFACT_DIRECTORY=$artifact_workspace/.artifacts"
  "OPENCOVEN_UNIX_SOURCE_RECORD=$source_record"
)
if [[ -n "$validator_revision" ]]; then
  restricted_environment+=("OPENCOVEN_VALIDATOR_REVISION=$validator_revision")
fi

if [[ "$host_os" == Linux ]]; then
  [[ "$(/usr/bin/stat -fc '%T' /sys/fs/cgroup)" == cgroup2fs ]] ||
    { echo 'unix-producer-supervisor: writable cgroup v2 is required' >&2; exit 1; }
  broker_cgroup="$(/usr/bin/awk -F: '$1 == "0" && $2 == "" { print $3 }' /proc/self/cgroup)"
  [[ "$broker_cgroup" == /* && "$broker_cgroup" != *..* ]] ||
    { echo 'unix-producer-supervisor: broker cgroup v2 path is invalid' >&2; exit 1; }
  cgroup_parent="/sys/fs/cgroup${broker_cgroup%/}"
  cgroup_path="$cgroup_parent/opencoven-chat-$nonce"
  cgroup_relative="${broker_cgroup%/}/opencoven-chat-$nonce"
  [[ "$cgroup_relative" == /* ]] || cgroup_relative="/$cgroup_relative"
  mkdir "$cgroup_path"
  [[ -w "$cgroup_path/cgroup.procs" && -w "$cgroup_path/cgroup.kill" &&
     -r "$cgroup_path/cgroup.events" ]] ||
    { echo 'unix-producer-supervisor: writable cgroup v2 controls are unavailable' >&2; exit 1; }
  restricted_environment+=("OPENCOVEN_UNIX_CGROUP_PATH=$cgroup_relative")
  /usr/bin/setpriv \
    --reuid="$producer_uid" \
    --regid="$producer_gid" \
    --init-groups \
    /usr/bin/env -i "${restricted_environment[@]}" \
      /bin/bash -c \
      'exec 7<&- 8<&- 9<&-; kill -STOP $$; cd "$OPENCOVEN_UNIX_WORKSPACE"; exec "$@"' \
      opencoven-producer \
      "$trusted_command" "${command_arguments[@]}" &
  producer_pid=$!
  stopped=0
  for _ in $(/usr/bin/seq 1 200); do
    state="$(/bin/ps -o state= -p "$producer_pid" | tr -d '[:space:]')" || true
    if [[ "$state" == *T* ]]; then stopped=1; break; fi
    kill -0 "$producer_pid" 2>/dev/null || break
    /bin/sleep 0.01
  done
  (( stopped == 1 )) ||
    { echo 'unix-producer-supervisor: restricted root did not suspend before cgroup assignment' >&2; exit 1; }
  printf '%s\n' "$producer_pid" >"$cgroup_path/cgroup.procs"
  grep -qx "0::$cgroup_relative" "/proc/$producer_pid/cgroup" ||
    { echo 'unix-producer-supervisor: restricted root cgroup membership failed' >&2; exit 1; }
  producer_contained=1
  kill -CONT "$producer_pid"
else
  /usr/bin/sudo -n -u "#$producer_uid" /usr/bin/env -i "${restricted_environment[@]}" \
    /bin/bash -c \
    'exec 7<&- 8<&- 9<&-; cd "$OPENCOVEN_UNIX_WORKSPACE"; exec "$@"' opencoven-producer \
    "$trusted_command" "${command_arguments[@]}" &
  producer_pid=$!
  producer_contained=1
fi

started_seconds=$SECONDS
timed_out=0
while kill -0 "$producer_pid" 2>/dev/null; do
  if (( SECONDS - started_seconds >= timeout_seconds )); then
    timed_out=1
    break
  fi
  /bin/sleep 0.02
done
if (( timed_out == 1 )); then
  echo 'unix-producer-supervisor: restricted production timed out' >&2
  kill -KILL "$producer_pid" 2>/dev/null || true
fi
set +e
wait "$producer_pid"
producer_status=$?
set -e
producer_pid=

if [[ "$host_os" == Linux ]]; then
  drain_linux_cgroup ||
    { echo 'unix-producer-supervisor: cgroup.kill did not reach populated 0' >&2; exit 1; }
  containment_proved=1
  echo "unix-producer-supervisor: Linux cgroup v2 drained ($cgroup_relative)"
else
  lock_macos_account
  drain_macos_uid ||
    { echo 'unix-producer-supervisor: exact macOS producer UID did not reach zero processes' >&2; exit 1; }
  containment_proved=1
  echo "unix-producer-supervisor: macOS UID $producer_uid reached zero processes"
fi
(( timed_out == 0 && producer_status == 0 && producer_contained == 1 &&
   containment_proved == 1 )) ||
  { echo 'unix-producer-supervisor: restricted production failed' >&2; exit 1; }

delete_producer_account ||
  { echo 'unix-producer-supervisor: ephemeral producer account cleanup failed' >&2; exit 1; }
chmod "$temp_mode" "$temp_root"
temp_root_relaxed=0

"$trusted_handoff" prepare \
  "$producer_root" \
  "workspace/.artifacts/client-v1-conformance-$platform.json" \
  "$producer_uid" \
  "$producer_gid" \
  "$handoff_gid" \
  "$root_device" "$root_inode" \
  "$workspace_device" "$workspace_inode" \
  "$artifact_device" "$artifact_inode"
chown "root:$handoff_gid" "$isolated_root" "$trusted_root" "$trusted_handoff"
chmod 550 "$trusted_root" "$trusted_handoff"
chmod 750 "$isolated_root"

if [[ "$host_os" == Linux ]]; then
  /usr/sbin/usermod --append --groups "$handoff_group" "$broker_name"
  broker_group_added=1
  /usr/sbin/runuser --user "$broker_name" -- /usr/bin/id -G |
    tr ' ' '\n' |
    grep -qx "$handoff_gid" ||
    { echo 'unix-producer-supervisor: broker handoff group membership failed' >&2; exit 1; }
  /usr/sbin/runuser --user "$broker_name" -- \
    "$trusted_handoff" copy \
      "$producer_root" \
      "workspace/.artifacts/client-v1-conformance-$platform.json" \
      "$destination_path" \
      "$producer_uid" \
      "$handoff_gid" \
      "$broker_uid" \
      "$root_device" "$root_inode" \
      "$workspace_device" "$workspace_inode" \
      "$artifact_device" "$artifact_inode"
else
  /usr/sbin/dseditgroup -o edit -a "$broker_name" -t user "$handoff_group"
  broker_group_added=1
  /usr/bin/dsmemberutil checkmembership -U "$broker_name" -G "$handoff_group" |
    grep -q 'is a member' ||
    { echo 'unix-producer-supervisor: broker handoff group membership failed' >&2; exit 1; }
  /usr/bin/sudo -n -u "#$broker_uid" "$trusted_handoff" copy \
    "$producer_root" \
    "workspace/.artifacts/client-v1-conformance-$platform.json" \
    "$destination_path" \
    "$producer_uid" \
    "$handoff_gid" \
    "$broker_uid" \
    "$root_device" "$root_inode" \
    "$workspace_device" "$workspace_inode" \
    "$artifact_device" "$artifact_inode"
fi

[[ "$(stat_owner "$destination_path")" == "$broker_uid" &&
   "$(stat_mode "$destination_path")" == 600 &&
   "$(stat_links "$destination_path")" == 1 ]] ||
  { echo 'unix-producer-supervisor: broker artifact verification failed' >&2; exit 1; }

echo "unix-producer-supervisor: protected $platform handoff complete"
