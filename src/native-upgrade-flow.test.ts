import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ files: [] as string[] }));
// Native timing, MSI installation, process enumeration and version-resource reads
// are OS boundaries. The row, filesystem hashes and Lane logic remain real.
vi.mock('../scripts/native-acceptance/driver.mjs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sleep: async () => undefined,
}));
vi.mock('../scripts/native-acceptance/storage.mjs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  browserFiles: () => storage.files,
}));
const modulePath = '../scripts/native-acceptance/upgrade.mjs';
const { autofillUpgradeRow, UPGRADE_PHRASE } = await import(modulePath);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function run({ both = false, missingOld = false, staleOld = false, wrongNew = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chat-upgrade-flow-'));
  roots.push(root);
  vi.stubEnv('LOCALAPPDATA', root);
  const old = join(root, 'OpenCoven Chat', 'opencoven-chat.exe');
  const current = join(root, 'Coven Chat', 'opencoven-chat.exe');
  const journal = join(root, 'Web Data-journal');
  storage.files = [journal];
  let draft = '';
  const node = () => ({
    role: 'textbox',
    name: 'Message Astra',
    enabled: true,
    value: draft,
    children: [],
  });
  const app = {
    count: async () => 0,
    all: async () => [node()],
    snapshot: async () => ({ role: 'document', children: [node()] }),
    one: async (role: string, name: string) => ({ ...node(), role, name }),
    type: async (text: string) => {
      draft += text;
    },
    click: async ({ name }: { name: string }) => {
      if (name === 'Send') draft = '';
    },
  };
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  write(current, 'new binary');
  const versions: string[] = [];
  const launches: { log: string; path: string }[] = [];
  const installs: string[][] = [];
  const row = await autofillUpgradeRow({
    from: { path: 'old.msi', label: 'published v0.0.8' },
    to: { path: 'current.msi', label: 'candidate' },
    exe: current,
    installedSha: createHash('sha256').update('new binary').digest('hex'),
    out: root,
    familiars: ['Astra'],
    shot: () => undefined,
    quit: async () => true,
    waitForWebViewGone: async () => true,
    getProductVersion: (path: string) => {
      versions.push(path);
      return path === old ? '0.0.8' : '0.1.2';
    },
    installMsi: (args: string[]) => {
      installs.push(args);
      if (args[1] === 'old.msi') {
        if (!both) rmSync(current);
        if (!missingOld) write(old, 'old binary');
      } else {
        write(current, wrongNew ? 'wrong binary' : 'new binary');
        if (!staleOld) rmSync(old);
      }
      return 0;
    },
    launch: async (log: string, path: string) => {
      launches.push({ log, path });
      writeFileSync(journal, path === old ? UPGRADE_PHRASE : 'cleared');
      return { app, child: { exitCode: 0 } };
    },
  });
  return { row, versions, launches, installs, old, current };
}

describe('row 578 resolves each installed version across the MSI transition', () => {
  it('uses the old and upgraded paths for their real hashes, version reads and launches', async () => {
    const { row, versions, launches, installs, old, current } = await run();
    expect(row.error).toBeUndefined();
    expect(versions).toEqual([old, current]);
    expect(launches).toEqual([
      { log: 'app-v0.0.8.log', path: old },
      { log: 'app-upgraded.log', path: current },
    ]);
    expect(installs).toEqual([
      ['/i', 'old.msi'],
      ['/i', 'current.msi'],
    ]);
    expect(
      row.observations.find((entry: { label: string }) => entry.label === 'installed app').value
        .sha256,
    ).toBe(createHash('sha256').update('old binary').digest('hex'));
    expect(row.status).toBe('observed');
  });
  it('stages the older app even if both product folders exist before the upgrade', async () => {
    const { row, launches, old } = await run({ both: true });
    expect(launches[0]?.path).toBe(old);
    expect(row.status).toBe('observed');
  });
  it('fails when the older MSI left no executable and never launches an unrelated copy', async () => {
    const { row, launches } = await run({ missingOld: true });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('v0.0.8');
    expect(launches).toEqual([]);
  });
  it('rejects an old binary left behind after the upgraded app is installed', async () => {
    const { row, old } = await run({ staleOld: true });
    expect(existsSync(old)).toBe(true);
    expect(row.status).toBe('failed');
    expect(
      row.observations.find(
        (entry: { label: string }) =>
          entry.label === 'no copy of v0.0.8 is left installed, under either name',
      ),
    ).toMatchObject({ ok: false, value: [old] });
  });
  it('rejects an executable whose bytes do not match the build under test', async () => {
    const { row } = await run({ wrongNew: true });
    expect(row.status).toBe('failed');
    expect(
      row.observations.find(
        (entry: { label: string }) =>
          entry.label === 'the build under test is the installed app again',
      ),
    ).toMatchObject({ ok: false });
  });
});
