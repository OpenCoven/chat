import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  resolveExecutableInvocation,
  resolveUnixToolPath,
} from '../scripts/executable-resolution.mjs';

function writeExecutableScript(path: string) {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

test.skipIf(process.platform === 'win32')(
  'preserves POSIX multicall symlink invocation while verifying its target',
  () => {
    const root = mkdtempSync(resolve(tmpdir(), 'opencoven-executable-resolution-'));
    try {
      const target = realpathSync(process.execPath);
      const command = resolve(root, 'rustc');
      symlinkSync(target, command);
      const args = [
        '--input-type=module',
        '--eval',
        "import { basename } from 'node:path'; process.stdout.write(basename(process.argv0));",
      ];

      const invocation = resolveExecutableInvocation(
        'rustc',
        { PATH: root },
        process.platform,
        args,
      );

      expect(invocation.executable).toBe(command);
      expect(invocation.resolvedCommand).toBe(target);
      expect(
        execFileSync(invocation.executable, invocation.args, { encoding: 'utf8' }).trim(),
      ).toBe('rustc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.platform === 'win32')(
  'builds a minimal reviewed Unix tool path from resolved executables and excludes ambient PATH pollution',
  () => {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'opencoven-unix-tool-path-')));
    try {
      const nodeDirectory = resolve(root, 'node-bin');
      const pnpmDirectory = resolve(root, 'pnpm-bin');
      const rustupDirectory = resolve(root, 'rustup-bin');
      const pollutedDirectory = resolve(root, 'polluted-bin');
      const nonexistentDirectory = resolve(root, 'does-not-exist');
      mkdirSync(nodeDirectory);
      mkdirSync(pnpmDirectory);
      mkdirSync(rustupDirectory);
      mkdirSync(pollutedDirectory);
      writeExecutableScript(resolve(nodeDirectory, 'node'));
      writeExecutableScript(resolve(pnpmDirectory, 'pnpm'));
      writeExecutableScript(resolve(rustupDirectory, 'rustup'));
      writeExecutableScript(resolve(pollutedDirectory, 'unrelated-tool'));

      const environment = {
        PATH: [
          nonexistentDirectory,
          pollutedDirectory,
          nodeDirectory,
          pnpmDirectory,
          rustupDirectory,
          nodeDirectory,
        ].join(delimiter),
      };

      const toolPath = resolveUnixToolPath(['node', 'pnpm', 'rustup'], environment);

      expect(toolPath.split(':')).toEqual([
        nodeDirectory,
        pnpmDirectory,
        rustupDirectory,
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]);
      expect(toolPath).not.toContain(pollutedDirectory);
      expect(toolPath).not.toContain(nonexistentDirectory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'fails closed when a required Unix tool cannot be resolved from the environment',
  () => {
    const root = mkdtempSync(resolve(tmpdir(), 'opencoven-unix-tool-path-missing-'));
    try {
      const nodeDirectory = resolve(root, 'node-bin');
      mkdirSync(nodeDirectory);
      writeExecutableScript(resolve(nodeDirectory, 'node'));
      const environment = { PATH: nodeDirectory };

      expect(() => resolveUnixToolPath(['node', 'pnpm', 'rustup'], environment)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('refuses to build a Windows reviewed Unix tool path', () => {
  expect(() => resolveUnixToolPath(['node'], { PATH: '' }, 'win32')).toThrow();
});

test.skipIf(process.platform === 'win32')(
  'resolves the logical shim directory for a pnpm/action-setup-style symlinked entry, not its realpath target directory',
  () => {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'opencoven-unix-tool-path-shim-')));
    try {
      const binDirectory = resolve(root, '.bin');
      const targetDirectory = resolve(root, 'pnpm', 'bin');
      mkdirSync(binDirectory, { recursive: true });
      mkdirSync(targetDirectory, { recursive: true });
      const target = resolve(targetDirectory, 'pnpm.mjs');
      writeExecutableScript(target);
      const shim = resolve(binDirectory, 'pnpm');
      symlinkSync(target, shim);

      const environment = { PATH: binDirectory };

      const toolPath = resolveUnixToolPath(['pnpm'], environment);

      expect(toolPath.split(':')).toEqual([binDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
      // A bare `pnpm` entry (the shim itself) must remain discoverable in the
      // resolved directory; the realpath target directory only contains
      // `pnpm.mjs`, which a bare `pnpm` invocation would not find.
      expect(existsSync(resolve(binDirectory, 'pnpm'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
