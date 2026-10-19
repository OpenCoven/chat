import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// PowerShell starts slowly inside a busy parallel run, so a test that drives it
// allows as long as the process it starts (30 s), not vitest's 5 s default.
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

test.skipIf(!pwshAvailable)(
  'shares one byte budget across artifact and application roots',
  () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/windows-shared-quota-budget.test.ps1'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Shared quota budget tests passed.');
  },
  30_000,
);
