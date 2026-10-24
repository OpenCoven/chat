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
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startModelFixture } from './model-fixture.mjs';
import { registerRecorder } from './platform.mjs';
import {
  composerOf,
  conversationLoaded,
  inspectorRow,
  linkRows,
  onFailure,
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
    // Windows test builds carry --remote-debugging-port in their WebView2 arguments.
    'debug-port': { type: 'string' },
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

// Product failures already filed. Such a row is reported as a known failure and
// does not fail the lane; a listed failure that stops reproducing does, so the
// entry is removed once the issue is fixed.
const KNOWN = [
  {
    // Release AppImages are built on ubuntu-22.04; their bundled libraries break
    // the newer system curl. One built in the CI image (24.04) does not show it.
    row: 'setup',
    lane: /appimage, v\d/,
    issue: 525,
    error: /engine install did not finish/,
  },
];

// Rows a person still has to run, whatever this lane observes.
const HAND_RUN = [
  ['504-1', 'Native context menu contents on right-click; right-click at all on WebKitGTK'],
  ['504-2', 'Screen reader announces the link when focus returns (Narrator, Orca, VoiceOver)'],
  ['504-3', 'IME composition after a quote; a real drag-selection; Enter held on the action'],
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

/** A lane that cannot run here, for a reason outside the app's behaviour. */
class Blocked extends Error {}

const DEBUG_PORT = Number(options['debug-port'] ?? 9333);

/** True once the app's WebView2 answers on the remote debugging port. */
async function debuggerUp(timeout) {
  return until(
    'the WebView2 debugging port',
    async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok,
    timeout,
    500,
  )
    .then(() => true)
    .catch(() => false);
}

/**
 * Windows fallback. msedgedriver normally launches a WebView2 app with its
 * debugging switches in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and waits for
 * DevToolsActivePort. When that never appears, launch the app with a fixed
 * debugging port instead -- through that variable, then through WebView2's
 * per-user AdditionalBrowserArguments policy -- and attach by debuggerAddress,
 * which Microsoft documents for WebView2 apps. Which path worked is recorded.
 */
async function attachWindows(env, row, { builtIn = false } = {}) {
  const flag = `--remote-debugging-port=${DEBUG_PORT}`;
  const exe = options.application.split('\\').at(-1);
  const policy = 'HKCU\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const launch = (extra) =>
    spawn(options.application, [], { env: { ...env, ...extra }, stdio: 'ignore' });
  let app;
  let how;
  if (builtIn) {
    app = launch({});
    how = 'the WebView2 arguments of this test build';
    if (!(await debuggerUp(60_000))) {
      app.kill();
      throw new Error(`This test build did not open a WebView2 debugging port on ${DEBUG_PORT}.`);
    }
  } else {
    // A WebView2 browser process left from msedgedriver's attempt would be reused
    // with its own switches; give it time to exit with the app it served.
    await sleep(5_000);
    app = launch({ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flag });
    how = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS';
  }
  if (!builtIn && !(await debuggerUp(45_000))) {
    row.note(
      'debugging port through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
      'did not open in 45 s',
    );
    app.kill();
    await sleep(2_000);
    execFileSync('reg.exe', ['add', policy, '/v', exe, '/t', 'REG_SZ', '/d', flag, '/f']);
    app = launch({});
    how = `per-user WebView2 policy ${policy}\\${exe}`;
    if (!(await debuggerUp(45_000))) {
      app.kill();
      throw new Blocked(
        'WebView2 ignored the debugging switch from both WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and its per-user policy. wry sets AdditionalBrowserArguments for every Tauri 2 app, and this WebView2 lets that win, so a shipped Windows build cannot be attached to from outside.',
      );
    }
  }
  row.note('debugging port opened through', how);
  // Node will not spawn a .cmd without a shell, so start the driver itself
  // beside the logging wrapper tauri-driver uses, and ask it for the same log.
  const driverExe = join(dirname(options['native-driver']), 'msedgedriver.exe');
  const native = spawn(
    driverExe,
    ['--port=4446', '--verbose', `--log-path=${join(out, 'msedgedriver-attach.log')}`],
    { stdio: 'ignore' },
  );
  await until(
    'msedgedriver to listen',
    async () => (await fetch('http://127.0.0.1:4446/status')).ok,
    30_000,
    250,
  );
  const session = await Session.start('http://127.0.0.1:4446', {
    browserName: 'webview2',
    'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${DEBUG_PORT}` },
  });
  row.note('session', 'msedgedriver attached to the running app by debuggerAddress');
  return {
    session,
    close: () => {
      native.kill();
      app.kill();
      try {
        execFileSync('reg.exe', ['delete', policy, '/v', exe, '/f'], { stdio: 'ignore' });
      } catch {
        // Absent when the environment variable was enough.
      }
    },
  };
}

/**
 * Starts a session on the installed app: through tauri-driver, or on Windows by
 * attaching to the app's WebView2 when msedgedriver cannot launch it.
 */
async function openSession(env, row) {
  if (options['debug-port']) return attachWindows(env, row, { builtIn: true });
  driver = await startDriver(env);
  try {
    const session = await Session.start(driver.base, {
      'tauri:options': { application: options.application },
    });
    row.note('session', 'tauri-driver launched the app');
    return { session, close: () => undefined };
  } catch (error) {
    if (process.platform !== 'win32' || !/DevToolsActivePort/.test(error.message)) throw error;
    row.note('tauri-driver session', error.message);
    return attachWindows(env, row);
  }
}

/**
 * After a failed setup on Linux, compares the engine install under the running
 * app's own environment with a plain one, so a failure can be pinned on the
 * host (an AppImage's environment, say) or on the network.
 */
function diagnoseSetup(row) {
  if (process.platform !== 'linux') return;
  // The AppImage runtime starts the app as a child; read the app binary itself.
  const pid = tryRun('pgrep', ['-n', '-x', 'opencoven-chat']).split('\n')[0];
  if (!/^\d+$/.test(pid)) {
    row.note('app environment', 'no running opencoven-chat process');
    return;
  }
  const appEnv = Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
  );
  row.note('app process', tryRun('readlink', [`/proc/${pid}/exe`]));
  const keys = new Set([...Object.keys(appEnv), ...Object.keys(process.env)]);
  const differing = [...keys]
    .filter((key) => appEnv[key] !== process.env[key])
    .sort()
    .map((key) =>
      /KEY|TOKEN|SECRET|PASSWORD/i.test(key)
        ? `${key}=<redacted>`
        : `${key}=${appEnv[key] === undefined ? '<unset>' : appEnv[key].slice(0, 300)}`,
    );
  row.note(`app environment that differs from the suite (pid ${pid})`, differing);
  const install = (env) => {
    try {
      return execFileSync(covenCli(), ['engine', 'install', '--force'], {
        encoding: 'utf8',
        env,
        timeout: 300_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n')
        .at(-1);
    } catch (error) {
      return `failed (${error.status}): ${`${error.stderr ?? ''}`.trim().split('\n').slice(-3).join(' / ')}`;
    }
  };
  const engineUrl =
    'https://github.com/OpenCoven/coven-code/releases/download/v0.8.0/coven-code-linux-x86_64.tar.gz';
  const fetchEngine = (env) => {
    try {
      execFileSync('curl', ['-fsSL', '-o', '/dev/null', engineUrl], {
        env,
        timeout: 120_000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return 'downloaded';
    } catch (error) {
      return `failed (${error.status}): ${`${error.stderr ?? ''}`.trim().slice(0, 400)}`;
    }
  };
  row.note('curl of the engine with the app environment', fetchEngine({ ...appEnv }));
  row.note('curl of the engine with a plain environment', fetchEngine(process.env));
  row.note('coven engine install with the app environment', install({ ...appEnv }));
  row.note('coven engine install with a plain environment', install(process.env));
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
  // Progress lines are kept, since the alert carries only the last one.
  const progress = [];
  const next = (what, role, label, timeout) =>
    until(
      what,
      async () => {
        for (const status of await s.css('.coven-onboarding-run-status')) {
          const line = (await status.text()).trim();
          if (line && progress.at(-1) !== line) progress.push(line);
        }
        const alerts = await s.all('alert');
        if (alerts.length) throw new Stop(`Setup reported: ${await alerts[0].text()}`);
        const found = await s.all(role, label);
        return found.length === 1 ? found[0] : null;
      },
      timeout,
      200,
    ).catch((error) => {
      setupRow.note('setup progress lines', progress.slice(-40));
      throw new Error(`${what}: ${error.message}`);
    });
  // Install Coven carries straight on to the engine. The familiar form appears
  // as soon as Coven is in, so wait for the engine step itself to finish.
  await (await s.one('button', 'Install Coven')).click();
  await next('Install Coven, then its engine', 'heading', 'Coven engine (done)', 20 * 60_000);
  setupRow.note('Install Coven', 'Coven and then its engine installed');
  setupRow.note('setup progress lines', progress.slice(-40));
  const name = await s.one('textbox', 'Familiar name');
  await name.click();
  await name.type(FIRST);
  await (await s.one('button', 'Create familiar')).click();
  // Setup opens the chat by itself once it is complete. "Continue to Chat" is
  // offered earlier, with no familiar yet, so it is never pressed here.
  await next('Create familiar', 'textbox', `Message ${FIRST}`, 120_000);
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
  ...opened.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}`,
  ANTHROPIC_API_KEY: 'sk-ant-packaged-acceptance-fixture',
};
const rows = [];
let driver;
let attached;
let session;
let userAgent = 'unknown';
const setupRow = { id: 'setup', title: 'First-run setup through the window', observations: [] };
setupRow.note = (label, value) => setupRow.observations.push({ label, value });
setupRow.note('system browser registration', `${opened.handler} via ${opened.opener}`);
rows.push(setupRow);

try {
  attached = await openSession(env, setupRow);
  session = attached.session;
  onFailure(async (id) => {
    try {
      writeFileSync(join(out, `${id}.png`), Buffer.from(await session.screenshot(), 'base64'));
    } catch {
      // A screenshot is a convenience; its absence is not evidence of anything.
    }
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
  rows.push(await rightClickRow(session, FIRST, opened));
} catch (error) {
  setupRow.error = error.message;
  if (error instanceof Blocked) setupRow.blocked = true;
  if (/^Install Coven/.test(error.message)) diagnoseSetup(setupRow);
} finally {
  for (const row of rows) {
    const known = KNOWN.find(
      (entry) => entry.row === row.id && entry.lane.test(options.lane) && !row.blocked,
    );
    row.status = row.blocked
      ? 'blocked'
      : row.notJudged
        ? `not judged: ${row.notJudged}`
        : row.error
          ? known?.error.test(row.error)
            ? `known failure (#${known.issue})`
            : 'failed'
          : row.skipped
            ? 'not reached'
            : known
              ? `observed, but #${known.issue} is listed as failing here: remove it from KNOWN`
              : 'observed';
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
  attached?.close();
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
process.exit(
  report.rows.every(
    (row) =>
      row.status === 'observed' ||
      row.status.startsWith('known failure') ||
      row.status.startsWith('not judged'),
  )
    ? 0
    : 1,
);
