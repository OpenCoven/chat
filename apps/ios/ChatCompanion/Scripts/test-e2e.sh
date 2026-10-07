#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$app_dir/../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/chat-companion-test.XXXXXX")"
fixture_pid=""
simulator=""
cleanup() {
  rm -f "$app_dir/TestSupport/LocalPairing.json"
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$simulator" ]]; then xcrun simctl shutdown "$simulator" 2>/dev/null || true; xcrun simctl delete "$simulator"; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
cd "$repo_dir"
rustup run 1.95.0 cargo build --locked --manifest-path src-tauri/Cargo.toml --features companion-fixture --bin companion-fixture
src-tauri/target/debug/companion-fixture "$fixture_dir/state" > "$fixture_dir/receipt.json" &
fixture_pid=$!
for _ in {1..100}; do
  if [[ -s "$fixture_dir/receipt.json" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then echo 'Companion fixture exited before readiness.' >&2; exit 1; fi
  sleep 0.2
done
if [[ ! -s "$fixture_dir/receipt.json" ]]; then echo 'Companion fixture did not start.' >&2; exit 1; fi
mkdir -p "$app_dir/TestSupport"
cp "$fixture_dir/receipt.json" "$app_dir/TestSupport/LocalPairing.json"
if [[ -n "${CHAT_IOS_DESTINATION:-}" ]]; then
  destination="$CHAT_IOS_DESTINATION"
else
  runtime="$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; r=[r for r in json.load(sys.stdin)["runtimes"] if r["isAvailable"] and ".iOS-" in r["identifier"]]; print(sorted(r,key=lambda r:tuple(map(int,r["version"].split("."))))[-1]["identifier"])')"
  simulator="$(xcrun simctl create "Chat Companion verification" com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro "$runtime")"
  destination="platform=iOS Simulator,id=$simulator"
fi
cd "$app_dir"
xcodegen generate
# Ad-hoc simulator signing supplies the application entitlement required by real
# Keychain tests. Do not substitute an insecure simulator credential store.
xcodebuild -project ChatCompanion.xcodeproj -scheme ChatCompanion \
  -destination "$destination" -derivedDataPath "${CHAT_IOS_DERIVED_DATA:-$fixture_dir/DerivedData}" \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM=LOCALTEST0 test
xcodebuild -project ChatCompanion.xcodeproj -scheme ChatCompanion -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$fixture_dir/DeviceBuild" CODE_SIGNING_ALLOWED=NO build
