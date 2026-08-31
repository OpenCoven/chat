#!/bin/bash
set -euo pipefail

export HOMEBREW_BOTTLE_DOMAIN='https://ghcr.io/v2/homebrew/core'
export HOMEBREW_NO_AUTO_UPDATE='1'
export HOMEBREW_NO_INSTALL_FROM_API='1'

core_revision="cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57"
formula="${RUNNER_TEMP}/mingw-w64.rb"
bottle="${RUNNER_TEMP}/mingw-w64--14.0.0_3.arm64_tahoe.bottle.tar.gz"

rustup target add x86_64-pc-windows-gnu
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://raw.githubusercontent.com/Homebrew/homebrew-core/${core_revision}/Formula/m/mingw-w64.rb" \
  -o "${formula}"
test "$(shasum -a 256 "${formula}" | awk '{print $1}')" = \
  "798631311a841e0639469f3f95a5287c8747f7a354e79a47ac39d6bf20eefe34"
grep -F 'revision 3' "${formula}"
grep -F \
  'sha256 arm64_tahoe:   "c4f826c665c0fb37a3dedc80affa6203a0d64891b788c8f7ab65b46862fd490c"' \
  "${formula}"

brew uninstall --force mingw-w64 >/dev/null 2>&1 || true
if brew list --versions mingw-w64 | grep -q .; then
  echo "existing mingw-w64 installation was not removed" >&2
  exit 1
fi

token="$(
  curl --proto '=https' --tlsv1.2 -fsSL \
    'https://ghcr.io/token?scope=repository:homebrew/core/mingw-w64:pull' |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
)"
test -n "${token}"
curl --proto '=https' --tlsv1.2 -fsSL \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  'https://ghcr.io/v2/homebrew/core/mingw-w64/manifests/14.0.0_3' |
  python3 -c 'import json,sys; d=json.load(sys.stdin); matches=[m for m in d["manifests"] if m.get("annotations",{}).get("org.opencontainers.image.ref.name")=="14.0.0_3.arm64_tahoe"]; assert len(matches)==1; assert matches[0]["annotations"]["sh.brew.bottle.digest"]=="0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5"'

curl --proto '=https' --tlsv1.2 -fsSL \
  -H "Authorization: Bearer ${token}" \
  'https://ghcr.io/v2/homebrew/core/mingw-w64/blobs/sha256:0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5' \
  -o "${bottle}"
test "$(shasum -a 256 "${bottle}" | awk '{print $1}')" = \
  "0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5"
test "$(wc -c < "${bottle}" | tr -d ' ')" = "356178908"
HOMEBREW_DEVELOPER=1 brew install --force-bottle "${bottle}"
test "$(brew list --versions mingw-w64)" = "mingw-w64 14.0.0_3"
x86_64-w64-mingw32-ld --version | head -n 1 | grep -F '2.47.20260726'

node --input-type=module <<'EOF'
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { readPhase1ConformanceLock } from './scripts/phase1-conformance-lock.mjs';

const source = readPhase1ConformanceLock().tools.windowsSupervisor.source;
const inputs = [
  [source.path, source.sha256],
  ['tools/phase1-process-supervisor/Cargo.toml', source.manifestSha256],
  ['tools/phase1-process-supervisor/Cargo.lock', source.lockSha256],
  ['tools/phase1-process-supervisor/.cargo/config.toml', source.configSha256],
];
for (const [path, expectedSha256] of inputs) {
  const stats = lstatSync(path);
  const currentBytes = readFileSync(path);
  const lockedBytes = execFileSync('git', ['show', `${source.revision}:${path}`]);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    createHash('sha256').update(currentBytes).digest('hex') !== expectedSha256 ||
    createHash('sha256').update(lockedBytes).digest('hex') !== expectedSha256
  ) {
    throw new Error('Windows supervisor build input does not match the immutable lock.');
  }
}
const blob = execFileSync('git', ['rev-parse', `${source.revision}:${source.path}`], {
  encoding: 'utf8',
}).trim();
if (blob !== source.blob) {
  throw new Error('Windows supervisor source blob does not match the immutable lock.');
}
EOF

(
  cd tools/phase1-process-supervisor
  SOURCE_DATE_EPOCH=0 cargo build \
    --target x86_64-pc-windows-gnu \
    --release \
    --locked
)

node --input-type=module <<'EOF'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { readPhase1ConformanceLock } from './scripts/phase1-conformance-lock.mjs';

const supervisor = readPhase1ConformanceLock().tools.windowsSupervisor;
const path =
  `tools/phase1-process-supervisor/target/${supervisor.artifact.target}/release/` +
  supervisor.artifact.fileName;
const stats = lstatSync(path);
const bytes = readFileSync(path);
if (
  !stats.isFile() ||
  stats.isSymbolicLink() ||
  stats.size !== supervisor.artifact.size ||
  createHash('sha256').update(bytes).digest('hex') !== supervisor.artifact.sha256
) {
  throw new Error('Windows supervisor artifact does not match the immutable lock.');
}
EOF
