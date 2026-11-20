import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(projectRoot, 'scripts', 'repin-conformance-lock.mjs');
const lockFile = 'phase1-conformance.lock.json';
const testFile = 'src/phase1-conformance-lock.test.ts';

// #657 repinned the lock to #646's merge. Its commit is the expected result,
// and its parent, that merge, holds the files it started from.
const repin657 = 'dc02ca06a8cc2a7905b81b61cc218a73ddc29e58';
const merge646 = 'fecb22bbe68c1ee5b3f65f8e91c683a78e3ebeaa';
// #646's branch after main was merged into it: a merge commit, but not on main's first-parent line.
const branchMerge646 = '378d2d9a3e29b8a2928d4cb4ea84a1e1b0f56367';
// The first merge on main (#1), from before most governed files existed.
const firstMerge = '8d7b021d5382001cc79b0c4db847c16b36e9d5ea';

const git = (...args: string[]) =>
  execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' });

let roots: string[] = [];

function filesAt(commit: string) {
  const root = mkdtempSync(join(tmpdir(), 'repin-lock-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, lockFile), git('show', `${commit}:${lockFile}`));
  writeFileSync(join(root, testFile), git('show', `${commit}:${testFile}`));
  return root;
}

function repin(commit: string, ref: string, filesRoot: string) {
  return spawnSync(
    process.execPath,
    [script, commit, '--ref', ref, '--repo', projectRoot, '--files-root', filesRoot],
    { encoding: 'utf8' },
  );
}

beforeAll(() => {
  for (const commit of [repin657, merge646, branchMerge646, firstMerge]) {
    const found = spawnSync('git', ['-C', projectRoot, 'cat-file', '-e', `${commit}^{commit}`]);
    if (found.status !== 0) {
      throw new Error(
        `These tests need the full history (commit ${commit} is missing). Fetch it, or clone without --depth.`,
      );
    }
  }
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('repin-conformance-lock', () => {
  test("reproduces #657's lock and test changes byte for byte", () => {
    const root = filesAt(merge646);
    const result = repin(merge646, repin657, root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, lockFile), 'utf8')).toBe(git('show', `${repin657}:${lockFile}`));
    expect(readFileSync(join(root, testFile), 'utf8')).toBe(git('show', `${repin657}:${testFile}`));
    expect(result.stdout).toContain(`Pinned the conformance lock to ${merge646}`);
    expect(result.stdout).toContain('productionDeltas src-tauri/Cargo.toml blob:');
    expect(result.stdout).toContain('productionDeltas src-tauri/Cargo.lock blob:');
  });

  test('changes nothing when the lock is already pinned to that commit', () => {
    const root = filesAt(repin657);
    const result = repin(merge646, repin657, root);
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, lockFile), 'utf8')).toBe(git('show', `${repin657}:${lockFile}`));
    expect(readFileSync(join(root, testFile), 'utf8')).toBe(git('show', `${repin657}:${testFile}`));
    expect(result.stdout).not.toContain('->');
    expect(result.stdout).not.toContain('updated the literal copy');
  });

  test('refuses a commit that is not a merge', () => {
    const root = filesAt(merge646);
    const result = repin(repin657, repin657, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has 1 parent(s); the authority must be a merge commit');
    expect(readFileSync(join(root, lockFile), 'utf8')).toBe(git('show', `${merge646}:${lockFile}`));
  });

  test("refuses a merge commit that isn't on the ref's first-parent history", () => {
    const root = filesAt(merge646);
    const result = repin(branchMerge646, repin657, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${branchMerge646} isn't on the first-parent history of ${repin657}`,
    );
  });

  test('refuses a commit that lacks a governed file', () => {
    const root = filesAt(merge646);
    const result = repin(firstMerge, repin657, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/repin-conformance-lock: \S+ doesn't exist at 8d7b021d/u);
    expect(readFileSync(join(root, lockFile), 'utf8')).toBe(git('show', `${merge646}:${lockFile}`));
  });

  test('refuses to run without a commit', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'usage: node scripts/repin-conformance-lock.mjs <merge-commit>',
    );
  });
});
