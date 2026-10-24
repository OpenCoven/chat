#!/usr/bin/env node
// Drives the packaged OpenCoven Chat app through tauri-driver and records what
// each #504/#515 row observed. Usage:
//   node scripts/packaged-acceptance/run.mjs --application <installed binary> --out <dir>
//     [--lane <name>] [--package <installer>] [--tauri-driver <path>] [--native-driver <path>]
// Nothing is simulated except the model's words (see model-fixture.mjs).

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startModelFixture } from './model-fixture.mjs';
import { registerRecorder } from './platform.mjs';
import {
  composerOf,
  conversationLoaded,
  inspectorRow,
  linkRows,
  quoteRow,
  rightClickRow,
  storageRow,
  switchRow,
  tableRow,
} from './rows.mjs';
import { Session, Stop, sleep, until } from './webdriver.mjs';

const { values: options } = parseArgs({
  options: {
    application: { type: 'string' },
    out: { type: 'string' },
    lane: { type: 'string', default: process.platform },
    package: { type: 'string' },
    'tauri-driver': { type: 'string', default: 'tauri-driver' },
    'native-driver': { type: 'string' },
    port: { type: 'string', default: '4444' },
  },
});
if (!options.application || !options.out) {
  console.error('Usage: run.mjs --application <installed binary> --out <dir> [--lane <name>]');
  process.exit(2);
}

const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const FIRST = 'Astra';
const SECOND = 'Sage';

// Rows a person still has to run, whatever this lane observes.
const HAND_RUN = [
  ['504-1', 'Native context menu contents on right-click'],
  ['504-2', 'Screen reader announces the link when focus returns (Narrator, Orca, VoiceOver)'],
  ['504-3', 'IME composition after a quote; a real drag-selection'],
  ['504-6', 'Real pointer capture through a drag that leaves the window; separator read aloud'],
  ['504-7', 'Quote kept through a real cancelled run'],
  ['515', "The browser's own address bar, with the browser closed and with it running"],
  ['all', 'Every row on macOS (WKWebView has no WebDriver)'],
];

function covenCli() {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenCoven', 'Coven', 'coven.exe')
    : join(homedir(), '.local', 'bin', 'coven');
}

function tryRun(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `unavailable (${error.message.split('\n')[0]})`;
  }
}

function facts(userAgent) {
  const result = {
    lane: options.lane,
    os: `${process.platform} ${release()}`,
    userAgent,
    node: process.version,
    application: options.application,
  };
  if (process.platform === 'linux' && existsSync('/etc/os-release')) {
    result.distro = /PRETTY_NAME="([^"]+)"/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
    // `dpkg-query -W` prints the package and its version, separated by a tab.
    result.webkitgtk = tryRun('dpkg-query', ['-W', 'libwebkit2gtk-4.1-0']).split('\t').at(-1);
  }
  if (process.platform === 'win32') {
    result.webview2 = tryRun('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      '/v',
      'pv',
    ])
      .split(/\r?\n/)
      .find((line) => /REG_SZ/.test(line))
      ?.replace(/^.*REG_SZ\s+/, '');
  }
  if (options.package) {
    result.package = options.package;
    result.packageSha256 = createHash('sha256').update(readFileSync(options.package)).digest('hex');
  }
  result.coven = tryRun(covenCli(), ['--version']);
  return result;
}

async function startDriver(env) {
  const args = ['--port', options.port];
  if (options['native-driver']) args.push('--native-driver', options['native-driver']);
  const child = spawn(options['tauri-driver'], args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  const base = `http://127.0.0.1:${options.port}`;
  await until(
    'tauri-driver to listen',
    async () => {
      if (child.exitCode !== null) throw new Error(`tauri-driver exited: ${log.join('')}`);
      const response = await fetch(`${base}/status`);
      return response.ok;
    },
    30_000,
    250,
  );
  return { child, base, log };
}

/** First-run setup through the window: install Coven and the engine, then name a familiar. */
async function setUp(s, setupRow) {
  const phase = await until(
    'the setup screen or the chat',
    async () => {
      if ((await s.all('heading', 'Set up Coven Chat')).length) return 'setup';
      if ((await s.all('textbox', 'Message ', { exact: false })).length) return 'chat';
      return null;
    },
    60_000,
  );
  setupRow.note('first screen', phase);
  if (phase === 'chat') throw new Error('The scratch profile already had Coven set up.');

  // A failed step shows "Try again" with an alert; report its words rather than time out.
  const next = (what, role, label, timeout) =>
    until(
      what,
      async () => {
        const alerts = await s.all('alert');
        if (alerts.length) throw new Stop(`Setup reported: ${await alerts[0].text()}`);
        const found = await s.all(role, label);
        return found.length === 1 ? found[0] : null;
      },
      timeout,
      500,
    ).catch((error) => {
      throw new Error(`${what}: ${error.message}`);
    });
  await (await s.one('button', 'Install Coven')).click();
  await next('Install Coven', 'button', 'Install the engine', 10 * 60_000);
  setupRow.note('Install Coven', 'done; the engine step is offered');
  await (await s.one('button', 'Install the engine')).click();
  const name = await next('Install the engine', 'textbox', 'Familiar name', 20 * 60_000);
  setupRow.note('Install the engine', 'done; the familiar step is offered');
  await name.click();
  await name.type(FIRST);
  await (await s.one('button', 'Create familiar')).click();
  await until(
    'the chat',
    async () => {
      const proceed = await s.all('button', 'Continue to Chat');
      if (proceed.length === 1) await proceed[0].click();
      return (await s.all('textbox', `Message ${FIRST}`)).length === 1;
    },
    120_000,
    500,
  );
  setupRow.note('Create familiar', `${FIRST}; the chat opened`);
}

function markdown(report) {
  const lines = [
    `# Automated packaged acceptance: ${report.facts.lane}`,
    '',
    'Driven through tauri-driver against the installed package. Model replies come from a local,',
    'deterministic Anthropic-compatible endpoint; Chat, Coven, the engine and streaming are real.',
    'These results are **automated packaged** evidence. They are not hand-run results.',
    '',
    '| Fact | Value |',
    '| --- | --- |',
    ...Object.entries(report.facts).map(
      ([key, value]) => `| ${key} | ${String(value).replaceAll('|', '\\|')} |`,
    ),
    '',
    '| Row | Title | Result |',
    '| --- | --- | --- |',
    ...report.rows.map(
      (row) =>
        `| ${row.id} | ${row.title} | ${row.status}${row.error ? `: ${row.error.replaceAll('|', '\\|')}` : ''} |`,
    ),
    '',
    '## Observations',
    '',
  ];
  for (const row of report.rows) {
    lines.push(`### ${row.id}: ${row.title} (${row.status})`, '');
    for (const { label, value, expected } of row.observations) {
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(
        `- ${label}: \`${String(shown).replaceAll('`', "'")}\`${expected === undefined ? '' : ` (expected \`${JSON.stringify(expected)}\`)`}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Still hand-run',
    '',
    ...report.handRun.map(([id, what]) => `- ${id}: ${what}`),
    '',
  );
  return lines.join('\n');
}

const modelLog = join(out, 'model-requests.jsonl');
writeFileSync(modelLog, '');
const fixture = await startModelFixture({ log: modelLog });
const requests = () =>
  readFileSync(modelLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"/v1/messages"')).length;
const opened = registerRecorder(join(out, 'opened.jsonl'));
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}`,
  ANTHROPIC_API_KEY: 'sk-ant-packaged-acceptance-fixture',
};
const rows = [];
let driver;
let session;
let userAgent = 'unknown';
const setupRow = { id: 'setup', title: 'First-run setup through the window', observations: [] };
setupRow.note = (label, value) => setupRow.observations.push({ label, value });
setupRow.note('system browser registration', `${opened.handler} via ${opened.opener}`);
rows.push(setupRow);

try {
  driver = await startDriver(env);
  session = await Session.start(driver.base, {
    'tauri:options': { application: options.application },
  });
  userAgent = await session.execute('return navigator.userAgent;');
  await setUp(session, setupRow);
  rows.push(...(await linkRows(session, FIRST, opened, requests)));
  rows.push(await tableRow(session, FIRST));
  rows.push(await quoteRow(session, FIRST, requests));
  rows.push(await inspectorRow(session, FIRST));

  const created = tryRun(covenCli(), ['familiars', 'create', '--json', '--', SECOND]);
  setupRow.note(`second familiar created with the installed CLI`, created);
  await session.refresh();
  await composerOf(session, FIRST);
  await session.one('button', SECOND, { timeout: 30_000 });
  try {
    setupRow.note(
      `${FIRST}'s conversation loaded after a reload (ms)`,
      await conversationLoaded(session, setupRow, 'three steps'),
    );
  } catch (error) {
    // Recorded, not fatal: the rows after this one say what they can still see.
    setupRow.note(`${FIRST}'s conversation after a reload`, error.message);
  }
  rows.push(await switchRow(session, FIRST, SECOND));
  rows.push(await storageRow(session));
  rows.push(await rightClickRow(session, opened));
} catch (error) {
  setupRow.error = error.message;
} finally {
  for (const row of rows) {
    row.status = row.error ? 'failed' : row.skipped ? 'not reached' : 'observed';
  }
  if (session) {
    try {
      writeFileSync(join(out, 'final.png'), Buffer.from(await session.screenshot(), 'base64'));
    } catch {
      // A screenshot is a convenience; its absence is not evidence of anything.
    }
    await session.end().catch(() => undefined);
  }
  await sleep(500);
  driver?.child.kill();
  await fixture.close();
}

const report = {
  facts: {
    ...facts(userAgent),
    modelRequests: requests(),
    systemBrowserLaunches: opened.received().length,
  },
  rows: rows.map(({ id, title, status, error, observations }) => ({
    id,
    title,
    status,
    error,
    observations,
  })),
  handRun: HAND_RUN,
};
writeFileSync(join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, 'results.md'), markdown(report));
if (driver) writeFileSync(join(out, 'tauri-driver.log'), driver.log.join(''));
console.log(markdown(report));
process.exit(report.rows.every((row) => row.status === 'observed') ? 0 : 1);
