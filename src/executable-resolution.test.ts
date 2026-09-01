import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { resolveExecutableInvocation } from '../scripts/executable-resolution.mjs';

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
