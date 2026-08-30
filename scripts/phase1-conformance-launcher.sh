#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "phase1-conformance-launcher: absolute Node path required" >&2
  exit 1
fi

node_path=$1
shift
case "$node_path" in
  /*) ;;
  *) echo "phase1-conformance-launcher: absolute Node path required" >&2; exit 1 ;;
esac
if [ ! -f "$node_path" ] || [ ! -x "$node_path" ] || [ -L "$node_path" ]; then
  echo "phase1-conformance-launcher: trusted Node executable unavailable" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
runner="$script_dir/phase1-conformance.mjs"
if [ ! -f "$runner" ] || [ -L "$runner" ]; then
  echo "phase1-conformance-launcher: runner unavailable" >&2
  exit 1
fi

exec /usr/bin/env -i \
  PATH="${PATH:-}" \
  HOME="${HOME:-}" \
  TMPDIR="${TMPDIR:-}" \
  LANG="${LANG:-C.UTF-8}" \
  LC_ALL="${LC_ALL:-}" \
  CI="${CI:-1}" \
  RUSTUP_HOME="${RUSTUP_HOME:-}" \
  CARGO_HOME="${CARGO_HOME:-}" \
  OPENCOVEN_CHAT_ROOT="${OPENCOVEN_CHAT_ROOT:-}" \
  OPENCOVEN_SDK_ROOT="${OPENCOVEN_SDK_ROOT:-}" \
  OPENCOVEN_SDK_EVIDENCE_ROOT="${OPENCOVEN_SDK_EVIDENCE_ROOT:-}" \
  OPENCOVEN_CAVE_ROOT="${OPENCOVEN_CAVE_ROOT:-}" \
  OPENCOVEN_COVEN_ROOT="${OPENCOVEN_COVEN_ROOT:-}" \
  OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED="${OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED:-}" \
  PHASE1_TEST_KEYCHAIN="${PHASE1_TEST_KEYCHAIN:-}" \
  "$node_path" "$runner" "$@"
