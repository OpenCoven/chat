import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync('scripts/windows-job-supervisor.cs', 'utf8');

describe('production Windows profile ownership boundary', () => {
  test('records actual profile ownership before verification and never predicts the profile path', () => {
    const factory = source.slice(
      source.indexOf('public static WindowsIsolatedUser Create('),
      source.indexOf('public void Disable('),
    );
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
    const factory = source.slice(
      source.indexOf('private static WindowsIsolatedUser CreateCore('),
      source.indexOf('public void Disable('),
    );
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
