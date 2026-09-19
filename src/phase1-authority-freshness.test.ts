import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { checkAuthorityFreshness } from '../scripts/phase1-authority-freshness.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const has = (ref: string) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

// Fixed commits, never moving refs. Asserting that `HEAD` or `main` is clean
// would contradict the protocol this guard enforces: between a content merge
// and its repin the authority is expected to lag, so a branch that legitimately
// lags must not fail its own test.
const AFTER_PR_326 = 'f8b654b39baf0d2bfe2cb51b9920f960b70f0bd1';
const AFTER_PR_322 = '8a33e852e337d91bcd158ba7d93b5c8da2882234';

describe('phase 1 authority freshness', () => {
  test.skipIf(!has(AFTER_PR_326))('passes a main commit whose repin was made', () => {
    const result = checkAuthorityFreshness(AFTER_PR_326);
    expect(result.adrift.map((entry) => entry.path)).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.reachable).toBe(true);
  });

  // The guard exists because of this commit. #322 moved three governed files
  // and the lock test stayed green, since it verifies digests against the
  // authority's own immutable checkout rather than against what ships. The
  // drift then survived three further merges unnoticed.
  test.skipIf(!has(AFTER_PR_322))('reports the drift that went unnoticed after #322', () => {
    const result = checkAuthorityFreshness(AFTER_PR_322);
    expect(result.adrift.map((entry) => entry.path).sort()).toEqual([
      'src-tauri/Cargo.lock',
      'src-tauri/Cargo.toml',
      'src-tauri/src/keyring.rs',
    ]);
    expect(result.failures.join(' ')).toMatch(/a repin is due/u);
  });

  test.skipIf(!has(AFTER_PR_322))('reports a branch-tip pin as well as the drift', () => {
    // b5e0fac was a commit on a branch, not a merge commit on main, which is
    // what let two conformance branches write competing pins into one file.
    const result = checkAuthorityFreshness(AFTER_PR_322);
    expect(result.failures.join(' ')).toMatch(/must be pinned to a merge commit/u);
  });
});
