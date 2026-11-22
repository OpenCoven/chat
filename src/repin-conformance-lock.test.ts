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

const zeros = (length: number) => '0'.repeat(length);

function fixtureLiteral(paths: string[]) {
  const entries = paths
    .map(
      (path) =>
        `    {\n      path: '${path}',\n      blob: '${zeros(40)}',\n      sha256: '${zeros(64)}',\n    },\n`,
    )
    .join('');
  return (
    "import { expect, test } from 'vitest';\n\n" +
    `const expectedBehaviorAuthority = {\n  revision: '${zeros(40)}',\n  tree: '${zeros(40)}',\n` +
    `  files: [\n${entries}  ],\n} as const;\n\n` +
    "test('literal', () => expect(expectedBehaviorAuthority).toBeDefined());\n"
  );
}

// A throwaway repository shaped like a repin: `main` gains a merge, which
// origin/main points at, and the repin branch off it gains a local merge of its
// own, as `git pull --no-rebase` would make. HEAD is the repin branch.
function fixtureRepo(literal = fixtureLiteral(['governed-a.txt', 'governed-b.txt'])) {
  const repo = mkdtempSync(join(tmpdir(), 'repin-lock-repo-'));
  roots.push(repo);
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Repin Fixture',
        '-c',
        'user.email=repin-fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const commit = (path: string, text: string, message: string) => {
    writeFileSync(join(repo, path), text);
    run('add', '--all');
    run('commit', '-q', '-m', message);
  };
  const entry = (path: string) => ({ path, blob: zeros(40), sha256: zeros(64) });
  const lock = {
    harness: { repository: 'OpenCoven/chat', revision: zeros(40) },
    harnessAuthority: {
      revision: zeros(40),
      tree: zeros(40),
      files: [entry('governed-a.txt')],
      productionDeltas: [entry('governed-b.txt')],
    },
  };
  run('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, lockFile), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(repo, testFile), literal);
  writeFileSync(join(repo, 'governed-b.txt'), 'b\n');
  commit('governed-a.txt', 'a\n', 'base');

  run('checkout', '-q', '-b', 'content');
  commit('governed-a.txt', 'a, changed\n', 'content change');
  run('checkout', '-q', 'main');
  run('merge', '-q', '--no-ff', '--no-edit', 'content');
  const mainMerge = run('rev-parse', 'HEAD');
  run('update-ref', 'refs/remotes/origin/main', mainMerge);

  run('checkout', '-q', '-b', 'other');
  commit('unrelated.txt', 'other\n', 'other change');
  run('checkout', '-q', '-b', 'repin', mainMerge);
  commit('notes.txt', 'repin notes\n', 'repin notes');
  run('merge', '-q', '--no-ff', '--no-edit', 'other');
  const localMerge = run('rev-parse', 'HEAD');
  return { repo, run, mainMerge, localMerge };
}

function repinIn(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
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

// Each run starts the script, which starts about a hundred git processes; the
// default 5 s timeout is too tight on a busy machine.
describe('repin-conformance-lock', { timeout: 30_000 }, () => {
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

  test('pins a merge on origin/main by default', () => {
    const { repo, run, mainMerge } = fixtureRepo();
    const result = repinIn(repo, mainMerge);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const lock = JSON.parse(readFileSync(join(repo, lockFile), 'utf8'));
    expect(lock.harnessAuthority.revision).toBe(mainMerge);
    expect(lock.harnessAuthority.files[0].blob).toBe(
      run('rev-parse', `${mainMerge}:governed-a.txt`),
    );
    expect(readFileSync(join(repo, testFile), 'utf8')).toContain(`revision: '${mainMerge}'`);
  });

  test("refuses a local merge on the repin branch that isn't on origin/main", () => {
    const { repo, localMerge } = fixtureRepo();
    const before = readFileSync(join(repo, lockFile), 'utf8');
    const result = repinIn(repo, localMerge);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${localMerge} isn't on the first-parent history of origin/main; pin a merge commit on main`,
    );
    expect(readFileSync(join(repo, lockFile), 'utf8')).toBe(before);
  });

  test('asks for a fetch when origin/main is missing', () => {
    const { repo, run, mainMerge } = fixtureRepo();
    run('update-ref', '-d', 'refs/remotes/origin/main');
    const result = repinIn(repo, mainMerge);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("couldn't resolve origin/main");
    expect(result.stderr).toContain('git fetch origin');
  });

  test('finds the repository root when run from a subdirectory', () => {
    const { repo, mainMerge } = fixtureRepo();
    const result = repinIn(join(repo, 'src'), mainMerge);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, lockFile), 'utf8')).harness.revision).toBe(mainMerge);
  });

  test('refuses to run outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'repin-lock-outside-'));
    roots.push(outside);
    const result = repinIn(outside, zeros(40));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^repin-conformance-lock: \S+ isn't inside a git repository/u);
  });

  test("refuses a literal entry it can't rewrite", () => {
    const literal = fixtureLiteral(['governed-a.txt', 'governed-b.txt']).replace(
      `      blob: '${zeros(40)}',\n      sha256: '${zeros(64)}',\n    },\n  ],`,
      `      sha256: '${zeros(64)}',\n      blob: '${zeros(40)}',\n    },\n  ],`,
    );
    const { repo, mainMerge } = fixtureRepo(literal);
    const result = repinIn(repo, mainMerge);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${testFile}'s literal has 2 path entries, but only 1 of them have a blob and sha256 right after the path`,
    );
    expect(readFileSync(join(repo, testFile), 'utf8')).toBe(literal);
  });

  test('refuses to run without a commit', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'usage: node scripts/repin-conformance-lock.mjs <merge-commit>',
    );
  });
});
