#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
scratch_root="$(mktemp -d /tmp/opencoven-unix-supervisor-test.XXXXXXXX)"
scratch_root="$(cd "$scratch_root" && pwd -P)"
handoff_source="$project_root/scripts/unix-artifact-handoff.c"
supervisor="$project_root/scripts/unix-producer-supervisor.sh"
attack_source="$project_root/scripts/unix-producer-supervisor-attack.c"
handoff="$scratch_root/unix-artifact-handoff"
handoff_test="$scratch_root/unix-artifact-handoff-test"
attack="$scratch_root/unix-producer-supervisor-attack"

chmod 700 "$scratch_root"
chgrp "$(id -g)" "$scratch_root"
trap 'rm -rf -- "$scratch_root"' EXIT

cc -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -Werror -O2 "$handoff_source" -o "$handoff"
cc -std=c11 -D_DARWIN_C_SOURCE -DOPENCOVEN_HANDOFF_TESTING=1 \
  -Wall -Wextra -Werror -O2 "$handoff_source" -o "$handoff_test"
cc -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -Werror -O2 "$attack_source" -o "$attack"
chmod 500 "$handoff" "$handoff_test" "$attack"

identity() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    /usr/bin/stat -f '%d %i' "$1"
  else
    /usr/bin/stat -c '%d %i' "$1"
  fi
}

prepare_direct_tree() {
  local root="$1"
  rm -rf -- "$root"
  mkdir -p -m 700 "$root/workspace/.artifacts"
  chmod 700 "$root" "$root/workspace" "$root/workspace/.artifacts"
  printf '{"platform":"direct","schemaVersion":2}\n' \
    >"$root/workspace/.artifacts/record.json"
  chmod 600 "$root/workspace/.artifacts/record.json"
}

handoff_arguments() {
  local root="$1"
  local root_identity workspace_identity artifact_identity
  read -r -a root_identity <<<"$(identity "$root")"
  read -r -a workspace_identity <<<"$(identity "$root/workspace")"
  read -r -a artifact_identity <<<"$(identity "$root/workspace/.artifacts")"
  printf '%s\n' \
    "${root_identity[0]}" "${root_identity[1]}" \
    "${workspace_identity[0]}" "${workspace_identity[1]}" \
    "${artifact_identity[0]}" "${artifact_identity[1]}"
}

direct_root="$scratch_root/direct-root"
direct_destination="$scratch_root/direct-record.json"
prepare_direct_tree "$direct_root"
read -r direct_root_dev direct_root_ino \
  direct_workspace_dev direct_workspace_ino \
  direct_artifact_dev direct_artifact_ino \
  <<<"$(handoff_arguments "$direct_root" | tr '\n' ' ')"
"$handoff" prepare "$direct_root" workspace/.artifacts/record.json \
  "$(id -u)" "$(id -g)" "$(id -g)" \
  "$direct_root_dev" "$direct_root_ino" \
  "$direct_workspace_dev" "$direct_workspace_ino" \
  "$direct_artifact_dev" "$direct_artifact_ino"
"$handoff" copy "$direct_root" workspace/.artifacts/record.json "$direct_destination" \
  "$(id -u)" "$(id -g)" "$(id -u)" \
  "$direct_root_dev" "$direct_root_ino" \
  "$direct_workspace_dev" "$direct_workspace_ino" \
  "$direct_artifact_dev" "$direct_artifact_ino"
cmp "$direct_root/workspace/.artifacts/record.json" "$direct_destination"
if [[ "$(uname -s)" == "Darwin" ]]; then
  [[ "$(/usr/bin/stat -f '%Lp' "$direct_destination")" == "600" ]]
else
  [[ "$(/usr/bin/stat -c '%a' "$direct_destination")" == "600" ]]
fi

rewrite_root="$scratch_root/rewrite-root"
rewrite_destination="$scratch_root/rewrite-record.json"
rewrite_ready="$scratch_root/rewrite.ready"
rewrite_release="$scratch_root/rewrite.release"
prepare_direct_tree "$rewrite_root"
read -r rewrite_root_dev rewrite_root_ino \
  rewrite_workspace_dev rewrite_workspace_ino \
  rewrite_artifact_dev rewrite_artifact_ino \
  <<<"$(handoff_arguments "$rewrite_root" | tr '\n' ' ')"
"$handoff_test" prepare "$rewrite_root" workspace/.artifacts/record.json \
  "$(id -u)" "$(id -g)" "$(id -g)" \
  "$rewrite_root_dev" "$rewrite_root_ino" \
  "$rewrite_workspace_dev" "$rewrite_workspace_ino" \
  "$rewrite_artifact_dev" "$rewrite_artifact_ino"
OPENCOVEN_HANDOFF_TEST_READY="$rewrite_ready" \
OPENCOVEN_HANDOFF_TEST_RELEASE="$rewrite_release" \
  "$handoff_test" copy "$rewrite_root" workspace/.artifacts/record.json "$rewrite_destination" \
    "$(id -u)" "$(id -g)" "$(id -u)" \
    "$rewrite_root_dev" "$rewrite_root_ino" \
    "$rewrite_workspace_dev" "$rewrite_workspace_ino" \
    "$rewrite_artifact_dev" "$rewrite_artifact_ino" &
rewrite_pid=$!
for _ in {1..200}; do
  [[ -e "$rewrite_ready" ]] && break
  sleep 0.01
done
[[ -e "$rewrite_ready" ]]
printf '{"platform":"rewritten","schemaVersion":2}\n' \
  >"$rewrite_root/workspace/.artifacts/record.json"
printf 'continue\n' >"$rewrite_release"
if wait "$rewrite_pid"; then
  echo 'in-place rewrite artifact handoff unexpectedly succeeded' >&2
  exit 1
fi
[[ ! -e "$rewrite_destination" ]]

if ! sudo -n true >/dev/null 2>&1; then
  echo 'unix-producer-supervisor: privileged native UID containment tests skipped (sudo -n unavailable)'
  exit 0
fi

platform=
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *)
    echo 'unix-producer-supervisor: unsupported native test platform' >&2
    exit 1
    ;;
esac

source_root="$scratch_root/source"
mkdir -p -m 700 "$source_root"
printf 'fixture\n' >"$source_root/tracked.txt"

run_supervisor() {
  local case_name="$1"
  local destination="$scratch_root/$case_name.json"
  rm -f -- "$destination"
  sudo -n "$supervisor" \
    --platform "$platform" \
    --source "$source_root" \
    --destination "$destination" \
    --temp-root "$scratch_root" \
    --handoff-helper "$handoff" \
    --command "$attack" \
    --command-arg "$case_name" \
    --timeout-seconds 30
}

set +e
no_argument_output="$(
  sudo -n "$supervisor" \
    --platform "$platform" \
    --source "$source_root" \
    --destination "$scratch_root/no-arguments.json" \
    --temp-root "$scratch_root" \
    --handoff-helper "$handoff" \
    --command "$attack" \
    --timeout-seconds 30 2>&1
)"
no_argument_status=$?
set -e
if (( no_argument_status == 0 )) ||
   [[ "$no_argument_output" != *'usage: unix-producer-supervisor-attack CASE'* ]] ||
   [[ "$no_argument_output" == *'command_arguments[@]: unbound variable'* ]]; then
  echo 'zero command arguments were not forwarded safely' >&2
  exit 1
fi
[[ ! -e "$scratch_root/no-arguments.json" ]]

run_supervisor escape
node --input-type=module --eval "
  import { readFileSync } from 'node:fs';
  const record = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  if (record.producerUid === record.brokerUid) {
    throw new Error('producer and broker UIDs were not distinct');
  }
  let removed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(record.escapePid, 0);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      removed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!removed) throw new Error('setsid/double-fork descendant survived containment cleanup');
  if (readFileSync(process.argv[1], 'utf8').includes('escaped-replacement')) {
    throw new Error('escaped descendant replaced the handed-off record');
  }
" "$scratch_root/escape.json"

producer_uid="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).producerUid" "$scratch_root/escape.json")"
producer_name="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).producerName" "$scratch_root/escape.json")"
if id "$producer_name" >/dev/null 2>&1 ||
   { [[ "$(uname -s)" == "Darwin" ]] &&
     dscl . -search /Users UniqueID "$producer_uid" 2>/dev/null | grep -q .; } ||
   { [[ "$(uname -s)" == "Linux" ]] &&
     getent passwd "$producer_uid" | grep -q .; }; then
  echo 'ephemeral producer UID was reused or not deleted' >&2
  exit 1
fi

for attack_case in symlink hardlink parent-replacement; do
  if run_supervisor "$attack_case"; then
    case "$attack_case" in
      symlink) echo 'symlink artifact handoff unexpectedly succeeded' >&2 ;;
      hardlink) echo 'hardlink artifact handoff unexpectedly succeeded' >&2 ;;
      parent-replacement) echo 'parent replacement artifact handoff unexpectedly succeeded' >&2 ;;
    esac
    exit 1
  fi
  [[ ! -e "$scratch_root/$attack_case.json" ]]
done

echo "unix-producer-supervisor: native $platform tests passed"
