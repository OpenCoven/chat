import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Whether a test file's PowerShell tests should skip: `pwsh` (or the given
 * shell) isn't installed and this isn't CI. CI always has PowerShell, so there
 * a missing one still fails the tests instead of hiding them. When they skip,
 * the reason is printed once for the file.
 */
export function skipWithoutPwsh(testFileUrl: string, shell = 'pwsh'): boolean {
  if (process.env.CI || process.platform === 'win32') return false;
  const available =
    spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 30_000,
    }).status === 0;
  if (!available) {
    process.stderr.write(
      `${basename(new URL(testFileUrl).pathname)}: PowerShell (${shell}) is not installed, so the ` +
        'tests that run PowerShell are skipped. CI runs them. Install PowerShell 7 to run them here.\n',
    );
  }
  return !available;
}
