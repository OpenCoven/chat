// Row 8, read from disk after the app has quit: the web view's own storage
// files, opened by this process, never by the page. WebKit (macOS, Linux) keeps
// local storage in SQLite; WebView2 keeps it, and session storage, in LevelDB.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLATFORM, sleep } from './driver.mjs';
import { Row } from './rows.mjs';

const ALLOWED = ['opencoven.chat.navigation.v1', 'opencoven.chat.preferences.v1'];
// Synthetic words that appear only in conversation content, drafts or addresses.
export const NEEDLES = [
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

function roots() {
  const home = homedir();
  if (PLATFORM === 'mac') {
    return {
      browser: [join(home, 'Library', 'WebKit', 'ai.opencoven.chat')],
      app: [
        join(home, 'Library', 'Application Support', 'ai.opencoven.chat'),
        join(home, 'Library', 'Caches', 'ai.opencoven.chat'),
      ],
    };
  }
  if (PLATFORM === 'windows') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return {
      browser: [join(local, 'ai.opencoven.chat', 'EBWebView')],
      app: [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'ai.opencoven.chat')],
    };
  }
  return {
    browser: [
      join(home, '.local', 'share', 'ai.opencoven.chat'),
      join(home, '.cache', 'ai.opencoven.chat'),
    ],
    app: [join(home, '.config', 'ai.opencoven.chat')],
  };
}

// On Linux the web view's storage and Chat's own files share one folder; these
// top-level entries are Chat's (src-tauri/src), not the web view's.
const APP_OWNED_LINUX = new Set([
  'coven-transcripts',
  'coven-attachments',
  'coven-missions',
  'cave-imports',
  'iphone-companion',
  'avatars',
]);

function appOwned(root, path) {
  if (PLATFORM !== 'linux' || !root.endsWith(join('.local', 'share', 'ai.opencoven.chat')))
    return false;
  const [top, ...rest] = path.slice(root.length + 1).split('/');
  return APP_OWNED_LINUX.has(top) || (!rest.length && /\.jsonl?$/.test(top));
}

function files(root, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files(path, found);
    else if (entry.isFile() && statSync(path).size < 64 * 1024 * 1024) found.push(path);
  }
  return found;
}

/** The web view's own storage files: on Linux, without Chat's files in the same folder. */
export function browserFiles() {
  return roots().browser.flatMap((root) => files(root).filter((path) => !appOwned(root, path)));
}

/** The files whose bytes hold a needle, as UTF-8 or as UTF-16. */
export function containing(paths, needle) {
  return paths.filter((path) => hasNeedle(readFileSync(path), needle));
}

function hasNeedle(bytes, needle) {
  return (
    bytes.includes(Buffer.from(needle, 'utf8')) || bytes.includes(Buffer.from(needle, 'utf16le'))
  );
}

function sqliteItems(path) {
  try {
    const out = execFileSync(
      'sqlite3',
      ['-readonly', '-separator', '\t', path, 'SELECT key, hex(value) FROM ItemTable;'],
      {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, hex] = line.split('\t');
        return [key, Buffer.from(hex ?? '', 'hex').toString('utf16le')];
      });
  } catch {
    return null;
  }
}

/** LevelDB keys for local storage look like `_<origin>\0\1<key>`; values follow, often UTF-16. */
function leveldbKeys(bytes, table = false) {
  if (table) return [...latestTableRecords(bytes).keys()];
  const text = bytes.toString('latin1');
  const keys = new Set();
  // Chromium writes NUL then SOH between the origin and the key.
  const separator = String.fromCharCode(0, 1);
  for (let at = text.indexOf(separator); at >= 0; at = text.indexOf(separator, at + 2)) {
    const origin = text.lastIndexOf('_http', at);
    if (origin < 0 || at - origin > 300 || !/^_https?:\/\/[!-~]+$/.test(text.slice(origin, at)))
      continue;
    // The value's length follows the key and may itself be printable, so a run
    // that starts with a known key is that key.
    const run = /^[ -~]{1,200}/.exec(text.slice(at + 2, at + 202))?.[0];
    if (run) keys.add(ALLOWED.find((known) => run.startsWith(known)) ?? run);
  }
  return [...keys];
}

function leveldbVarint(bytes, at) {
  let value = 0;
  for (let shift = 0; shift <= 28 && at < bytes.length; shift += 7, at += 1) {
    const byte = bytes[at];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: at + 1 };
  }
  return undefined;
}

function tableUserKey(internalKey) {
  if (internalKey.length < 9) return undefined;
  const userKey = internalKey.subarray(0, -8).toString('latin1');
  const separator = userKey.indexOf(String.fromCharCode(0, 1));
  if (separator < 0 || separator > 300 || !/^_https?:\/\/[!-~]+$/.test(userKey.slice(0, separator)))
    return undefined;
  const key = userKey.slice(separator + 2);
  return key && key.length <= 200 ? key : undefined;
}

function blockHandle(bytes, at, limit = bytes.length) {
  const offset = leveldbVarint(bytes, at);
  const size = offset && leveldbVarint(bytes, offset.next);
  return size && size.next <= limit
    ? { offset: offset.value, size: size.value, next: size.next }
    : undefined;
}

function snappyBlock(bytes) {
  const expected = leveldbVarint(bytes, 0);
  if (!expected) return undefined;
  const out = [];
  let at = expected.next;
  while (at < bytes.length && out.length < expected.value) {
    const tag = bytes[at++];
    const type = tag & 3;
    if (type === 0) {
      let length = tag >> 2;
      if (length < 60) length += 1;
      else {
        const octets = length - 59;
        if (at + octets > bytes.length) return undefined;
        length = 1;
        for (let i = 0; i < octets; i += 1) length += bytes[at++] * 2 ** (8 * i);
      }
      if (at + length > bytes.length) return undefined;
      for (const byte of bytes.subarray(at, at + length)) out.push(byte);
      at += length;
      continue;
    }
    const length = type === 1 ? 4 + ((tag >> 2) & 7) : 1 + (tag >> 2);
    let offset;
    if (type === 1) {
      if (at >= bytes.length) return undefined;
      offset = ((tag & 0xe0) << 3) | bytes[at++];
    } else {
      const octets = type;
      if (at + octets > bytes.length) return undefined;
      offset = 0;
      for (let i = 0; i < octets; i += 1) offset += bytes[at++] * 2 ** (8 * i);
    }
    if (!offset || offset > out.length) return undefined;
    for (let i = 0; i < length; i += 1) out.push(out[out.length - offset]);
  }
  return out.length === expected.value ? Buffer.from(out) : undefined;
}

function tableBlock(file, handle) {
  if (handle.offset + handle.size + 5 > file.length) return undefined;
  const bytes = file.subarray(handle.offset, handle.offset + handle.size);
  const compression = file[handle.offset + handle.size];
  if (compression === 0) return bytes;
  return compression === 1 ? snappyBlock(bytes) : undefined;
}

function blockEntries(bytes) {
  if (bytes.length < 4) return [];
  const restartCount = bytes.readUInt32LE(bytes.length - 4);
  const entriesEnd = bytes.length - 4 - restartCount * 4;
  if (entriesEnd < 0) return [];
  const entries = [];
  let at = 0;
  let previous = Buffer.alloc(0);
  while (at < entriesEnd) {
    const shared = leveldbVarint(bytes, at);
    const suffix = shared && leveldbVarint(bytes, shared.next);
    const value = suffix && leveldbVarint(bytes, suffix.next);
    if (!value || shared.value > previous.length) return [];
    const suffixEnd = value.next + suffix.value;
    const valueEnd = suffixEnd + value.value;
    if (valueEnd > entriesEnd) return [];
    const key = Buffer.concat([
      previous.subarray(0, shared.value),
      bytes.subarray(value.next, suffixEnd),
    ]);
    entries.push({ key, value: bytes.subarray(suffixEnd, valueEnd) });
    previous = key;
    at = valueEnd;
  }
  return at === entriesEnd ? entries : [];
}

function tableRecords(bytes) {
  const magic = Buffer.from('57fb808b247547db', 'hex');
  if (bytes.length < 48 || !bytes.subarray(-8).equals(magic)) return [];
  const footer = bytes.length - 48;
  const meta = blockHandle(bytes, footer, footer + 40);
  const index = meta && blockHandle(bytes, meta.next, footer + 40);
  const indexBlock = index && tableBlock(bytes, index);
  if (!indexBlock) return [];
  const records = [];
  for (const entry of blockEntries(indexBlock)) {
    const handle = blockHandle(entry.value, 0);
    const data = handle && tableBlock(bytes, handle);
    if (!data) continue;
    for (const item of blockEntries(data)) {
      const key = tableUserKey(item.key);
      if (!key) continue;
      const trailer = item.key.readBigUInt64LE(item.key.length - 8);
      const type = Number(trailer & 0xffn);
      if (type <= 1) records.push({ key, sequence: trailer >> 8n, type, value: item.value });
    }
  }
  return records;
}

function latestTableRecords(bytes) {
  const latest = new Map();
  for (const record of tableRecords(bytes)) {
    const prior = latest.get(record.key);
    if (!prior || record.sequence > prior.sequence) latest.set(record.key, record);
  }
  return latest;
}

function latestLeveldbRecord(bytes, key, table = false) {
  if (table) return latestTableRecords(bytes).get(key)?.value;
  const framedKey = Buffer.from(`\0\x01${key}`, 'latin1');
  const start = bytes.lastIndexOf(framedKey);
  if (start < 0) return undefined;
  const length = leveldbVarint(bytes, start + framedKey.length);
  if (!length || length.value > bytes.length - length.next) return undefined;
  return bytes.subarray(length.next, length.next + length.value);
}

/**
 * The JSON object in `text` that holds position `at`: the nearest `{` before
 * it whose matching `}`, skipping strings, comes after it. A value can hold
 * objects of its own (preferences keep a `models` object per engine), so the
 * first `}` after a key is not the end of its value.
 */
function objectsAround(text, at, reach) {
  const found = [];
  for (let start = text.lastIndexOf('{', at); start >= 0 && at - start <= reach; ) {
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length && i - start <= 2 * reach; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '\\') i += 1;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        if (i > at) found.push(text.slice(start, i + 1));
        break;
      }
    }
    start = start > 0 ? text.lastIndexOf('{', start - 1) : -1;
  }
  return found;
}

export function objectAround(text, at, reach = 4096) {
  return objectsAround(text, at, reach)[0];
}

function completeJsonObjectAround(text, at, reach = 4096) {
  const onlyFraming = (value) => [...value].every((character) => character.charCodeAt(0) <= 0x20);
  for (const candidate of objectsAround(text, at, reach).reverse()) {
    const start = text.lastIndexOf(candidate, at);
    if (start < 0 || !onlyFraming(text.slice(0, start))) continue;
    if (!onlyFraming(text.slice(start + candidate.length))) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Where in a SQLite file a needle sits: table and column, read-only, from a
 * copy (the profile may still hold a lock). Nothing of the row is kept but
 * the place, the needle being synthetic text the lane typed or showed.
 */
export function sqlitePlaces(path, needle) {
  const places = [];
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all();
      for (const column of columns) {
        const quoted = `"${column.name.replace(/"/g, '""')}"`;
        const hit = db
          .prepare(
            `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}" WHERE CAST(${quoted} AS TEXT) LIKE ?`,
          )
          .get(`%${needle}%`);
        if (hit?.n) places.push(`${name}.${column.name} (${hit.n} rows)`);
      }
    }
  } catch (error) {
    places.push(`(not readable as SQLite: ${error.message})`);
  } finally {
    db?.close();
  }
  return places;
}

// A profile can still flush after quit. Retry the entire collection, never
// individual missing paths: a fresh enumeration must see any replacement files.
// Privacy findings are terminal even if a later read also encounters churn.
export async function storageRow() {
  const retries = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const row = new Row('504-8', 'Preference-only browser storage, read from disk after quitting');
    if (retries.length) row.note('snapshot retries', [...retries]);
    try {
      collectStorage(row);
    } catch (error) {
      if (error.code === 'ENOENT' && !row.failures && attempt < 3) {
        retries.push({ attempt, error: error.message });
        await sleep(100);
        continue;
      }
      row.error =
        error.code === 'ENOENT'
          ? `Storage snapshot incomplete after ${attempt} attempt(s): ${error.message}`
          : error.message;
    }
    return row;
  }
}

function checkStoredValues(row, preferences, navigation, partial = false) {
  if (!partial || preferences !== undefined) {
    let parsed = {};
    try {
      parsed = JSON.parse(preferences ?? '{}');
    } catch {
      if (!partial) row.note('preferences value (unparsed)', String(preferences).slice(0, 300));
    }
    if (!partial) row.note('stored preferences', parsed);
    if (!partial || typeof parsed.inspectorWidth !== 'number')
      row.expect('inspectorWidth is a number', typeof parsed.inspectorWidth, 'number');
  }
  if (navigation) {
    try {
      const onlyIds = Object.keys(JSON.parse(navigation)).every((key) =>
        ['familiarId', 'sessionId'].includes(key),
      );
      if (!partial || !onlyIds) row.check('navigation holds only ids', onlyIds, navigation);
    } catch {
      if (!partial) row.note('navigation value (unparsed)', String(navigation).slice(0, 200));
    }
  }
}

function collectStorage(row) {
  const { browser, app } = roots();
  row.note(
    'browser storage folders',
    browser.map((root) => `${root}${existsSync(root) ? '' : ' (absent)'}`),
  );
  const listed = browser.flatMap((root) => files(root).map((path) => ({ root, path })));
  const all = listed
    .filter(({ root, path }) => !appOwned(root, path))
    .map(({ path }) => path)
    .sort();
  const shared = listed.filter(({ root, path }) => appOwned(root, path)).map(({ path }) => path);
  const home = homedir();
  row.note(
    'browser storage files',
    all.map((path) => path.replace(home, '~')),
  );
  if (shared.length)
    row.note(
      "Chat's own files in the same folder (not browser storage)",
      shared.map((path) => path.replace(home, '~')),
    );
  const keys = new Map();
  const recordKey = (key, path) => {
    keys.set(key, path);
    // Record before the next file can disappear and interrupt this scan.
    if (!ALLOWED.includes(key))
      row.check('unexpected storage key observed during snapshot', false, key);
  };
  let preferences;
  let navigation;
  let preferencesSequence = -1n;
  let navigationSequence = -1n;
  let preferencesFromLog = false;
  let navigationFromLog = false;
  const databases = [];
  const needleHits = new Map(NEEDLES.map((needle) => [needle, []]));
  for (const path of all) {
    // Inspect every file once, including temporary files. Record unsafe bytes
    // before the next OS read can fail; a retry must never erase a finding.
    const bytes = readFileSync(path);
    for (const needle of NEEDLES) {
      if (hasNeedle(bytes, needle)) {
        needleHits.get(needle).push(path);
        row.check('forbidden content observed during snapshot', false, { needle, path });
      }
    }
    if (/IndexedDB/i.test(path)) databases.push(path);
    if (/\.(sqlite3|localstorage)$/.test(path)) {
      const items = sqliteItems(path);
      if (!items) continue;
      for (const [key, value] of items) {
        recordKey(key, path);
        if (key === 'opencoven.chat.preferences.v1') preferences = value;
        if (key === 'opencoven.chat.navigation.v1') navigation = value;
        checkStoredValues(row, preferences, navigation, true);
      }
    } else if (
      /(Local Storage|Session Storage)[\\/]leveldb[\\/].*\.(log|ldb)$|Session Storage[\\/].*\.(log|ldb)$/.test(
        path,
      )
    ) {
      const table = path.endsWith('.ldb');
      const tableValues = table ? latestTableRecords(bytes) : undefined;
      const foundKeys = table ? [...tableValues.keys()] : leveldbKeys(bytes);
      for (const key of foundKeys) recordKey(key, path);
      const pick = (name) => {
        const key = `opencoven.chat.${name}.v1`;
        const tableRecord = tableValues?.get(key);
        const record = tableRecord?.value ?? latestLeveldbRecord(bytes, key);
        if (!record) return undefined;
        for (const text of [
          record.toString('utf16le'),
          record.subarray(1).toString('utf16le'),
          record.toString('latin1'),
        ]) {
          const at = text.lastIndexOf(name === 'preferences' ? '"inspectorWidth"' : '"familiarId"');
          if (at < 0) continue;
          const value = completeJsonObjectAround(text, at);
          if (value) return { value, sequence: tableRecord?.sequence };
        }
        return undefined;
      };
      if (foundKeys.includes('opencoven.chat.preferences.v1')) {
        const picked = pick('preferences');
        if (!table) {
          preferencesFromLog = true;
          preferences = picked?.value;
        } else {
          const record = tableValues.get('opencoven.chat.preferences.v1');
          if (!preferencesFromLog && record.sequence > preferencesSequence) {
            preferencesSequence = record.sequence;
            preferences = record.type === 0 ? undefined : picked?.value;
          }
        }
      }
      if (foundKeys.includes('opencoven.chat.navigation.v1')) {
        const picked = pick('navigation');
        if (!table) {
          navigationFromLog = true;
          navigation = picked?.value;
        } else {
          const record = tableValues.get('opencoven.chat.navigation.v1');
          if (!navigationFromLog && record.sequence > navigationSequence) {
            navigationSequence = record.sequence;
            navigation = record.type === 0 ? undefined : picked?.value;
          }
        }
      }
      checkStoredValues(row, preferences, navigation, true);
      if (/Session Storage/.test(path))
        for (const key of foundKeys) row.note('session storage key', key);
    }
  }
  const names = [...keys.keys()].sort();
  row.note('storage keys found', names);
  row.check(
    'only the preferences and navigation keys are stored',
    names.every((key) => ALLOWED.includes(key)),
    names,
  );
  row.check(
    'the preferences key was found',
    names.includes('opencoven.chat.preferences.v1'),
    names,
  );
  checkStoredValues(row, preferences, navigation);
  row.note('IndexedDB files', databases);
  for (const needle of NEEDLES) {
    const hits = needleHits.get(needle);
    row.expect(`browser storage files containing "${needle}"`, hits, []);
    for (const path of hits)
      row.note(`where "${needle}" sits in ${path.replace(home, '~')}`, sqlitePlaces(path, needle));
  }
  // Outside browser storage, for the record: Chat's own app data (not judged here).
  const appFiles = app.flatMap((root) => files(root));
  row.note(
    'app data files (not browser storage)',
    appFiles.map((path) => path.replace(home, '~')),
  );
}
