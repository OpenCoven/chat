import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const shell = process.env.CHAT_TEST_PWSH ?? 'pwsh';
const script = resolve('scripts/native-acceptance/windows/find-installed-exe.ps1');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chat-installed-exe-'));
  roots.push(root);
  const local = join(root, 'local');
  const programs = join(root, 'program-files');
  mkdirSync(local);
  mkdirSync(programs);
  return {
    local,
    programs,
    put(...parts: string[]) {
      const path = join(...parts, 'opencoven-chat.exe');
      mkdirSync(join(...parts), { recursive: true });
      writeFileSync(path, 'binary');
      return path;
    },
    find() {
      const found = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-File', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        env: { ...process.env, LOCALAPPDATA: local, ProgramFiles: programs },
      }).trim();
      return normalize(found.replaceAll('\\', '/'));
    },
  };
}

describe('Windows lane executable discovery', () => {
  it('finds the earlier name when only the old installation exists', () => {
    const f = fixture();
    const old = f.put(f.programs, 'OpenCoven Chat');
    expect(f.find()).toBe(old);
  });
  it('finds the new product when it is the only installed version', () => {
    const f = fixture();
    const current = f.put(f.programs, 'Coven Chat');
    expect(f.find()).toBe(current);
  });
  it('prefers the new product when both installation names are present', () => {
    const f = fixture();
    f.put(f.programs, 'OpenCoven Chat');
    const current = f.put(f.programs, 'Coven Chat');
    expect(f.find()).toBe(current);
  });
  it('does not mistake an unrelated cached executable for an installation', () => {
    const f = fixture();
    f.put(f.local, 'unrelated-cache');
    expect(() => f.find()).toThrow();
  });
  it('does not treat a directory named like the executable as an installation', () => {
    const f = fixture();
    mkdirSync(join(f.programs, 'Coven Chat', 'opencoven-chat.exe'), { recursive: true });
    expect(() => f.find()).toThrow();
  });
  it('reports a missing installation rather than returning an empty path', () => {
    const f = fixture();
    expect(() => f.find()).toThrow();
  });
});
