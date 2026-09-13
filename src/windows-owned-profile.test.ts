import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync('scripts/windows-job-supervisor.cs', 'utf8');
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

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
