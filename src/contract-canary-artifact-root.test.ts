import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  prepareContractCanaryArtifactRoot,
  removeContractCanaryArtifactRoot,
  resolveContractCanaryArtifactRoot,
} from '../scripts/contract-canary.mjs';

const root = resolve(process.cwd());
const scratchRoot = resolve(root, '.artifacts', 'contract-canary-safety-spec');

function createRepository(name: string): string {
  const repositoryRoot = resolve(scratchRoot, name, 'repo');
  mkdirSync(repositoryRoot, { recursive: true });
  return repositoryRoot;
}

function createExternalDirectory(name: string): string {
  const externalRoot = resolve(scratchRoot, name, 'external');
  mkdirSync(externalRoot, { recursive: true });
  return externalRoot;
}

afterEach(() => {
  rmSync(scratchRoot, { force: true, recursive: true });
});

describe('contract canary artifact directory safety', () => {
  test.each(['.', '..', '../escape', '/Users/buns', '/'])(
    'rejects unsafe artifact name %s',
    (name) => {
      expect(() => resolveContractCanaryArtifactRoot(name)).toThrow(
        /safe child name|must stay inside/,
      );
    },
  );

  test('rejects a symlinked .artifacts base directory', () => {
    const repositoryRoot = createRepository('symlinked-artifacts');
    const externalRoot = createExternalDirectory('symlinked-artifacts');

    symlinkSync(externalRoot, resolve(repositoryRoot, '.artifacts'));

    expect(() => resolveContractCanaryArtifactRoot('local-run', { repositoryRoot })).toThrow(
      /must not be a symlink/,
    );
  });

  test('rejects a symlinked intermediate artifact directory', () => {
    const repositoryRoot = createRepository('symlinked-intermediate');
    const externalRoot = createExternalDirectory('symlinked-intermediate');

    mkdirSync(resolve(repositoryRoot, '.artifacts'));
    symlinkSync(externalRoot, resolve(repositoryRoot, '.artifacts', 'contract-canary'));

    expect(() => resolveContractCanaryArtifactRoot('local-run', { repositoryRoot })).toThrow(
      /must not be a symlink/,
    );
  });

  test('creates and accepts real artifact directories inside the repository root', () => {
    const repositoryRoot = createRepository('real-directories');
    const artifactRoot = prepareContractCanaryArtifactRoot('local-run', {
      repositoryRoot,
    });

    expect(artifactRoot).toBe(
      resolve(repositoryRoot, '.artifacts', 'contract-canary', 'local-run'),
    );
    expect(lstatSync(resolve(repositoryRoot, '.artifacts')).isDirectory()).toBe(true);
    expect(lstatSync(resolve(repositoryRoot, '.artifacts', 'contract-canary')).isDirectory()).toBe(
      true,
    );
    expect(lstatSync(artifactRoot).isDirectory()).toBe(true);
  });

  test('rejects cleanup paths that are the base directory, repository root, or an external path', () => {
    const repositoryRoot = createRepository('cleanup-guards');
    const artifactRoot = prepareContractCanaryArtifactRoot('local-run', { repositoryRoot });
    expect(artifactRoot).toContain('/local-run');

    expect(() =>
      removeContractCanaryArtifactRoot(resolve(repositoryRoot, '.artifacts', 'contract-canary'), {
        repositoryRoot,
      }),
    ).toThrow(/must stay inside/);
    expect(() => removeContractCanaryArtifactRoot(repositoryRoot, { repositoryRoot })).toThrow(
      /must stay inside/,
    );
    expect(() =>
      removeContractCanaryArtifactRoot(resolve(scratchRoot, 'outside'), { repositoryRoot }),
    ).toThrow(/must stay inside/);
  });

  test('replaces a symlinked artifact leaf without deleting the symlink target', () => {
    const repositoryRoot = createRepository('leaf-symlink-cleanup');
    const externalRoot = createExternalDirectory('leaf-symlink-cleanup');
    const artifactRoot = resolve(repositoryRoot, '.artifacts', 'contract-canary', 'local-run');

    mkdirSync(resolve(repositoryRoot, '.artifacts', 'contract-canary'), {
      recursive: true,
    });
    writeFileSync(resolve(externalRoot, 'outside.txt'), 'outside\n');
    symlinkSync(externalRoot, artifactRoot);

    const preparedArtifactRoot = prepareContractCanaryArtifactRoot('local-run', {
      repositoryRoot,
    });

    expect(preparedArtifactRoot).toBe(artifactRoot);
    expect(lstatSync(preparedArtifactRoot).isDirectory()).toBe(true);
    expect(existsSync(resolve(preparedArtifactRoot, 'outside.txt'))).toBe(false);
    expect(readFileSync(resolve(externalRoot, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  test('removes nested symlinks without following them during cleanup', () => {
    const repositoryRoot = createRepository('nested-symlink-cleanup');
    const externalRoot = createExternalDirectory('nested-symlink-cleanup');
    const artifactRoot = prepareContractCanaryArtifactRoot('local-run', {
      repositoryRoot,
    });

    mkdirSync(resolve(artifactRoot, 'nested'), { recursive: true });
    writeFileSync(resolve(artifactRoot, 'nested', 'local.txt'), 'local\n');
    writeFileSync(resolve(externalRoot, 'outside.txt'), 'outside\n');
    symlinkSync(externalRoot, resolve(artifactRoot, 'nested', 'escape'));

    removeContractCanaryArtifactRoot(artifactRoot, { repositoryRoot });

    expect(existsSync(artifactRoot)).toBe(false);
    expect(readFileSync(resolve(externalRoot, 'outside.txt'), 'utf8')).toBe('outside\n');
  });
});
