import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareFrozenGlibCandidate } from './prepare-frozen-glib-candidate.mjs';

const repository = resolve(import.meta.dirname, '..');
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'chat188-reconstruction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate');
  const maintained = join(root, 'maintained');
  for (const [path, revision] of [
    [candidate, '841a88f8885bc20cac2f9d5b5b6bc2a23a76e657'],
    [maintained, '7ca56c5c8c95fc1be4efecf22554cb4f3cc08e22'],
  ]) {
    execFileSync('git', ['clone', '--shared', '--no-checkout', repository, path], {
      stdio: 'pipe',
    });
    git(path, 'checkout', '--detach', revision);
  }
  return { candidate, maintained };
}

test('reconstructs the exact narrow candidate and preserves its production version', (t) => {
  const { candidate, maintained } = fixture(t);
  const receipt = prepareFrozenGlibCandidate(candidate, maintained);
  assert.equal(receipt.vendorFiles, 121);
  assert.equal(receipt.candidateTree, git(candidate, 'write-tree'));
  assert.match(git(candidate, 'show', ':src-tauri/Cargo.toml'), /version = "0\.1\.0"/);
  const changed = git(candidate, 'diff', '--name-only', 'HEAD').split('\n');
  assert.equal(changed.length, 125);
  assert.deepEqual(
    changed.filter((path) => !path.startsWith('vendor/')),
    ['src-tauri/Cargo.lock', 'src-tauri/Cargo.toml'],
  );
});

test('rejects a substituted production revision before mutation', (t) => {
  const { candidate, maintained } = fixture(t);
  git(candidate, 'checkout', '--detach', 'c5445941750f5ac232a78f3d7c7dcecf91bd52bc');
  assert.throws(() => prepareFrozenGlibCandidate(candidate, maintained), /identity/);
  assert.equal(git(candidate, 'status', '--porcelain'), '');
});

test('rejects modified vendor input before changing candidate', (t) => {
  const { candidate, maintained } = fixture(t);
  appendFileSync(join(maintained, 'vendor/glib-0.18.5/src/variant_iter.rs'), '\n// mutation\n');
  assert.throws(() => prepareFrozenGlibCandidate(candidate, maintained));
  assert.equal(git(candidate, 'status', '--porcelain'), '');
});

test('rejects unexpected candidate source changes', (t) => {
  const { candidate, maintained } = fixture(t);
  writeFileSync(join(candidate, 'unexpected-input'), 'extra');
  assert.throws(() => prepareFrozenGlibCandidate(candidate, maintained));
  assert.equal(git(candidate, 'diff', '--cached', '--name-only'), '');
});

test('rejects a symlink replacing reviewed vendor source', (t) => {
  const { candidate, maintained } = fixture(t);
  const file = join(maintained, 'vendor/glib-0.18.5/src/variant_iter.rs');
  rmSync(file);
  symlinkSync('/etc/hosts', file);
  assert.throws(() => prepareFrozenGlibCandidate(candidate, maintained));
  assert.equal(git(candidate, 'status', '--porcelain'), '');
});
