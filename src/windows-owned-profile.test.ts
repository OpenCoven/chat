import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync('scripts/windows-job-supervisor.cs', 'utf8');
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

test('native suite characterizes profile deletion before running producer supervision', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  expect(workflow).toContain(
    'run: pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-job-supervisor.test.ps1',
  );
  const suite = readFileSync('scripts/windows-job-supervisor.test.ps1', 'utf8');
  const characterization = suite.indexOf(
    "& (Join-Path $PSScriptRoot 'windows-profile-cleanup-characterization.test.ps1')",
  );
  expect(characterization).toBeGreaterThan(-1);
  expect(characterization).toBeLessThan(suite.indexOf('$createProcessWithLogon ='));
});

test('residual cleanup runs in a separately bounded native CI job', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = workflow.match(
    /\n {2}windows-profile-residual:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/u,
  )?.groups?.job;
  expect(job).toBeDefined();
  expect(job).toContain('runs-on: windows-2025');
  expect(job).toContain('timeout-minutes: 15');
  expect(job).toContain('needs: changes');
  expect(job).toContain("needs.changes.outputs.docs_only != 'true'");
  expect(job).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(job).toContain("contains(github.event.pull_request.labels.*.name, 'ci:full')");
  expect(job).toContain(
    'pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-profile-residual-policy.test.ps1',
  );
  expect(job).toContain(
    'pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-profile-residual-native.test.ps1',
  );
  expect(job).not.toContain('-CompileOnly');
  expect(job).not.toContain('continue-on-error:');
});

test.skipIf(!pwshAvailable).each([
  {
    name: 'classifies native lifecycle failures without private child output',
    args: ['scripts/windows-profile-lifecycle.test.ps1', '-PortableOnly'],
    output: 'Portable profile lifecycle classification passed.',
  },
  {
    name: 'executes portable production residual policy',
    args: ['scripts/windows-profile-residual-policy.test.ps1'],
    output: 'Portable production residual policy passed:',
  },
  {
    name: 'compiles native residual regressions without native side effects',
    args: ['scripts/windows-profile-residual-native.test.ps1', '-CompileOnly'],
    output: 'Native residual fixture compiled; Windows behavior was not executed.',
  },
  {
    name: 'executes native fixture portable guards',
    args: ['scripts/windows-profile-residual-native.test.ps1', '-PortableOnly'],
    output: 'Portable residual failure classification passed.',
  },
])(
  '$name',
  ({ args, output }) => {
    const result = spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', ...args],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
  },
  30_000,
);

test.skipIf(!pwshAvailable)(
  'profile cleanup characterization compiles without native operations',
  () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'scripts/windows-profile-cleanup-characterization.test.ps1',
        '-CompileOnly',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Profile cleanup characterization compiled; no native operations executed.',
    );
    expect(result.stdout).not.toContain('profile-cleanup-characterization:');
  },
  30_000,
);

test.skipIf(!pwshAvailable)(
  'profile failure fixture reaches its callback through reflection',
  () => {
    const fixture = readFileSync('scripts/windows-profile-lifecycle.test.ps1', 'utf8');
    const root = fixture.match(/^\$failureRoot = .+$/mu)?.[0];
    const invocation = fixture.match(/^ {2}\$unexpectedUser = \$createCore\.Invoke\(.+$/mu)?.[0];
    expect(root).toBeDefined();
    expect(invocation).toBeDefined();
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
Add-Type 'public static class ProfileArgumentProbe { public static void Run(string root, System.Action<string,string> callback) { callback("sid", root); } }'
${root}
$createCore = [ProfileArgumentProbe].GetMethod('Run')
$owned = @{ Path = $null }
$failAfterCreation = [Action[string,string]] { param($sid, $path); $owned.Path = $path; throw 'injected-profile-initialization-failure' }
$observed = $false
try {
${invocation}
} catch {
  if ($_.Exception.GetBaseException().Message -ceq 'injected-profile-initialization-failure') { $observed = $true }
}
if (-not $observed -or $owned.Path -cne $failureRoot) { throw 'Reflection did not reach the failure callback.' }
`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);

function factorySource(startMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf('internal void ThrowIfDisposed()', start);
  expect(start, 'factory start delimiter').toBeGreaterThanOrEqual(0);
  expect(end, 'factory end delimiter').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('production Windows profile ownership boundary', () => {
  test('records actual profile ownership before verification and never predicts the profile path', () => {
    const factory = factorySource('public static WindowsIsolatedUser Create(');
    expect(factory).not.toContain('Path.Combine(GetProfilesRoot(), userName)');
    expect(factory).toContain('return CreateCore(rootPath, null);');
    const owned = factory.indexOf('ownedProfilePath = profileBuffer.ToString();');
    const injected = factory.indexOf('afterProfileCreated(sid, ownedProfilePath);');
    const verified = factory.indexOf(
      'VerifyCreatedProfile(ownedProfilePath, validatedQuotaToken);',
    );
    expect(owned).toBeGreaterThan(-1);
    expect(injected).toBeGreaterThan(owned);
    expect(verified).toBeGreaterThan(injected);
  });

  test('deletes only a successfully created profile before removing its fresh account on failure', () => {
    const factory = factorySource('private static WindowsIsolatedUser CreateCore(');
    const cleanup = factory.slice(factory.indexOf('catch (Exception original)'));
    expect(cleanup).toContain('if (ownedProfilePath != null)');
    expect(cleanup.indexOf('DeleteOperatingSystemProfile(sid, ownedProfilePath)')).toBeGreaterThan(
      -1,
    );
    expect(cleanup.indexOf('DeleteOperatingSystemProfile(sid, ownedProfilePath)')).toBeLessThan(
      cleanup.indexOf('NetUserDel(null, userName)'),
    );
    expect(factory).toContain('if (profileResult != 0)');
    expect(factory.indexOf('if (profileResult != 0)')).toBeLessThan(
      factory.indexOf('ownedProfilePath = profileBuffer.ToString();'),
    );
  });
});

// This fixture reaches the real Dispose guard without provisioning native resources.
test.skipIf(!pwshAvailable)(
  'incomplete quarantine retains the identity across cleanup retries',
  () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'scripts/windows-identity-cleanup-diagnostics.test.ps1',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Bounded identity cleanup Dispose diagnostics passed.');
  },
  30_000,
);

// Cleanup invokes native APIs too, so capture the failing API's error first.
test.each([
  ['if (!AssignProcessToJobObject(jobHandle, process.hProcess))', 'TerminateProcess'],
  ['if (resumeResult == UInt32.MaxValue)', 'TerminateJobObject'],
  ['if (wait != WAIT_TIMEOUT)', 'TerminateJobObject'],
])('preserves native error before cleanup: %s', (condition, cleanup) => {
  const launch = source.slice(source.indexOf('private WindowsJobRunResult RunAsUserCore('));
  const start = launch.indexOf(condition);
  expect(start).toBeGreaterThan(-1);
  const block = launch.slice(start, launch.indexOf('\n                }', start));
  const capture = block.indexOf('int nativeError = Marshal.GetLastWin32Error();');
  expect(capture).toBeGreaterThan(-1);
  expect(capture).toBeLessThan(block.indexOf(`${cleanup}(`));
  expect(block).toMatch(/new Win32Exception\(\s*nativeError,/u);
});
