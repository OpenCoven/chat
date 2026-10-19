import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// PowerShell starts slowly inside a busy parallel run, so a test that drives it
// allows as long as the process it starts (30 s), not vitest's 5 s default.
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

test.skipIf(!pwshAvailable)(
  'confirms retained-handle exit without accepting unconfirmed termination errors',
  () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/windows-process-termination-race.test.ps1'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Retained-handle termination classification passed.');
    expect(result.stdout).toContain('Retained-handle failure diagnostic matrix passed.');
  },
  30_000,
);
