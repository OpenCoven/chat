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
function leveldbKeys(bytes) {
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
  const all = listed.filter(({ root, path }) => !appOwned(root, path)).map(({ path }) => path);
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
      for (const key of leveldbKeys(bytes)) recordKey(key, path);
      const latin = bytes.toString('latin1');
      const utf16 = bytes.toString('utf16le');
      const pick = (name) => {
        for (const text of [utf16, latin]) {
          const at = text.lastIndexOf(name === 'preferences' ? '"inspectorWidth"' : '"familiarId"');
          if (at < 0) continue;
          const start = text.lastIndexOf('{', at);
          const end = text.indexOf('}', at);
          if (start >= 0 && end > start) return text.slice(start, end + 1);
        }
        return undefined;
      };
      preferences ??= pick('preferences');
      navigation ??= pick('navigation');
      checkStoredValues(row, preferences, navigation, true);
      if (/Session Storage/.test(path))
        for (const key of leveldbKeys(bytes)) row.note('session storage key', key);
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
