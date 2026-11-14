// The real system browser, for #515: which browser the system calls default,
// which browser processes run before and after an Open, what their command
// lines carry, and what their address bars show, read through accessibility.

import { execFileSync } from 'node:child_process';
import { normalize, PLATFORM, walk } from './driver.mjs';

const BROWSERS = [
  { key: 'safari', mac: 'com.apple.Safari', process: /(^|\/)Safari$/ },
  {
    key: 'chrome',
    mac: 'com.google.Chrome',
    progId: /^ChromeHTML/,
    desktop: /google-chrome/,
    process: /(^|[\\/])(chrome(\.exe)?|Google Chrome)$/i,
  },
  {
    key: 'edge',
    mac: 'com.microsoft.edgemac',
    progId: /^MSEdgeHTM/,
    desktop: /microsoft-edge/,
    process: /(^|[\\/])(msedge(\.exe)?|Microsoft Edge)$/i,
  },
  {
    key: 'firefox',
    mac: 'org.mozilla.firefox',
    progId: /^FirefoxURL/,
    desktop: /firefox/,
    process: /(^|[\\/])(firefox(-bin|\.exe)?)$/i,
  },
];

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    return `(failed: ${String(error.stderr || error.message).split('\n')[0]})`;
  }
}

export async function defaultBrowser(native) {
  if (PLATFORM === 'mac') {
    const answer = await native.call({ cmd: 'defaultBrowser' });
    const found = BROWSERS.find((browser) => browser.mac === answer.bundle);
    return { key: found?.key ?? 'unknown', detail: `${answer.bundle} at ${answer.app}` };
  }
  if (PLATFORM === 'windows') {
    const query = (key) =>
      run('reg.exe', [
        'query',
        `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\${key}`,
        '/v',
        'ProgId',
      ]);
    const lines = [query('UserChoice'), query('UserChoiceLatest')].join('\n');
    const progId = /ProgId\s+REG_SZ\s+(\S+)/.exec(lines)?.[1] ?? '';
    // With no user choice, Windows opens https with Edge.
    const found = progId
      ? BROWSERS.find((browser) => browser.progId?.test(progId))
      : BROWSERS.find((b) => b.key === 'edge');
    return { key: found?.key ?? 'unknown', detail: progId || 'no user choice (Edge)' };
  }
  const desktop = run('xdg-settings', ['get', 'default-web-browser']);
  const found = BROWSERS.find((browser) => browser.desktop?.test(desktop));
  return { key: found?.key ?? 'unknown', detail: desktop };
}

/** Every running browser process, with its full command line. */
export function browserProcesses() {
  let rows = [];
  if (PLATFORM === 'windows') {
    const json = run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(msedge|chrome|firefox)\\.exe$" } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ]);
    try {
      const parsed = JSON.parse(json || '[]');
      rows = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: p.ProcessId,
        parent: p.ParentProcessId,
        name: p.Name,
        command: p.CommandLine ?? '',
      }));
    } catch {
      rows = [];
    }
  } else if (PLATFORM === 'mac') {
    // macOS hands a URL to a running app by Apple Event, not argv; the path names the app.
    rows = run('ps', ['-axo', 'pid=,ppid=,comm='])
      .split('\n')
      .map((line) => {
        const [, pid, parent, name] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
        return { pid: Number(pid), parent: Number(parent), name: name ?? '', command: name ?? '' };
      });
  } else {
    rows = run('ps', ['-axo', 'pid=,ppid=,comm=,args='])
      .split('\n')
      .map((line) => {
        const [, pid, parent, name, command] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
        return {
          pid: Number(pid),
          parent: Number(parent),
          name: name ?? '',
          command: command ?? '',
        };
      });
  }
  return rows
    .map((row) => ({ ...row, browser: BROWSERS.find((b) => b.process.test(row.name))?.key }))
    .filter((row) => row.browser && !/--type=/.test(row.command));
}

/** The address each top-level browser window shows, read through accessibility. */
export async function addressBars(native, browser) {
  const found = [];
  const pids = [];
  if (PLATFORM === 'mac') {
    const answer = await native.call({ cmd: 'running' });
    const bundle = BROWSERS.find((b) => b.key === browser)?.mac;
    for (const app of answer.apps ?? []) if (app.bundle === bundle) pids.push(app.pid);
  } else {
    for (const row of browserProcesses()) if (row.browser === browser) pids.push(row.pid);
  }
  for (const pid of pids) {
    const answer = await native.call(
      PLATFORM === 'mac'
        ? { cmd: 'otherTree', pid, depth: 40 }
        : { cmd: 'tree', pid, depth: 40, budget: 4000 },
    );
    if (!answer.ok) continue;
    const root = normalize(answer.tree);
    const entry = { pid, window: root?.name ?? '', fields: [], documents: [] };
    for (const node of walk(root)) {
      if (node.role === 'textbox' && typeof node.value === 'string' && node.value) {
        entry.fields.push({ name: node.name, value: node.value });
      }
      if (node.role === 'document' && (node.url || node.value))
        entry.documents.push(node.url ?? node.value);
    }
    found.push(entry);
  }
  return found;
}

export function quitBrowsers() {
  if (PLATFORM === 'mac') {
    for (const name of ['Safari', 'Google Chrome', 'Microsoft Edge', 'firefox'])
      run('pkill', ['-x', name]);
  } else if (PLATFORM === 'windows') {
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-Process msedge,chrome,firefox -ErrorAction SilentlyContinue | Stop-Process -Force',
    ]);
  } else {
    for (const name of ['firefox', 'chrome', 'msedge']) run('pkill', ['-x', name]);
  }
}
