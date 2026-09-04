#!/usr/bin/env bash
set -Eeuo pipefail

unset \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_URL \
  GH_TOKEN \
  GITHUB_TOKEN

: "${OPENCOVEN_UNIX_PRODUCER_REQUIRED:?}"
: "${OPENCOVEN_UNIX_PRODUCER_PLATFORM:?}"
: "${OPENCOVEN_UNIX_PRODUCER_UID:?}"
: "${OPENCOVEN_UNIX_BROKER_UID:?}"
: "${OPENCOVEN_UNIX_CONTAINMENT:?}"
: "${OPENCOVEN_UNIX_WORKSPACE:?}"
: "${OPENCOVEN_UNIX_SOURCE_RECORD:?}"
: "${OPENCOVEN_UNIX_TRUSTED_PNPM:?}"
: "${OPENCOVEN_VALIDATOR_REVISION:?}"

[[ "$OPENCOVEN_UNIX_PRODUCER_REQUIRED" == 1 ]]
[[ "$OPENCOVEN_UNIX_PRODUCER_UID" == "$(id -u)" ]]
[[ "$OPENCOVEN_UNIX_PRODUCER_UID" != "$OPENCOVEN_UNIX_BROKER_UID" ]]
[[ "$OPENCOVEN_UNIX_WORKSPACE" == "$PWD" ]]
[[ "$OPENCOVEN_VALIDATOR_REVISION" =~ ^[0-9a-f]{40}$ ]]

export CARGO_NET_GIT_FETCH_WITH_CLI=true
export RUSTUP_TOOLCHAIN=1.95.0

phase1_source_arguments=(
  --chat-root "$OPENCOVEN_UNIX_WORKSPACE"
  --sdk-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk"
  --sdk-evidence-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk-evidence"
  --validator-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk-validator"
  --cave-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/coven-cave"
  --coven-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/coven"
)

node "$OPENCOVEN_UNIX_TRUSTED_PNPM" --version | grep -qx '10.34.0'
node --version | grep -qx 'v24.18.1'
node "$OPENCOVEN_UNIX_TRUSTED_PNPM" install --frozen-lockfile --ignore-scripts --config.store-dir="$PNPM_STORE_DIR"
rustup toolchain install 1.95.0 --profile minimal
rustup default 1.95.0
rustc --version | grep -q '^rustc 1\.95\.0 '
node "$OPENCOVEN_UNIX_TRUSTED_PNPM" exec tauri --version | grep -qx 'tauri-cli 2.11.4'

if [[ "$OPENCOVEN_UNIX_PRODUCER_PLATFORM" == linux-x64 ]]; then
  bash scripts/phase1-linux-secret-service.sh \
    --validator-revision "$OPENCOVEN_VALIDATOR_REVISION" \
    --platform "$OPENCOVEN_UNIX_PRODUCER_PLATFORM" \
    --output "$OPENCOVEN_UNIX_SOURCE_RECORD" \
    "${phase1_source_arguments[@]}"
else
  node scripts/phase1-conformance.mjs \
    --validator-revision "$OPENCOVEN_VALIDATOR_REVISION" \
    --platform "$OPENCOVEN_UNIX_PRODUCER_PLATFORM" \
    --output "$OPENCOVEN_UNIX_SOURCE_RECORD" \
    "${phase1_source_arguments[@]}"
fi

node --input-type=module --eval "
  import { lstatSync, readFileSync } from 'node:fs';
  const sort = (value) =>
    Array.isArray(value)
      ? value.map(sort)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
        : value;
  const path = process.argv[1];
  const expectedPlatform = process.argv[2];
  const stats = lstatSync(path);
  const text = readFileSync(path, 'utf8');
  const value = JSON.parse(text);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.uid !== Number(process.env.OPENCOVEN_UNIX_PRODUCER_UID) ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size < 1 ||
    stats.size > 1048576 ||
    value === null ||
    Array.isArray(value) ||
    value.schemaVersion !== 2 ||
    value.platform !== expectedPlatform ||
    JSON.stringify(sort(value), null, 2) + '\n' !== text
  ) {
    throw new Error('Restricted platform record is not canonical and privately owned');
  }
" "$OPENCOVEN_UNIX_SOURCE_RECORD" "$OPENCOVEN_UNIX_PRODUCER_PLATFORM"
