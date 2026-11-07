// Row 8, read from disk after the app has quit: the web view's own storage
// files, opened by this process, never by the page. WebKit (macOS, Linux) keeps
// local storage in SQLite; WebView2 keeps it, and session storage, in LevelDB.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM } from './driver.mjs';
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

export function storageRow() {
  const row = new Row('504-8', 'Preference-only browser storage, read from disk after quitting');
  try {
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
    let preferences;
    let navigation;
    const databases = [];
    for (const path of all) {
      if (/IndexedDB/i.test(path)) databases.push(path);
      if (/\.(sqlite3|localstorage)$/.test(path)) {
        const items = sqliteItems(path);
        if (!items) continue;
        for (const [key, value] of items) {
          keys.set(key, path);
          if (key === 'opencoven.chat.preferences.v1') preferences = value;
          if (key === 'opencoven.chat.navigation.v1') navigation = value;
        }
      } else if (
        /(Local Storage|Session Storage)[\\/]leveldb[\\/].*\.(log|ldb)$|Session Storage[\\/].*\.(log|ldb)$/.test(
          path,
        )
      ) {
        const bytes = readFileSync(path);
        for (const key of leveldbKeys(bytes)) keys.set(key, path);
        const latin = bytes.toString('latin1');
        const utf16 = bytes.toString('utf16le');
        const pick = (name) => {
          for (const text of [utf16, latin]) {
            const at = text.lastIndexOf(
              name === 'preferences' ? '"inspectorWidth"' : '"familiarId"',
            );
            if (at < 0) continue;
            const start = text.lastIndexOf('{', at);
            const end = text.indexOf('}', at);
            if (start >= 0 && end > start) return text.slice(start, end + 1);
          }
          return undefined;
        };
        preferences ??= pick('preferences');
        navigation ??= pick('navigation');
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
    let parsed = {};
    try {
      parsed = JSON.parse(preferences ?? '{}');
    } catch {
      row.note('preferences value (unparsed)', String(preferences).slice(0, 300));
    }
    row.note('stored preferences', parsed);
    row.expect('inspectorWidth is a number', typeof parsed.inspectorWidth, 'number');
    if (navigation) {
      try {
        row.check(
          'navigation holds only ids',
          Object.keys(JSON.parse(navigation)).every((key) =>
            ['familiarId', 'sessionId'].includes(key),
          ),
          navigation,
        );
      } catch {
        row.note('navigation value (unparsed)', String(navigation).slice(0, 200));
      }
    }
    row.note('IndexedDB files', databases);
    for (const needle of NEEDLES) {
      const hits = all.filter((path) => {
        const bytes = readFileSync(path);
        return (
          bytes.includes(Buffer.from(needle, 'utf8')) ||
          bytes.includes(Buffer.from(needle, 'utf16le'))
        );
      });
      row.expect(`browser storage files containing "${needle}"`, hits, []);
    }
    // Outside browser storage, for the record: Chat's own app data (not judged here).
    const appFiles = app.flatMap((root) => files(root));
    row.note(
      'app data files (not browser storage)',
      appFiles.map((path) => path.replace(home, '~')),
    );
  } catch (error) {
    row.error = error.message;
  }
  return row;
}
