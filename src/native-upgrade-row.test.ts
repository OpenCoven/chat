import { describe, expect, it } from 'vitest';

const path = '../scripts/native-acceptance/upgrade.mjs';
const { installedAt, installPaths } = await import(path);

// Row 578 installs the published v0.0.8 MSI, then the build under test over it.
// Since #614 the build under test is Coven Chat, while v0.0.8 is OpenCoven Chat:
// candidate run 43555471371 failed the row with ENOENT reading v0.0.8 from
// Program Files\Coven Chat, where only the build under test installs.
const CANDIDATE = 'C:\\Program Files\\Coven Chat\\opencoven-chat.exe';
const V008 = 'C:\\Program Files\\OpenCoven Chat\\opencoven-chat.exe';

describe('native row 578: where each MSI put the app', () => {
  it("lists the build under test's path, then OpenCoven Chat's folder", () => {
    expect(installPaths(CANDIDATE)).toEqual([CANDIDATE, V008]);
  });

  it('finds v0.0.8 in its own folder after the build under test was replaced', () => {
    const present = new Set([V008]);
    const exists = (path: string) => present.has(path);
    expect(installedAt(installPaths(CANDIDATE).slice().reverse(), exists)).toBe(V008);
  });

  it('finds the upgraded app in its own folder, and nothing when neither exists', () => {
    const present = new Set([CANDIDATE]);
    expect(installedAt(installPaths(CANDIDATE), (path: string) => present.has(path))).toBe(
      CANDIDATE,
    );
    expect(installedAt(installPaths(CANDIDATE), () => false)).toBeNull();
  });

  it('lists one path while the build under test still carries the earlier name', () => {
    expect(installPaths(V008)).toEqual([V008]);
  });
});
