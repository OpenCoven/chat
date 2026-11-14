// @vitest-environment node
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Keep real files and reads; interpose only at the OS boundary to deterministically
// remove an entry after enumeration, or deny a particular stat/read.
const boundary = vi.hoisted(() => ({
  stat: undefined as undefined | ((path: string) => void),
  read: undefined as undefined | ((path: string) => void),
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>();
  return {
    ...real,
    statSync: (path: string) => {
      boundary.stat?.(path);
      return real.statSync(path);
    },
    readFileSync: (path: string, ...args: unknown[]) => {
      boundary.read?.(path);
      return Reflect.apply(real.readFileSync, real, [path, ...args]);
    },
  };
});
vi.mock('../scripts/native-acceptance/driver.mjs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  PLATFORM: 'windows',
}));
const modulePath = '../scripts/native-acceptance/storage.mjs';
const { storageRow } = await import(modulePath);
const needles = [
  'three steps',
  'read the source',
  'handoff-check',
  'docs.example.test',
  'wide-wide-wide',
  'Draft kept for later',
  'Slow line',
  'name@example.com',
  'Take your time',
  '日本',
];
let root: string;
let profile: string;
let enumerations = 0;

function put(name: string, bytes: string | Buffer) {
  const path = join(profile, name);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
  return path;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'chat-storage-'));
  profile = join(root, 'ai.opencoven.chat', 'EBWebView');
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('APPDATA', root);
  enumerations = 0;
  put(
    'Default/Local Storage/leveldb/000001.log',
    '_http://tauri.localhost\0\x01opencoven.chat.preferences.v1\0{"inspectorWidth":400}',
  );
});
afterEach(() => {
  boundary.stat = undefined;
  boundary.read = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function raceAt(stage: 'stat' | 'read') {
  const path = put('Default/Preferences.tmp', 'temporary bytes');
  boundary[stage] = (current) => {
    if (current !== path) return;
    enumerations += 1;
    fs.unlinkSync(path);
  };
  return path;
}

test.each(['stat', 'read'] as const)(
  'restarts the complete collection after a disappearing %s entry',
  async (stage) => {
    raceAt(stage);
    const row = await storageRow();
    expect(row.error).toBeUndefined();
    expect(enumerations).toBe(1);
    expect(row.observations).toContainEqual(
      expect.objectContaining({
        label: 'the preferences key was found',
        value: ['opencoven.chat.preferences.v1'],
        ok: true,
      }),
    );
    for (const needle of needles) {
      expect(row.observations).toContainEqual(
        expect.objectContaining({
          label: `browser storage files containing "${needle}"`,
          value: [],
          ok: true,
        }),
      );
    }
    expect(row.observations.some((o: { label: string }) => /snapshot.*retr/i.test(o.label))).toBe(
      true,
    );
  },
);

test('a retried snapshot still fails for forbidden content in a stable file', async () => {
  raceAt('stat');
  put('Default/forbidden.tmp', Buffer.from('日本', 'utf16le'));
  const row = await storageRow();
  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'browser storage files containing "日本"', ok: false }),
  );
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'the preferences key was found',
      value: ['opencoven.chat.preferences.v1'],
      ok: true,
    }),
  );
});

test.each(['EACCES', 'EPERM', 'EIO'])(
  'persistent %s fails immediately rather than being swallowed',
  async (code) => {
    const denied = put('Default/denied.tmp', 'private');
    boundary.read = (path) => {
      if (path === denied) {
        enumerations += 1;
        throw Object.assign(new Error(`read denied: ${code}`), { code });
      }
    };
    const row = await storageRow();
    expect(row.error).toContain(code);
    expect(enumerations).toBe(1);
  },
);

test('continuous profile instability exhausts a finite whole-collection bound', async () => {
  boundary.stat = (path) => {
    if (!path.endsWith('.tmp')) return;
    enumerations += 1;
    fs.unlinkSync(path);
    put(`Default/Preferences-${enumerations}.tmp`, 'temporary bytes');
  };
  put('Default/Preferences.tmp', 'temporary bytes');
  const row = await storageRow();
  expect(row.error).toMatch(/snapshot.*3|3.*snapshot/i);
  expect(enumerations).toBe(3);
});

test('a retry must enumerate again and detect a newly introduced forbidden file', async () => {
  const disappearing = put('Default/Preferences.tmp', 'temporary bytes');
  boundary.stat = (path) => {
    if (path !== disappearing) return;
    fs.unlinkSync(path);
    put('Default/new.tmp', 'Draft kept for later');
  };
  const row = await storageRow();
  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'browser storage files containing "Draft kept for later"',
      ok: false,
    }),
  );
});

test('missing preferences remains a failure after transient churn', async () => {
  raceAt('stat');
  fs.rmSync(join(profile, 'Default/Local Storage'), { recursive: true });
  const row = await storageRow();
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'the preferences key was found', ok: false }),
  );
});

test('an unexpected storage key remains a failure', async () => {
  put(
    'Default/Local Storage/leveldb/000002.log',
    '_http://tauri.localhost\0\x01conversation.body\0private',
  );
  const row = await storageRow();
  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'only the preferences and navigation keys are stored',
      ok: false,
    }),
  );
});

// Discarding this first row and retrying would hide a finding already observed.
test('a privacy failure survives a later disappearing file without a retry', async () => {
  const invalid = put(
    'Default/Local Storage/leveldb/000002.log',
    '_http://tauri.localhost\0\x01conversation.body\0private',
  );
  const temporary = put('Default/Preferences.tmp', 'temporary bytes');
  boundary.read = (path) => {
    if (path !== temporary) return;
    enumerations += 1;
    fs.unlinkSync(invalid);
    fs.unlinkSync(temporary);
  };
  const row = await storageRow();
  expect(row.status).toBe('failed');
  expect(enumerations).toBe(1);
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'unexpected storage key observed during snapshot',
      value: 'conversation.body',
      ok: false,
    }),
  );
  expect(row.observations.some((o: { label: string }) => o.label === 'snapshot retries')).toBe(
    false,
  );
});

test.each(needles)(
  'a transient retry preserves detection of %s in temporary files',
  async (needle) => {
    raceAt('stat');
    put('Default/stable.tmp', Buffer.from(needle, 'utf16le'));
    const row = await storageRow();
    expect(row.status).toBe('failed');
    expect(row.observations).toContainEqual(
      expect.objectContaining({ label: `browser storage files containing "${needle}"`, ok: false }),
    );
  },
);

test.each(['needle', 'key'] as const)(
  'a %s found before an interrupted scan cannot disappear into a passing retry',
  async (kind) => {
    const found =
      kind === 'needle'
        ? put('Default/a-forbidden.tmp', 'three steps')
        : put(
            'Default/Local Storage/leveldb/000002.log',
            '_http://tauri.localhost\0\x01conversation.body\0private',
          );
    const later =
      kind === 'needle'
        ? put('Default/z-disappearing.tmp', 'temporary')
        : put('Default/Local Storage/leveldb/000003.log', 'temporary');
    boundary.read = (path) => {
      if (path !== later) return;
      fs.unlinkSync(found);
      fs.unlinkSync(later);
    };
    const row = await storageRow();
    expect(row.status).toBe('failed');
    expect(row.failures).toBeGreaterThan(0);
    expect(JSON.stringify(row.observations)).toContain(
      kind === 'needle' ? 'three steps' : 'conversation.body',
    );
    expect(row.observations.some((o: { label: string }) => o.label === 'snapshot retries')).toBe(
      false,
    );
  },
);

test.each(['navigation', 'needle-in-key-file', 'preferences'] as const)(
  'an interrupted scan preserves invalid %s already read',
  async (kind) => {
    const bytes =
      kind === 'navigation'
        ? '_http://tauri.localhost\0\x01opencoven.chat.navigation.v1\0{"familiarId":"f","body":"private conversation"}'
        : kind === 'preferences'
          ? '_http://tauri.localhost\0\x01opencoven.chat.preferences.v1\0{"inspectorWidth":"private"}'
          : '_http://tauri.localhost\0\x01opencoven.chat.navigation.v1\0{"familiarId":"three steps"}';
    if (kind === 'preferences')
      fs.unlinkSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
    const found = put('Default/Local Storage/leveldb/000002.log', bytes);
    const later = put('Default/Local Storage/leveldb/000003.log', 'temporary');
    boundary.read = (path) => {
      if (path !== later) return;
      fs.unlinkSync(found);
      fs.unlinkSync(later);
    };
    const row = await storageRow();
    expect(row.status).toBe('failed');
    expect(row.failures).toBeGreaterThan(0);
    expect(row.observations.some((o: { label: string }) => o.label === 'snapshot retries')).toBe(
      false,
    );
  },
);
