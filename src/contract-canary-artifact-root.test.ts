import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { parseArgs, readContractCanaryLock } from '../scripts/contract-canary.mjs';
import {
  cleanupOwnedTempRoot,
  createOwnedTempDirectory,
} from '../scripts/owned-temp-directory.mjs';

const createdTempDirectories: Array<ReturnType<typeof createOwnedTempDirectory>> = [];
const scratchRoots: string[] = [];

afterEach(() => {
  while (createdTempDirectories.length > 0) {
    const context = createdTempDirectories.pop();

    if (context === undefined) {
      continue;
    }

    try {
      cleanupOwnedTempRoot(context);
    } catch {
      rmSync(context.rootPath, { force: true, recursive: true });
    }
  }

  while (scratchRoots.length > 0) {
    const scratchRoot = scratchRoots.pop();

    if (scratchRoot !== undefined) {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  }
});

describe('contract canary temp directory safety', () => {
  test.each(['.', '..', '../escape', '/Users/buns', '/'])(
    'rejects unsafe temp child path segment %s',
    (name) => {
      expect(() =>
        createOwnedTempDirectory({
          prefix: 'opencoven-chat-contract-canary-test',
          childSegments: [name],
        }),
      ).toThrow(/safe child name/);
    },
  );

  test('creates mode-0700 temp directories under the real OS temp directory', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
      childSegments: ['harness'],
    });
    createdTempDirectories.push(artifactDirectory);

    expect(realpathSync(artifactDirectory.rootPath).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(artifactDirectory.path).toBe(resolve(artifactDirectory.rootPath, 'harness'));
    expect(lstatSync(artifactDirectory.rootPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(artifactDirectory.path).mode & 0o777).toBe(0o700);
  });

  test('rejects cleanup after the owned root identity changes', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
    });
    createdTempDirectories.push(artifactDirectory);

    rmSync(artifactDirectory.rootPath, { force: true, recursive: true });
    mkdirSync(artifactDirectory.rootPath, { recursive: true, mode: 0o700 });

    expect(() => cleanupOwnedTempRoot(artifactDirectory)).toThrow(/changed identity/);
  });

  test('removes nested symlinks without following them during cleanup', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
      childSegments: ['harness'],
    });
    const scratchRoot = mkdtempSync(resolve(tmpdir(), 'opencoven-chat-contract-canary-spec-'));
    const externalRoot = resolve(scratchRoot, 'external');

    createdTempDirectories.push(artifactDirectory);
    scratchRoots.push(scratchRoot);

    mkdirSync(externalRoot, { recursive: true });
    mkdirSync(resolve(artifactDirectory.path, 'nested'), { recursive: true });
    writeFileSync(resolve(artifactDirectory.path, 'nested', 'local.txt'), 'local\n');
    writeFileSync(resolve(externalRoot, 'outside.txt'), 'outside\n');
    symlinkSync(externalRoot, resolve(artifactDirectory.path, 'nested', 'escape'));

    cleanupOwnedTempRoot(artifactDirectory);
    createdTempDirectories.pop();

    expect(() => lstatSync(artifactDirectory.rootPath)).toThrow();
    expect(readFileSync(resolve(externalRoot, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  test('reads the tracked reviewed lock and rejects the removed artifact option', () => {
    const lock = readContractCanaryLock();

    expect(lock.sdk.repository).toBe('OpenCoven/sdk');
    expect(lock.sdk.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.cave.revision).toBe('2fe0abd05c88329c6b93660b986f40605c939ae1');
    expect(() => parseArgs(['--artifact-name', 'local-run'])).toThrow(/Unknown argument/);
  });
});
