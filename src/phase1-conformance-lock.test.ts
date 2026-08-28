import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  assertCleanGitCheckout,
  assertCleanPhase1Checkouts,
  assertPhase1CheckoutHeads,
  readPhase1ConformanceLock,
} from '../scripts/phase1-conformance-lock.mjs';

const scratchParent = resolve(process.cwd(), 'test-results', 'vitest', 'phase1-conformance-lock');
const scratchRoots: string[] = [];

function git(command: string[], cwd: string) {
  return execFileSync('git', command, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function makeScratchRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `phase1-lock-${name}-`));
  scratchRoots.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.name', 'Phase 1 lock test'], root);
  git(['config', 'user.email', 'phase1-lock-test@example.invalid'], root);
  writeFileSync(join(root, 'README.md'), 'scratch\n');
  git(['add', 'README.md'], root);
  git(['commit', '-q', '-m', 'scratch'], root);
  return root;
}

function lockFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    chat: {
      repository: 'OpenCoven/chat',
      revision: '73bec85903646773db8267171c7c3eb1e23a1d46',
    },
    sdk: {
      repository: 'OpenCoven/sdk',
      revision: '163961f4e59cfdef51d2271fa98e7c514977203f',
    },
    cave: {
      repository: 'OpenCoven/coven-cave',
      revision: '061ddca45ab00028ecc0335face6239e5553f24a',
    },
    coven: {
      repository: 'OpenCoven/coven',
      revision: '721437b84026c042e431b0882dcd14fdb29ac07d',
    },
    ...overrides,
  };
}

function writeLockFixture(name: string, fixture: unknown): string {
  mkdirSync(scratchParent, { recursive: true });
  const path = join(scratchParent, `${name}.lock.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('phase1 conformance lock', () => {
  test('pins immutable reviewed revisions for chat, sdk, cave, and coven', () => {
    const lock = readPhase1ConformanceLock();
    expect(lock.chat.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.sdk.repository).toBe('OpenCoven/sdk');
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.coven.repository).toBe('OpenCoven/coven');
    expect(lock.chat.repository).toBe('OpenCoven/chat');
  });

  test('rejects a non-40-character revision', () => {
    const path = writeLockFixture(
      'short-revision',
      lockFixture({ sdk: { repository: 'OpenCoven/sdk', revision: 'abc123' } }),
    );
    expect(() => readPhase1ConformanceLock(path)).toThrow(/immutable 40-character/);
  });

  test('rejects a wrong repository name', () => {
    const path = writeLockFixture(
      'wrong-repository',
      lockFixture({
        cave: {
          repository: 'OpenCoven/other',
          revision: '061ddca45ab00028ecc0335face6239e5553f24a',
        },
      }),
    );
    expect(() => readPhase1ConformanceLock(path)).toThrow(
      /cave\.repository must be OpenCoven\/coven-cave/,
    );
  });

  test('rejects a non-v1 lock version', () => {
    const path = writeLockFixture('bad-version', lockFixture({ version: 2 }));
    expect(() => readPhase1ConformanceLock(path)).toThrow(/version must be 1/);
  });
});

describe('phase1 conformance checkout verification', () => {
  test('accepts a clean exact checkout and reports the locked heads', () => {
    const root = makeScratchRepository('clean');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const lock = readPhase1ConformanceLock();
    const lockWithScratch = {
      ...lock,
      chat: { repository: lock.chat.repository, revision: head },
      sdk: { repository: lock.sdk.repository, revision: head },
      cave: { repository: lock.cave.repository, revision: head },
      coven: { repository: lock.coven.repository, revision: head },
    };

    expect(assertCleanGitCheckout(root, 'Scratch checkout')).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });

    const heads = assertPhase1CheckoutHeads(lockWithScratch, {
      chatRoot: root,
      sdkRoot: root,
      caveRoot: root,
      covenRoot: root,
    });
    expect(heads.sdk).toBe(head);
  });

  test('rejects a dirty checkout', () => {
    const root = makeScratchRepository('dirty');
    writeFileSync(join(root, 'untracked.txt'), 'drift\n');
    expect(() =>
      assertCleanPhase1Checkouts({
        chatRoot: root,
        sdkRoot: root,
        caveRoot: root,
        covenRoot: root,
      }),
    ).toThrow(/dirty/);
  });

  test('rejects a checkout head that moved off the locked revision', () => {
    const root = makeScratchRepository('moved');
    const originalHead = git(['rev-parse', 'HEAD'], root).trim();
    writeFileSync(join(root, 'README.md'), 'moved\n');
    git(['commit', '-q', '-am', 'move'], root);
    const lock = readPhase1ConformanceLock();
    const lockWithScratch = {
      ...lock,
      chat: { repository: lock.chat.repository, revision: originalHead },
      sdk: { repository: lock.sdk.repository, revision: originalHead },
      cave: { repository: lock.cave.repository, revision: originalHead },
      coven: { repository: lock.coven.repository, revision: originalHead },
    };
    expect(() =>
      assertPhase1CheckoutHeads(lockWithScratch, {
        chatRoot: root,
        sdkRoot: root,
        caveRoot: root,
        covenRoot: root,
      }),
    ).toThrow(/does not match locked reviewed revision/);
  });
});
