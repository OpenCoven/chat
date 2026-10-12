#!/usr/bin/env bash
# Archive the companion under the Soul Protocol LLC team and upload it to
# App Store Connect for TestFlight. Uses the same App Store Connect API key as
# the desktop release (docs/releasing.md): APPLE_API_KEY is the key ID and
# APPLE_API_ISSUER its issuer. The .p8 is read from APPLE_API_KEY_PATH, or from
# ~/.appstoreconnect/private_keys/AuthKey_<id>.p8 when unset.
#
# CHAT_IOS_EXPORT=export signs an .ipa without uploading it, to prove signing
# before the App Store Connect app record exists. CHAT_IOS_BUILD_NUMBER
# overrides the build number, which defaults to the commit count of HEAD so
# uploads from main always increase.
set -euo pipefail
: "${APPLE_API_KEY:?Set APPLE_API_KEY to the App Store Connect API key ID.}"
: "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER to the App Store Connect API issuer ID.}"
key_path="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}"
if [[ ! -s "$key_path" ]]; then echo "No API key at $key_path." >&2; exit 1; fi
destination="${CHAT_IOS_EXPORT:-upload}"
if [[ "$destination" != upload && "$destination" != export ]]; then
  echo 'CHAT_IOS_EXPORT must be upload or export.' >&2; exit 1
fi
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_number="${CHAT_IOS_BUILD_NUMBER:-$(git -C "$app_dir" rev-list --count HEAD)}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/chat-companion-testflight.XXXXXX")"
created_test_support=""
cleanup() {
  if [[ -n "$created_test_support" ]]; then rmdir "$app_dir/TestSupport" 2>/dev/null || true; fi
  if [[ "$destination" == upload ]]; then rm -rf "$work_dir"; fi
}
trap cleanup EXIT
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key_path"
  -authenticationKeyID "$APPLE_API_KEY" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
cd "$app_dir"
# The test targets list TestSupport as a source folder, which test-e2e.sh
# creates. XcodeGen refuses a missing folder even though archiving builds only
# the app target.
if [[ ! -d TestSupport ]]; then mkdir TestSupport; created_test_support=1; fi
xcodegen generate
xcodebuild archive -project ChatCompanion.xcodeproj -scheme ChatCompanion -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work_dir/ChatCompanion.xcarchive" \
  "${auth[@]}" CURRENT_PROJECT_VERSION="$build_number"
cat > "$work_dir/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>$destination</string>
<key>teamID</key><string>9LR8Z8UQ9X</string>
<key>signingStyle</key><string>automatic</string>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$work_dir/ChatCompanion.xcarchive" \
  -exportOptionsPlist "$work_dir/ExportOptions.plist" -exportPath "$work_dir/export" "${auth[@]}"
if [[ "$destination" == upload ]]; then
  echo "Uploaded build $build_number. It appears in TestFlight once App Store Connect finishes processing it."
else
  echo "Signed build $build_number, not uploaded: $work_dir/export"
fi
