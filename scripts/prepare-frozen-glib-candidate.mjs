import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCleanPhase1Checkout,
  readPhase1CheckoutIdentity,
} from './phase1-conformance-lock.mjs';

const production = Object.freeze({
  revision: '841a88f8885bc20cac2f9d5b5b6bc2a23a76e657',
  tree: '81bbc67b3024c9c76444f7f4e84d79ac6fad1cc6',
});
const maintenance = Object.freeze({
  revision: '7ca56c5c8c95fc1be4efecf22554cb4f3cc08e22',
  tree: '372cbf9037d12de0f4d279b392293cedfb91b736',
});
const harness = 'c5445941750f5ac232a78f3d7c7dcecf91bd52bc';
const cargoPaths = ['src-tauri/Cargo.lock', 'src-tauri/Cargo.toml'];
const vendorPaths = [
  'vendor/glib-0.18.5',
  'vendor/glib-0.18.5.PROVENANCE.md',
  'vendor/glib-0.18.5.test-Cargo.lock',
];

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function regularFiles(root, path) {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  assert(!stat.isSymbolicLink(), 'Vendor source must not contain symlinks');
  if (stat.isDirectory()) {
    return readdirSync(absolute)
      .sort()
      .flatMap((entry) => regularFiles(root, `${path}/${entry}`));
  }
  assert(stat.isFile(), 'Vendor source must contain only regular files');
  return [path];
}

export function prepareFrozenGlibCandidate(candidatePath, maintenancePath) {
  const candidate = resolve(candidatePath);
  const maintained = resolve(maintenancePath);
  assert.notEqual(candidate, maintained, 'Source roots must differ');
  for (const [root, identity, label] of [
    [candidate, production, 'Frozen GLib candidate'],
    [maintained, maintenance, 'Frozen GLib maintained'],
  ]) {
    assertCleanPhase1Checkout(root, label);
    assert.deepEqual(
      readPhase1CheckoutIdentity(root, label),
      identity,
      `${label} identity mismatch`,
    );
  }
  const vendorFiles = vendorPaths.flatMap((path) => regularFiles(maintained, path)).sort();
  assert.equal(vendorFiles.length, 123, 'Unexpected reviewed vendor file set');
  assert.deepEqual(
    git(maintained, ['ls-tree', '-r', '--name-only', maintenance.revision, '--', ...vendorPaths])
      .trim()
      .split('\n')
      .sort(),
    vendorFiles,
    'Vendor file set must match reviewed source',
  );
  const patch = git(maintained, [
    'diff',
    '--no-ext-diff',
    '--binary',
    harness,
    maintenance.revision,
    '--',
    ...cargoPaths,
  ]);
  assert(patch.length > 0, 'Reviewed Cargo patch is missing');
  git(candidate, ['apply', '--check', '--index', '-'], patch);
  // Both source identities and all inputs are verified before the first mutation.
  git(candidate, ['apply', '--index', '-'], patch);
  for (const path of vendorPaths) {
    cpSync(join(maintained, path), join(candidate, path), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  for (const path of vendorFiles) {
    assert.deepEqual(
      readFileSync(join(candidate, path)),
      readFileSync(join(maintained, path)),
      'Copied vendor bytes differ',
    );
  }
  git(candidate, ['add', '--', ...vendorPaths]);
  assert.deepEqual(
    git(candidate, ['diff', '--name-only', 'HEAD']).trim().split('\n').sort(),
    [...cargoPaths, ...vendorFiles].sort(),
    'Candidate has an unexpected source delta',
  );
  assert.equal(
    git(candidate, ['diff', '--name-only']).trim(),
    '',
    'Candidate has unstaged changes',
  );
  assert.equal(
    git(candidate, ['ls-files', '--others', '--exclude-standard']).trim(),
    '',
    'Candidate has unexpected untracked files',
  );
  return Object.freeze({
    productionRevision: production.revision,
    maintenanceRevision: maintenance.revision,
    candidateTree: git(candidate, ['write-tree']).trim(),
    vendorFiles: vendorFiles.length - 2,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(
    process.argv.length,
    4,
    'Usage: node prepare-frozen-glib-candidate.mjs CANDIDATE MAINTAINED',
  );
  console.log(
    JSON.stringify(prepareFrozenGlibCandidate(process.argv[2], process.argv[3]), null, 2),
  );
}
