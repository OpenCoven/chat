#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$app_dir/../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/chat-companion-test.XXXXXX")"
fixture_pid=""
simulator=""
log_pid=""
cleanup() {
  rm -f "$app_dir/TestSupport/LocalPairing.json"
  if [[ -n "$log_pid" ]]; then kill "$log_pid" 2>/dev/null || true; wait "$log_pid" 2>/dev/null || true; fi
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
# On hosted macOS runners the first connection to the fixture's LAN address
# (a 192.168.64.x NAT interface there) has timed out after 12 s, while every
# later one answered within a second, whichever test made it (#414). Reach the
# fixture once from here, with a bound, before any simulator test does, and
# say how long that took so the next failure is explicable.
endpoint="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["endpoint"])' "$fixture_dir/receipt.json")"
warm_started="$(date +%s)"
answer=""
for _ in {1..12}; do
  code="$(curl --silent --output /dev/null --insecure --max-time 5 --write-out '%{http_code}' "$endpoint/v1/snapshot" || true)"
  if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then answer="$code"; break; fi
  sleep 1
done
if [[ -z "$answer" ]]; then
  echo "Companion fixture at $endpoint did not answer within $(( $(date +%s) - warm_started ))s." >&2
  /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate >&2 || true
  ifconfig >&2 || true
  exit 1
fi
echo "Companion fixture answered HTTP $answer at $endpoint after $(( $(date +%s) - warm_started ))s."
# The host reaches the fixture at once, but the simulator's own first connection
# to it has taken 5 to 17 s, and over the client's 12 s request timeout on the
# runs that failed (#414). xcodebuild would otherwise boot the simulator and
# start the first network test within seconds. Boot it here, wait until it is
# fully up, and open the fixture's address from inside it once so that first
# connection is spent before any test depends on it.
if [[ -n "$simulator" ]]; then
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
  warm_started="$(date +%s)"
  xcrun simctl openurl "$simulator" "$endpoint/v1/snapshot" || true
  sleep 8
  echo "Simulator $simulator booted and opened the fixture address; warm-up took $(( $(date +%s) - warm_started ))s."
fi
# CHAT_IOS_UI_FLOW=0 runs the native unit tests only. The pinned-HTTPS UI flow
# is still not deterministic on hosted runners (#414): its own first connection
# from the UI-launched app has stalled past the client's 12 s request timeout
# even after the warm-up above, so CI runs it on main, under the ci:full label
# and on request, not on every pull request. Unset means everything, as before.
selection=()
if [[ "${CHAT_IOS_UI_FLOW:-1}" == "0" ]]; then
  selection=(-only-testing:ChatCompanionTests)
elif [[ -n "$simulator" ]]; then
  # Keep the app's own network log so a failed pairing names its error code,
  # which the app's user-facing copy deliberately does not.
  xcrun simctl spawn "$simulator" log stream --style compact \
    --predicate 'process CONTAINS "ChatCompanion" OR subsystem == "com.apple.network"' \
    > "$fixture_dir/simulator.log" 2>/dev/null &
  log_pid=$!
fi
# Ad-hoc simulator signing supplies the application entitlement required by real
# Keychain tests. Do not substitute an insecure simulator credential store.
if ! xcodebuild -project ChatCompanion.xcodeproj -scheme ChatCompanion \
  -destination "$destination" -derivedDataPath "${CHAT_IOS_DERIVED_DATA:-$fixture_dir/DerivedData}" \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM=LOCALTEST0 \
  "${selection[@]}" test; then
  if [[ -s "$fixture_dir/simulator.log" ]]; then
    echo '--- simulator network log (errors) ---' >&2
    grep -E 'finished with error|NSURLError|boringssl|TLS|nw_connection|nw_endpoint' "$fixture_dir/simulator.log" | tail -60 >&2 || true
  fi
  exit 1
fi
xcodebuild -project ChatCompanion.xcodeproj -scheme ChatCompanion -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$fixture_dir/DeviceBuild" CODE_SIGNING_ALLOWED=NO build
