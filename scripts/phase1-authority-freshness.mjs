#!/usr/bin/env node
/**
 * Guards the three properties the conformance lock cannot check itself.
 *
 * `phase1-conformance.lock.json` records digests for the governed harness
 * files and production deltas, and the lock test verifies them against a
 * detached checkout of `harnessAuthority.revision`. That is self-consistent by
 * construction: the authority's tree is immutable, so the digests keep
 * matching it no matter how far the branch moves on. Nothing there notices
 * when the code that actually ships has left the authority behind.
 *
 * That is how #322 changed `keyring.rs`, `Cargo.toml` and `Cargo.lock` without
 * a repin and stayed green across three further merges.
 *
 * Run against a ref, default `HEAD`:
 *   node scripts/phase1-authority-freshness.mjs [ref]
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitEnvironment } from './phase1-conformance-lock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runGit(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    env: createGitEnvironment(),
    timeout: 30_000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * One tree listing per ref, rather than a `rev-parse` per file. The lock
 * governs 35 paths, so the naive form spawns seventy processes and takes
 * long enough to trip a test timeout.
 */
function blobsAt(git, ref) {
  const blobs = new Map();
  let listing;
  try {
    listing = git(['ls-tree', '-r', '-z', ref]);
  } catch {
    return blobs;
  }
  for (const record of listing.split('\0')) {
    if (record === '') {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const [, type, oid] = record.slice(0, tab).split(/\s+/u);
    if (type === 'blob') {
      blobs.set(record.slice(tab + 1), oid);
    }
  }
  return blobs;
}

export function checkAuthorityFreshness(ref = 'HEAD', repositoryRoot = projectRoot) {
  const git = (args) => runGit(repositoryRoot, args);
  ref = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  // Read the lock as it exists at `ref`, not from the working tree. Reading
  // from disk would compare today's pin against a historical tree, which
  // silently answers a different question than the one being asked.
  const lock = JSON.parse(git(['show', `${ref}:phase1-conformance.lock.json`]));
  const authority = lock.harnessAuthority;
  const revision = authority.revision;
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error('harnessAuthority.revision must be an immutable Git ID');
  }
  const failures = [];

  // Orphaned pin: a squash or rebase leaves the authority reachable only while
  // the source branch survives.
  let reachable = true;
  try {
    git(['merge-base', '--is-ancestor', revision, ref]);
  } catch {
    reachable = false;
    failures.push(`harnessAuthority.revision ${revision} is not an ancestor of ${ref}`);
  }

  // A branch-tip pin is what makes two conformance branches collide. Authority
  // belongs on a merge commit that is already part of the history.
  if (reachable) {
    if (!git(['rev-list', '--first-parent', ref]).split('\n').includes(revision)) {
      failures.push(
        'harnessAuthority.revision must be on the first-parent history of the checked ref',
      );
    }
    const parents = git(['rev-list', '--parents', '-n', '1', revision]).split(/\s+/u).slice(1);
    if (parents.length < 2) {
      failures.push(
        `harnessAuthority.revision ${revision} has ${parents.length} parent(s);` +
          ' authority must be pinned to a merge commit',
      );
    }
  }

  // The pin must describe what ships, or the executed harness and the shipped
  // tree have silently diverged.
  const adrift = [];
  if (reachable) {
    const pinnedBlobs = blobsAt(git, revision);
    const shippedBlobs = blobsAt(git, ref);
    const guard = 'scripts/phase1-authority-freshness.mjs';
    if (!pinnedBlobs.has(guard)) {
      failures.push('Pinned freshness guard is missing; a repin is due');
    }
    const groups = {
      files: [...authority.files, { path: guard }],
      productionDeltas: authority.productionDeltas,
    };
    for (const group of ['files', 'productionDeltas']) {
      for (const entry of groups[group] ?? []) {
        const pinned = pinnedBlobs.get(entry.path) ?? null;
        const shipped = shippedBlobs.get(entry.path) ?? null;
        if (pinned !== shipped) {
          adrift.push({ group, path: entry.path, pinned, shipped });
        }
      }
    }
  }
  if (adrift.length > 0) {
    failures.push(
      `${adrift.length} governed file(s) have moved since the authority was` +
        ' pinned; a repin is due',
    );
  }

  return { revision, ref, reachable, adrift, failures };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ref = process.argv[2] ?? 'HEAD';
  const result = checkAuthorityFreshness(ref, process.argv[3] ?? projectRoot);
  if (result.failures.length === 0) {
    process.stdout.write(
      `Phase 1 authority ${result.revision.slice(0, 8)} is current for ${ref}.\n`,
    );
    process.exit(0);
  }
  for (const failure of result.failures) {
    process.stderr.write(`${failure}\n`);
  }
  for (const entry of result.adrift) {
    process.stderr.write(`  ${entry.group}: ${entry.path}\n`);
  }
  process.exit(1);
}
