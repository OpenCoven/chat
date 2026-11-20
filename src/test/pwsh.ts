import { spawnSync } from 'node:child_process';

// Tests that run PowerShell need `pwsh` on PATH. CI and Windows have it; a Mac or
// Linux machine usually does not, and there every such test failed with
// `spawnSync pwsh ENOENT` on every run, burying any real failure under 26 lines
// that were never about the change. A few refusal tests passed there only
// because the missing binary threw.
//
// `skipWithoutPwsh` skips them only on a machine that is neither CI nor Windows.
// Under CI, or on Windows, a missing `pwsh` stays a failure: the tests run and
// report ENOENT, so CI losing PowerShell cannot pass quietly.
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status ===
  0;

const pwshRequired = process.platform === 'win32' || Boolean(process.env.CI);

export const skipWithoutPwsh = !pwshAvailable && !pwshRequired;

export const pwshSkipReason = 'PowerShell (pwsh) is not on PATH; CI runs this test';

if (skipWithoutPwsh) {
  process.stderr.write(
    'PowerShell (pwsh) is not on PATH: skipping the tests that run it. CI runs them; install PowerShell to run them here.\n',
  );
}
