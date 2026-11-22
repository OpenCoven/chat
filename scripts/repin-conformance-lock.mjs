#!/usr/bin/env node
// The mechanical half of a conformance repin (docs/phase1-conformance.md,
// "The repin PR"): point the lock at a content PR's merge commit and recompute
// every digest from that commit.
//
//   node scripts/repin-conformance-lock.mjs <merge-commit> [--ref <ref>] [--repo <dir>] [--files-root <dir>]
//
// It rewrites, in <files-root> (default: the repository):
//   - phase1-conformance.lock.json: harness.revision, harnessAuthority.revision
//     and .tree, and the blob and sha256 of every harnessAuthority.files and
//     harnessAuthority.productionDeltas entry;
//   - src/phase1-conformance-lock.test.ts: the revision, tree and file digests
//     in its literal copy, `expectedBehaviorAuthority`.
// It refuses a commit that isn't a merge commit on the first-parent history of
// <ref> (default origin/main, so fetch first), the same rule
// scripts/phase1-authority-freshness.mjs enforces on main. A local merge on the
// repin branch, after a `git pull --no-rebase` say, is refused: only a merge
// that main already has can stay current once the repin lands. <dir> defaults
// to the repository holding the working directory. The working tree may be
// dirty; uncommitted edits to other files are kept. The prose record in
// docs/phase1-conformance.md is left to you.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const lockFile = 'phase1-conformance.lock.json';
const testFile = 'src/phase1-conformance-lock.test.ts';

function fail(message) {
  console.error(`repin-conformance-lock: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { ref: 'origin/main', repo: undefined, filesRoot: undefined, commit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ref' || argument === '--repo' || argument === '--files-root') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${argument} needs a value`);
      index += 1;
      if (argument === '--ref') options.ref = value;
      else if (argument === '--repo') options.repo = value;
      else options.filesRoot = value;
    } else if (argument.startsWith('-')) {
      fail(`unknown option ${argument}`);
    } else if (options.commit === undefined) {
      options.commit = argument;
    } else {
      fail(`unexpected argument ${argument}`);
    }
  }
  if (options.commit === undefined) {
    fail(
      'usage: node scripts/repin-conformance-lock.mjs <merge-commit> [--ref <ref>] [--repo <dir>] [--files-root <dir>]',
    );
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const startDirectory = resolve(options.repo ?? process.cwd());
try {
  options.repo = execFileSync('git', ['-C', startDirectory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  fail(`${startDirectory} isn't inside a git repository; run this from the chat checkout`);
}
const git = (args, encoding = 'utf8') =>
  execFileSync('git', ['-C', options.repo, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const gitText = (args) => git(args).trim();

const resolveCommit = (name, hint = '') => {
  try {
    return gitText(['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`]);
  } catch {
    fail(`couldn't resolve ${name} to a commit in ${options.repo}${hint}`);
  }
};
const commit = resolveCommit(options.commit, '; run `git fetch origin` if it merged recently');
const ref = resolveCommit(options.ref, '; run `git fetch origin` first');

const parents = gitText(['rev-list', '--parents', '-n', '1', commit]).split(/\s+/u).slice(1);
if (parents.length < 2) {
  fail(`${commit} has ${parents.length} parent(s); the authority must be a merge commit`);
}
if (!gitText(['rev-list', '--first-parent', ref]).split('\n').includes(commit)) {
  fail(
    `${commit} isn't on the first-parent history of ${options.ref}; pin a merge commit on main, ` +
      'and run `git fetch origin` if it merged recently',
  );
}

function digestAt(path) {
  let blob;
  try {
    blob = gitText(['rev-parse', '--verify', '--end-of-options', `${commit}:${path}`]);
  } catch {
    fail(`${path} doesn't exist at ${commit}`);
  }
  const bytes = git(['cat-file', 'blob', blob], 'buffer');
  return { blob, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const filesRoot = resolve(options.filesRoot ?? options.repo);
const lockPath = join(filesRoot, lockFile);
const testPath = join(filesRoot, testFile);
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`couldn't read ${path} (${error.code ?? error.message})`);
  }
};
const lockText = readText(lockPath);
const lock = JSON.parse(lockText);
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
if (serialize(lock) !== lockText) {
  fail(`${lockFile} isn't in the expected JSON layout (two-space indent, final newline)`);
}

const tree = gitText(['rev-parse', '--verify', `${commit}^{tree}`]);
const changes = [];
const note = (what, before, after) => {
  if (before !== after) changes.push(`${what}: ${before} -> ${after}`);
};

note('harness.revision', lock.harness.revision, commit);
note('harnessAuthority.revision', lock.harnessAuthority.revision, commit);
note('harnessAuthority.tree', lock.harnessAuthority.tree, tree);
lock.harness.revision = commit;
lock.harnessAuthority.revision = commit;
lock.harnessAuthority.tree = tree;
for (const list of ['files', 'productionDeltas']) {
  for (const entry of lock.harnessAuthority[list]) {
    const digest = digestAt(entry.path);
    note(`${list} ${entry.path} blob`, entry.blob, digest.blob);
    entry.blob = digest.blob;
    entry.sha256 = digest.sha256;
  }
}

// The test keeps a literal copy of the authority. Rewrite only its values,
// inside its own block, so the file's layout and everything else stay as they are.
const testText = readText(testPath);
const blockStart = testText.indexOf('const expectedBehaviorAuthority = {');
const blockEnd = blockStart === -1 ? -1 : testText.indexOf('\n} as const;\n', blockStart);
if (blockStart === -1 || blockEnd === -1) {
  fail(`couldn't find the expectedBehaviorAuthority literal in ${testFile}`);
}
let block = testText.slice(blockStart, blockEnd);
const replaceOnce = (pattern, replacement, what) => {
  const matches = block.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (matches?.length !== 1)
    fail(`expected one ${what} in ${testFile}'s literal, found ${matches?.length ?? 0}`);
  block = block.replace(pattern, replacement);
};
replaceOnce(/^ {2}revision: '[0-9a-f]{40}',$/mu, `  revision: '${commit}',`, 'revision');
replaceOnce(/^ {2}tree: '[0-9a-f]{40}',$/mu, `  tree: '${tree}',`, 'tree');
// Every entry must be rewritten. One whose layout the pattern misses would
// otherwise keep its stale digests, and only the lock test would notice.
const literalPaths = block.match(/path: '/gu)?.length ?? 0;
let rewritten = 0;
block = block.replace(
  /path: '([^']+)',(\s+)blob: '[0-9a-f]{40}',(\s+)sha256: '[0-9a-f]{64}'/gu,
  (_match, path, beforeBlob, beforeSha) => {
    rewritten += 1;
    const digest = digestAt(path);
    return `path: '${path}',${beforeBlob}blob: '${digest.blob}',${beforeSha}sha256: '${digest.sha256}'`;
  },
);
if (rewritten !== literalPaths) {
  fail(
    `${testFile}'s literal has ${literalPaths} path entries, but only ${rewritten} of them have ` +
      'a blob and sha256 right after the path; restore that layout and run this again',
  );
}
const nextTestText = testText.slice(0, blockStart) + block + testText.slice(blockEnd);

writeFileSync(lockPath, serialize(lock));
writeFileSync(testPath, nextTestText);

console.log(`Pinned the conformance lock to ${commit} (tree ${tree}).`);
for (const change of changes) console.log(`  ${change}`);
if (nextTestText !== testText) console.log(`  updated the literal copy in ${testFile}`);
console.log(
  'Next: record the repin in docs/phase1-conformance.md, and after it merges check main with ' +
    '`node scripts/phase1-authority-freshness.mjs HEAD "$PWD"`.',
);
