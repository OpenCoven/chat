import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  buildIsolationEvidence,
  captureOperatorFilesystemState,
} from '../scripts/phase1-evidence-runtime.mjs';

const scratchRoots: string[] = [];

function scratchRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'phase1-evidence-runtime-'));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Phase 1 evidence runtime isolation', () => {
  test('publishes only stable digests when operator filesystem state is untouched', () => {
    const root = scratchRoot();
    const covenHome = resolve(root, '.coven');
    const caveHome = resolve(covenHome, 'cave');
    mkdirSync(caveHome, { recursive: true });
    writeFileSync(resolve(caveHome, 'projects.json'), '{"version":1}\n');
    const before = captureOperatorFilesystemState({ caveHome, covenHome });
    const after = captureOperatorFilesystemState({ caveHome, covenHome });

    const isolation = buildIsolationEvidence({
      operatorBefore: before,
      operatorAfter: after,
      nativeBeforeSha256: 'a'.repeat(64),
      nativeAfterSha256: 'a'.repeat(64),
      opaqueIds: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
    });

    expect(isolation.operatorState.map(({ id }) => id)).toEqual([
      'cave-home',
      'coven-home',
      'native-credential-store',
      'projects',
    ]);
    expect(JSON.stringify(isolation)).not.toContain(root);
  });

  test('fails when operator Cave, Coven, project, or native credential state changes', () => {
    const root = scratchRoot();
    const covenHome = resolve(root, '.coven');
    const caveHome = resolve(covenHome, 'cave');
    mkdirSync(caveHome, { recursive: true });
    writeFileSync(resolve(caveHome, 'projects.json'), '{"version":1}\n');
    const before = captureOperatorFilesystemState({ caveHome, covenHome });
    writeFileSync(resolve(caveHome, 'projects.json'), '{"version":2}\n');
    const after = captureOperatorFilesystemState({ caveHome, covenHome });

    expect(() =>
      buildIsolationEvidence({
        operatorBefore: before,
        operatorAfter: after,
        nativeBeforeSha256: 'a'.repeat(64),
        nativeAfterSha256: 'a'.repeat(64),
        opaqueIds: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
      }),
    ).toThrow(/operator state/iu);
    expect(() =>
      buildIsolationEvidence({
        operatorBefore: before,
        operatorAfter: before,
        nativeBeforeSha256: 'a'.repeat(64),
        nativeAfterSha256: 'b'.repeat(64),
        opaqueIds: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
      }),
    ).toThrow(/native credential state/iu);
  });

  test('rejects duplicate or non-opaque isolation identifiers', () => {
    const root = scratchRoot();
    const covenHome = resolve(root, '.coven');
    const caveHome = resolve(covenHome, 'cave');
    const state = captureOperatorFilesystemState({ caveHome, covenHome });

    expect(() =>
      buildIsolationEvidence({
        operatorBefore: state,
        operatorAfter: state,
        nativeBeforeSha256: 'a'.repeat(64),
        nativeAfterSha256: 'a'.repeat(64),
        opaqueIds: ['1'.repeat(32), '1'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
      }),
    ).toThrow(/opaque/u);
    expect(() =>
      buildIsolationEvidence({
        operatorBefore: state,
        operatorAfter: state,
        nativeBeforeSha256: 'a'.repeat(64),
        nativeAfterSha256: 'a'.repeat(64),
        opaqueIds: ['short', '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
      }),
    ).toThrow(/opaque/u);
  });

  test.skipIf(process.platform === 'win32')(
    'hashes operator symlink metadata without following the target',
    () => {
      const root = scratchRoot();
      const covenHome = resolve(root, '.coven');
      const caveHome = resolve(covenHome, 'cave');
      const outside = resolve(root, 'outside');
      mkdirSync(caveHome, { recursive: true });
      mkdirSync(outside);
      writeFileSync(resolve(outside, 'private.txt'), 'outside\n');
      symlinkSync(outside, resolve(covenHome, 'linked-home'));

      const before = captureOperatorFilesystemState({ caveHome, covenHome });
      writeFileSync(resolve(outside, 'private.txt'), 'changed outside\n');
      const after = captureOperatorFilesystemState({ caveHome, covenHome });

      expect(after).toEqual(before);
    },
  );
});
