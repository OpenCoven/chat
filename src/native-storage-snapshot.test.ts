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
const { objectAround, storageRow } = await import(modulePath);
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

function varintBytes(input: number) {
  let value = input;
  const varint = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    varint.push(value ? byte | 0x80 : byte);
  } while (value);
  return Buffer.from(varint);
}

function leveldbRecord(
  key: string,
  value: string,
  encoding: BufferEncoding = 'latin1',
  valuePrefix = Buffer.alloc(0),
) {
  const payload = Buffer.concat([valuePrefix, Buffer.from(value, encoding)]);
  return Buffer.concat([
    Buffer.from(`_http://tauri.localhost\0\x01${key}`, 'latin1'),
    varintBytes(payload.length),
    payload,
  ]);
}

function leveldbTableEntry(
  key: string,
  value: string,
  encoding: BufferEncoding,
  valuePrefix: Buffer,
  sequence = 1,
  type = 1,
) {
  const userKey = Buffer.from(`_http://tauri.localhost\0\x01${key}`, 'latin1');
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE((BigInt(sequence) << 8n) | BigInt(type));
  const encodedKey = Buffer.concat([userKey, trailer]);
  const payload = Buffer.concat([valuePrefix, Buffer.from(value, encoding)]);
  return leveldbTable(
    Buffer.concat([
      varintBytes(0),
      varintBytes(encodedKey.length),
      varintBytes(payload.length),
      encodedKey,
      payload,
    ]),
    encoding === 'utf16le',
  );
}

function leveldbSharedTableEntries(entries: { key: string; value: string; sequence: number }[]) {
  const output = [];
  let previous = Buffer.alloc(0);
  for (const { key, value, sequence } of entries) {
    const userKey = Buffer.from(`_http://tauri.localhost\0\x01${key}`, 'latin1');
    const trailer = Buffer.alloc(8);
    trailer.writeBigUInt64LE((BigInt(sequence) << 8n) | 1n);
    const internalKey = Buffer.concat([userKey, trailer]);
    let shared = 0;
    while (shared < previous.length && previous[shared] === internalKey[shared]) shared += 1;
    const suffix = internalKey.subarray(shared);
    const payload = Buffer.concat([Buffer.from([1]), Buffer.from(value, 'latin1')]);
    output.push(
      varintBytes(shared),
      varintBytes(suffix.length),
      varintBytes(payload.length),
      suffix,
      payload,
    );
    previous = internalKey;
  }
  return leveldbTable(Buffer.concat(output));
}

function snappyLiteral(bytes: Buffer) {
  const length = bytes.length - 1;
  const tag =
    length < 60
      ? Buffer.from([length << 2])
      : length < 256
        ? Buffer.from([60 << 2, length])
        : Buffer.from([61 << 2, length & 0xff, length >> 8]);
  return Buffer.concat([varintBytes(bytes.length), tag, bytes]);
}

function leveldbTable(entries: Buffer, compressed = false) {
  const blockContents = (body: Buffer, restartCount = 1) => {
    const restarts = Buffer.alloc(4 + restartCount * 4);
    if (restartCount) restarts.writeUInt32LE(0, 0);
    restarts.writeUInt32LE(restartCount, restartCount * 4);
    return Buffer.concat([body, restarts]);
  };
  const storedBlock = (contents: Buffer, useCompression = false) => {
    const stored = useCompression ? snappyLiteral(contents) : contents;
    return Buffer.concat([stored, Buffer.from([useCompression ? 1 : 0]), Buffer.alloc(4)]);
  };
  const data = storedBlock(blockContents(entries), compressed);
  const metaOffset = data.length;
  const meta = storedBlock(blockContents(Buffer.alloc(0), 0));
  const indexOffset = metaOffset + meta.length;
  const handle = Buffer.concat([varintBytes(0), varintBytes(data.length - 5)]);
  const indexEntry = Buffer.concat([
    varintBytes(0),
    varintBytes(1),
    varintBytes(handle.length),
    Buffer.from('z'),
    handle,
  ]);
  const index = storedBlock(blockContents(indexEntry));
  const footerHandles = Buffer.concat([
    varintBytes(metaOffset),
    varintBytes(meta.length - 5),
    varintBytes(indexOffset),
    varintBytes(index.length - 5),
  ]);
  const footer = Buffer.concat([
    footerHandles,
    Buffer.alloc(40 - footerHandles.length),
    Buffer.from('57fb808b247547db', 'hex'),
  ]);
  return Buffer.concat([data, meta, index, footer]);
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'chat-storage-'));
  profile = join(root, 'ai.opencoven.chat', 'EBWebView');
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('APPDATA', root);
  enumerations = 0;
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', '{"inspectorWidth":400}'),
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

test('reads a preferences value that holds an object of its own (Windows, #641)', async () => {
  // As WebView2 left it on the lane: `models` is a nested object after the
  // width, and the bytes are UTF-16 as Chromium writes non-Latin-1 values.
  const value = JSON.stringify({
    textSize: 'larger',
    groupTools: true,
    inspectorWidth: 600,
    harness: 'coven-code',
    models: { 'coven-code': '' },
  });
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', value, 'utf16le', Buffer.from([0])),
  );
  const row = await storageRow();
  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value: JSON.parse(value) }),
  );
  expect(
    row.observations.filter((o: { label: string }) => o.label === 'inspectorWidth is a number'),
  ).not.toContainEqual(expect.objectContaining({ ok: false }));
});

test.each([
  {
    encoding: 'latin1' as const,
    value:
      '{"inspectorWidth":610,"panels":[{"label":"brace } quote \\" slash \\\\"}],"models":{"coven-code":""}}',
  },
  {
    encoding: 'utf16le' as const,
    value:
      '{"inspectorWidth":620,"panels":[{"label":"brace { quote \\" slash \\\\"}],"models":{"coven-code":""}}',
  },
])(
  'reads nested arrays and escaped JSON from a $encoding LevelDB value',
  async ({ encoding, value }) => {
    put(
      'Default/Local Storage/leveldb/000001.log',
      leveldbRecord(
        'opencoven.chat.preferences.v1',
        value,
        encoding,
        encoding === 'utf16le' ? Buffer.from([0]) : Buffer.alloc(0),
      ),
    );

    const row = await storageRow();

    expect(row.status).not.toBe('failed');
    expect(row.observations).toContainEqual(
      expect.objectContaining({
        label: 'stored preferences',
        value:
          encoding === 'latin1'
            ? {
                inspectorWidth: 610,
                panels: [{ label: 'brace } quote " slash \\' }],
                models: { 'coven-code': '' },
              }
            : {
                inspectorWidth: 620,
                panels: [{ label: 'brace { quote " slash \\' }],
                models: { 'coven-code': '' },
              },
      }),
    );
  },
);

test('reconstructs a shared-prefix SSTable entry and selects by internal sequence', async () => {
  fs.rmSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
  put(
    'Default/Local Storage/leveldb/000002.ldb',
    leveldbSharedTableEntries([
      {
        key: 'opencoven.chat.navigation.v1',
        value: '{"familiarId":"familiar-1"}',
        sequence: 9,
      },
      {
        key: 'opencoven.chat.preferences.v1',
        value: '{"inspectorWidth":650,"models":{"coven-code":""}}',
        sequence: 12,
      },
      {
        key: 'opencoven.chat.preferences.v1',
        value: '{"inspectorWidth":300}',
        sequence: 4,
      },
    ]),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'stored preferences',
      value: { inspectorWidth: 650, models: { 'coven-code': '' } },
    }),
  );
});

test('selects the newest internal sequence across SSTable files, not the last filename', async () => {
  fs.rmSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
  put(
    'Default/Local Storage/leveldb/000002.ldb',
    leveldbTableEntry(
      'opencoven.chat.preferences.v1',
      '{"inspectorWidth":660}',
      'latin1',
      Buffer.from([1]),
      20,
    ),
  );
  put(
    'Default/Local Storage/leveldb/000099.ldb',
    leveldbTableEntry(
      'opencoven.chat.preferences.v1',
      '{"inspectorWidth":200}',
      'latin1',
      Buffer.from([1]),
      3,
    ),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value: { inspectorWidth: 660 } }),
  );
});

test('a newer SSTable tombstone suppresses an older value in another file', async () => {
  fs.rmSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
  put(
    'Default/Local Storage/leveldb/000002.ldb',
    leveldbTableEntry(
      'opencoven.chat.preferences.v1',
      '{"inspectorWidth":200}',
      'latin1',
      Buffer.from([1]),
      3,
    ),
  );
  put(
    'Default/Local Storage/leveldb/000003.ldb',
    leveldbTableEntry('opencoven.chat.preferences.v1', '', 'latin1', Buffer.alloc(0), 20, 0),
  );

  const row = await storageRow();

  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
  );
  expect(row.observations).not.toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value: { inspectorWidth: 200 } }),
  );
});

test.each([
  ['latin1' as const, Buffer.from([1]), 630],
  ['utf16le' as const, Buffer.from([0]), 640],
])(
  'reads a framed $0 preference value from an SSTable .ldb entry',
  async (encoding, tag, width) => {
    const value = JSON.stringify({ inspectorWidth: width, models: { 'coven-code': '' } });
    fs.rmSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
    put(
      'Default/Local Storage/leveldb/000002.ldb',
      leveldbTableEntry('opencoven.chat.preferences.v1', value, encoding, tag),
    );

    const row = await storageRow();

    expect(row.status).not.toBe('failed');
    expect(row.observations).toContainEqual(
      expect.objectContaining({
        label: 'stored preferences',
        value: { inspectorWidth: width, models: { 'coven-code': '' } },
      }),
    );
  },
);

test.each([
  ['balanced but malformed', '{"inspectorWidth":600,}'],
  ['incomplete', '{"inspectorWidth":600,"models":{}'],
] as const)('fails a %s LevelDB preference record', async (_name, value) => {
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', value),
  );

  const row = await storageRow();

  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
  );
});

test('an object around a key is the innermost one whose braces enclose it', () => {
  const text = 'x{"a":{"b":"}{"},"inspectorWidth":1,"models":{"c":""}}y';
  expect(objectAround(text, text.indexOf('"inspectorWidth"'))).toBe(
    '{"a":{"b":"}{"},"inspectorWidth":1,"models":{"c":""}}',
  );
  // A value cut off before its closing brace is not an object.
  expect(objectAround('{"inspectorWidth":1,"models":{}', 1)).toBeUndefined();
  expect(objectAround('"inspectorWidth":1}', 0)).toBeUndefined();
});

test('object extraction stays within its finite search bounds', () => {
  const distantStart = `{"padding":"${'x'.repeat(32)}","inspectorWidth":1}`;
  expect(objectAround(distantStart, distantStart.indexOf('"inspectorWidth"'), 16)).toBeUndefined();

  const distantEnd = `{"inspectorWidth":1,"padding":"${'x'.repeat(64)}"}`;
  expect(objectAround(distantEnd, distantEnd.indexOf('"inspectorWidth"'), 16)).toBeUndefined();
});

test('reads the newest complete preference object when a LevelDB log holds multiple records', async () => {
  put(
    'Default/Local Storage/leveldb/000001.log',
    Buffer.concat([
      leveldbRecord('opencoven.chat.preferences.v1', '{"inspectorWidth":400}'),
      leveldbRecord(
        'opencoven.chat.preferences.v1',
        '{"inspectorWidth":640,"models":{"coven-code":""}}',
      ),
    ]),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'stored preferences',
      value: { inspectorWidth: 640, models: { 'coven-code': '' } },
    }),
  );
});

test('does not reuse an older preference value when the latest LevelDB record is malformed', async () => {
  put(
    'Default/Local Storage/leveldb/000001.log',
    Buffer.concat([
      leveldbRecord('opencoven.chat.preferences.v1', '{"inspectorWidth":400}'),
      leveldbRecord('opencoven.chat.preferences.v1', '{"models":{"coven-code":""}}'),
    ]),
  );

  const row = await storageRow();

  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
  );
  expect(row.observations).not.toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value: { inspectorWidth: 400 } }),
  );
});

test('does not reuse a preference value from an older LevelDB file', async () => {
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', '{"inspectorWidth":400}'),
  );
  put(
    'Default/Local Storage/leveldb/000002.log',
    leveldbRecord('opencoven.chat.preferences.v1', '{"models":{"coven-code":""}}'),
  );

  const row = await storageRow();

  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
  );
  expect(row.observations).not.toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value: { inspectorWidth: 400 } }),
  );
});

test.each([
  ['an origin marker', '_http marker'],
  ['the preference key', 'opencoven.chat.preferences.v1'],
] as const)('does not treat %s inside a JSON string as LevelDB framing', async (_name, label) => {
  const value = JSON.stringify({
    inspectorWidth: 640,
    label,
    models: { 'coven-code': '' },
  });
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', value),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'stored preferences',
      value: { inspectorWidth: 640, label, models: { 'coven-code': '' } },
    }),
  );
});

test('does not treat a UTF-16LE U+0100 code point as a LevelDB record delimiter', async () => {
  const value = JSON.stringify({
    inspectorWidth: 640,
    label: 'Ā',
    models: { 'coven-code': '' },
  });
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', value, 'utf16le', Buffer.from([0])),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({
      label: 'stored preferences',
      value: { inspectorWidth: 640, label: 'Ā', models: { 'coven-code': '' } },
    }),
  );
});

test('extracts the complete preference object when a nested object repeats inspectorWidth', async () => {
  const value = {
    inspectorWidth: 640,
    panel: { inspectorWidth: 200 },
    models: { 'coven-code': '' },
  };
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', JSON.stringify(value)),
  );

  const row = await storageRow();

  expect(row.status).not.toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'stored preferences', value }),
  );
});

test.each([
  ['incomplete', '{"panel":{"inspectorWidth":200}'],
  ['malformed', '{"panel":{"inspectorWidth":200},'],
] as const)(
  'does not accept a valid nested object from an %s preference record',
  async (_name, value) => {
    put(
      'Default/Local Storage/leveldb/000001.log',
      leveldbRecord('opencoven.chat.preferences.v1', value),
    );

    const row = await storageRow();

    expect(row.status).toBe('failed');
    expect(row.observations).toContainEqual(
      expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
    );
  },
);

test.each([
  ['array wrapper', '[{"inspectorWidth":200}]'],
  ['extra opening brace', '{{"inspectorWidth":200}'],
  ['printable prefix', 'x{"inspectorWidth":200}'],
] as const)('does not accept a preference object with an %s', async (_name, value) => {
  put(
    'Default/Local Storage/leveldb/000001.log',
    leveldbRecord('opencoven.chat.preferences.v1', value),
  );

  const row = await storageRow();

  expect(row.status).toBe('failed');
  expect(row.observations).toContainEqual(
    expect.objectContaining({ label: 'inspectorWidth is a number', ok: false }),
  );
});

test('an unexpected storage key remains a failure', async () => {
  put('Default/Local Storage/leveldb/000002.log', leveldbRecord('conversation.body', 'private'));
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
    leveldbRecord('conversation.body', 'private'),
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
            leveldbRecord('conversation.body', 'private'),
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
    const record =
      kind === 'navigation'
        ? leveldbRecord(
            'opencoven.chat.navigation.v1',
            '{"familiarId":"f","body":"private conversation"}',
          )
        : kind === 'preferences'
          ? leveldbRecord('opencoven.chat.preferences.v1', '{"inspectorWidth":"private"}')
          : leveldbRecord('opencoven.chat.navigation.v1', '{"familiarId":"three steps"}');
    if (kind === 'preferences')
      fs.unlinkSync(join(profile, 'Default/Local Storage/leveldb/000001.log'));
    const found = put('Default/Local Storage/leveldb/000002.log', record);
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
