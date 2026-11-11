#!/usr/bin/env node
// Drives an installed, published OpenCoven Chat with native input and reads it
// back through the platform accessibility tree and screen reader (#504, #515).
// No WebDriver is attached and nothing runs in the page, so the bytes driven
// are exactly the ones published. The model is the one stand-in (fixture.mjs).
//
//   node scripts/native-acceptance/run.mjs --app <installed binary> --out <dir>
//     --lane <name> [--helper <macOS helper>] [--nvda <nvda.exe>] [--japanese <id> --latin <id>]

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultBrowser, quitBrowsers } from './browser.mjs';
import { App, Native, outline, PLATFORM, screenshot, sleep, until } from './driver.mjs';
import { startModelFixture } from './fixture.mjs';
import {
  cancelledRunRow,
  inspectorRow,
  Lane,
  linkCompletionRow,
  linkRows,
  quoteRow,
  Row,
  showFamiliars,
  stopKeyRow,
  switchRow,
  tableRow,
} from './rows.mjs';
import { screenReader } from './speech.mjs';
import { storageRow } from './storage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    app: { type: 'string' },
    out: { type: 'string' },
    lane: { type: 'string', default: PLATFORM },
    helper: { type: 'string' },
    nvda: { type: 'string' },
    japanese: { type: 'string' },
    latin: { type: 'string' },
    'ime-on': { type: 'string' },
    'ime-off': { type: 'string' },
    facts: { type: 'string' },
  },
});
if (!options.app || !options.out) {
  console.error('Usage: run.mjs --app <installed binary> --out <dir> [--lane <name>]');
  process.exit(2);
}
const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const FIRST = 'Astra';
const SECOND = 'Sage';
// Window frames, fitted to the runner's screen once it is known (see below).
const FRAMES = { origin: { x: 40, y: 80 }, wide: { x: 40, y: 80, w: 1400, h: 820 } };

function tryRun(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `unavailable (${String(error.stderr || error.message).split('\n')[0]})`;
  }
}

const covenCli = () =>
  PLATFORM === 'windows'
    ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenCoven', 'Coven', 'coven.exe')
    : join(homedir(), '.local', 'bin', 'coven');

let shots = 0;
const shot = (name) => {
  shots += 1;
  screenshot(join(out, `${String(shots).padStart(2, '0')}-${name}.png`));
};

const modelLog = join(out, 'model-requests.jsonl');
writeFileSync(modelLog, '');
const fixture = await startModelFixture({ log: modelLog });
const logged = () =>
  readFileSync(modelLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.path === '/v1/messages');
const requests = () => logged().length;
const tokens = (name) => logged().filter((entry) => entry.token === name).length;

const native =
  PLATFORM === 'mac'
    ? new Native(options.helper ?? join(here, 'native-mac'), [])
    : PLATFORM === 'windows'
      ? new Native('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(here, 'windows', 'serve.ps1'),
        ])
      : new Native('python3', [join(here, 'linux', 'native_driver.py')]);

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}`,
  ANTHROPIC_API_KEY: 'sk-ant-native-acceptance-fixture',
};
const facts = {
  lane: options.lane,
  evidence: 'native OS-level automation on a fresh CI runner (not hand-run)',
  os: `${process.platform} ${release()}`,
  node: process.version,
  ...(options.facts ? JSON.parse(readFileSync(options.facts, 'utf8').replace(/^\uFEFF/, '')) : {}),
};
const rows = [];
const setup = new Row('setup', 'First-run setup through the window');
rows.push(setup);
let child;
let reader;

async function setUp(app) {
  const phase = await until(
    'the setup screen or the chat',
    async () => {
      if (await app.count('heading', 'Set up Coven Chat')) return 'setup';
      if ((await app.all('textbox', /^Message /)).length) return 'chat';
      return null;
    },
    90_000,
    1_000,
  );
  setup.note('first screen', phase);
  if (phase === 'chat')
    throw new Error('The profile already had Coven set up; it is not a fresh profile.');
  await app.click(await app.one('button', 'Install Coven'));
  await until(
    'Install Coven, then its engine',
    async () => {
      const alerts = await app.all('alert');
      const words = alerts
        .map((alert) => [alert.name, ...alert.children.map((c) => c.value ?? c.name)].join(' '))
        .join(' ')
        .trim();
      if (alerts.length && /fail|couldn|error|try again/i.test(words))
        throw new Error(`Setup reported: ${words}`);
      return app.count('heading', 'Coven engine (done)');
    },
    20 * 60_000,
    2_000,
  );
  setup.note('Install Coven', 'Coven and then its engine installed');
  const name = await app.one('textbox', 'Familiar name');
  await app.click(name);
  await app.type(FIRST);
  await app.click(await app.one('button', 'Create familiar'));
  await app.one('textbox', `Message ${FIRST}`, { timeout: 120_000 });
  setup.note('Create familiar', `${FIRST}; the chat opened`);
}

try {
  if (PLATFORM === 'mac') {
    const trust = await native.call({ cmd: 'trust' });
    facts.helperTrust = trust;
    if (!trust.accessibility)
      throw new Error('The helper is not trusted for accessibility on this runner.');
  }
  facts.screens = (await native.call({ cmd: 'screens' })).screens;
  const screen = facts.screens?.[0] ?? { w: 1920, h: 1080 };
  // Room above the window for the inspector drag to leave it, and below for the Dock.
  FRAMES.wide.w = Math.min(1400, screen.w - 80);
  FRAMES.wide.h = Math.min(820, screen.h - 120);
  facts.windowFrame = FRAMES.wide;
  const browser = await defaultBrowser(native);
  facts.defaultBrowser = browser;
  quitBrowsers();

  child = spawn(options.app, [], {
    env,
    detached: PLATFORM !== 'windows',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  child.stdout.on('data', (chunk) => appLog.push(String(chunk)));
  child.stderr.on('data', (chunk) => appLog.push(String(chunk)));
  child.on('exit', () => writeFileSync(join(out, 'app.log'), appLog.join('')));
  facts.appPid = child.pid;
  await until(
    'the app window',
    async () =>
      (await native.call({ cmd: 'target', pid: child.pid })).ok &&
      (await native.call({ cmd: 'windows' })).windows?.length,
    90_000,
    1_000,
  );
  const app = new App(native, child.pid);
  app.screen = screen;
  await app.activate();
  await app.setFrame(FRAMES.wide).catch((error) => setup.note('setFrame', error.message));
  await sleep(2_000);
  writeFileSync(join(out, 'first-tree.txt'), outline(await app.snapshot()).join('\n'));
  shot('first-screen');

  // Started only around the announcement checks (rows.mjs, listen).
  reader = screenReader({ out, nvda: options.nvda });
  facts.screenReader = reader ? reader.name : 'none available';
  await app.activate();

  const save = (name, text) => writeFileSync(join(out, name), text);
  const lane = new Lane({
    app,
    native,
    requests,
    tokens,
    reader,
    shot,
    save,
    cli: covenCli(),
    frames: FRAMES,
  });
  await setUp(app);
  shot('chat-open');
  rows.push(...(await linkRows(lane, FIRST, browser)));
  rows.push(await linkCompletionRow(lane, FIRST, fixture.finishReview));
  rows.push(await tableRow(lane, FIRST, FRAMES));
  const ime = options.japanese
    ? {
        japanese: options.japanese,
        latin: options.latin,
        on: options['ime-on'],
        off: options['ime-off'],
      }
    : null;
  rows.push(await quoteRow(lane, FIRST, ime));
  rows.push(await inspectorRow(lane, FIRST, FRAMES));

  // A second familiar for row 4. If it never reaches the rail, row 4 is not
  // run and says why; rows 7 and 8 still run.
  let second = false;
  try {
    setup.note(
      `${SECOND} created with the installed CLI`,
      tryRun(covenCli(), ['familiars', 'create', '--json', '--', SECOND]),
    );
    await lane.front();
    await lane.reset();
    await showFamiliars(lane, setup);
    await app.click(await app.one('button', 'Refresh Coven'));
    await app.one('button', SECOND, { timeout: 30_000 });
    second = true;
  } catch (error) {
    setup.note(`${SECOND} did not reach the rail`, error.message);
    shot('second-familiar-failure');
  }
  if (second) rows.push(await switchRow(lane, FIRST, SECOND));
  else {
    const skipped = new Row('504-4', 'Chat-switch isolation');
    skipped.error = `not run: ${SECOND} did not reach the familiars rail`;
    rows.push(skipped);
  }
  await lane.front();
  await lane.reset();
  rows.push(await cancelledRunRow(lane, FIRST));
  await lane.front();
  await lane.reset();
  rows.push(await stopKeyRow(lane, FIRST));
  shot('before-quit');

  // Quit as a person would, so the web view writes its storage out.
  await lane.front();
  if (PLATFORM === 'mac') await app.key('q', ['cmd']);
  else await app.key('f4', ['alt']).catch(async () => app.key('F4', ['alt']));
  const exited = await until(
    'the app to quit',
    async () => child.exitCode !== null || child.signalCode !== null,
    30_000,
    500,
  )
    .then(() => true)
    .catch(() => false);
  setup.note('app quit by its own shortcut', exited);
  if (!exited) child.kill();
  await sleep(2_000);
  rows.push(storageRow());
} catch (error) {
  setup.error = error.message;
  setup.note('error', error.message);
  shot('setup-failure');
} finally {
  await reader?.stop?.();
  if (child && child.exitCode === null) child.kill();
  native.close();
  writeFileSync(join(out, 'helper-stderr.txt'), native.stderr.join(''));
  await fixture.close();
}

facts.modelRequests = requests();
facts.helperRestarts = native.restarts;
const report = {
  facts,
  rows: rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    error: row.error,
    observations: row.observations,
  })),
};
writeFileSync(join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);

const lines = [`# Native acceptance: ${options.lane}`, '', '| Row | Status |', '| --- | --- |'];
for (const row of report.rows) lines.push(`| ${row.id} ${row.title} | ${row.status} |`);
lines.push('', '## Facts', '', '```json', JSON.stringify(facts, null, 2), '```', '');
for (const row of report.rows) {
  lines.push(`## ${row.id}: ${row.title} (${row.status})`, '');
  if (row.error) lines.push(`Error: ${row.error}`, '');
  for (const { label, value, expected, ok, blocked } of row.observations) {
    const shown = typeof value === 'string' ? value : JSON.stringify(value);
    const mark = blocked ? 'blocked' : ok === undefined ? 'note' : ok ? 'ok' : 'FAILED';
    lines.push(
      `- [${mark}] ${label}: \`${String(shown).slice(0, 600).replaceAll('`', "'")}\`${expected === undefined ? '' : ` (expected \`${JSON.stringify(expected)}\`)`}`,
    );
  }
  lines.push('');
}
writeFileSync(join(out, 'results.md'), lines.join('\n'));
console.log(lines.join('\n'));
process.exit(
  report.rows.every((row) => row.status === 'observed' || row.status.startsWith('partly blocked'))
    ? 0
    : 1,
);
