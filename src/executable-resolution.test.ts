import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { resolveExecutableInvocation } from '../scripts/executable-resolution.mjs';

test.skipIf(process.platform === 'win32')(
  'preserves POSIX multicall symlink invocation while verifying its target',
  () => {
    const root = mkdtempSync(resolve(tmpdir(), 'opencoven-executable-resolution-'));
    try {
      const target = resolve(root, 'multicall');
      const command = resolve(root, 'rustc');
      writeFileSync(target, '#!/bin/sh\nbasename "$0"\n');
      chmodSync(target, 0o700);
      symlinkSync(target, command);

      const invocation = resolveExecutableInvocation('rustc', { PATH: root });

      expect(invocation.executable).toBe(command);
      expect(invocation.resolvedCommand).toBe(realpathSync(target));
      expect(
        execFileSync(invocation.executable, invocation.args, { encoding: 'utf8' }).trim(),
      ).toBe('rustc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
