// Run in the checkout whose desktop send behavior is being qualified.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App, Native, outline, until } from './driver.mjs';
import { startModelFixture } from './fixture.mjs';
import { Lane } from './rows.mjs';

assert.equal(process.platform, 'darwin', 'This command uses the macOS native driver.');
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, { encoding: 'utf8', ...options }).trim();
mkdirSync('.artifacts/installer-pin', { recursive: true });
const out = mkdtempSync(resolve('.artifacts/installer-pin/run-'));
console.log(out);
const target = resolve('src-tauri/target');
execFileSync(
  'corepack',
  [
    'pnpm',
    'app:build',
    '--debug',
    '--no-bundle',
    '--config',
    JSON.stringify({ identifier: 'ai.opencoven.chat.qa.installerpin' }),
  ],
  {
    env: { ...process.env, CARGO_TARGET_DIR: target },
    stdio: 'inherit',
  },
);
const facts = { revision: run('git', ['rev-parse', 'HEAD']), outcome: 'incomplete' };
const home = join(out, 'home');
const bin = join(home, '.local/bin');
mkdirSync(bin, { recursive: true });
const env = { HOME: home, COVEN_HOME: join(home, '.coven'), PATH: '/usr/bin:/bin' };
const source = readFileSync('src-tauri/src/coven_install.rs', 'utf8');
const version = source.match(/const COVEN_VERSION: &str = "([^"]+)"/)[1];
const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
const asset = `coven-v${version}-macos-${arch}.tar.gz`;
const sha = source.split(`"${asset}",`)[1]?.match(/^\s*"([0-9a-f]{64})"/)?.[1];
assert.ok(sha, 'Cannot identify the installer digest');
run('curl', [
  '-fsSL',
  '--retry',
  '3',
  '-o',
  join(out, asset),
  `https://github.com/OpenCoven/coven/releases/download/v${version}/${asset}`,
]);
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(out, asset)))
    .digest('hex'),
  sha,
);
run('tar', ['-xzf', join(out, asset), '-C', bin]);
const cli = join(bin, 'coven');
run(cli, ['familiars', 'create', '--json', '--', 'Finch'], { env });
const helper = join(out, 'native-mac');
run('swiftc', ['-O', 'scripts/native-acceptance/mac/NativeDriver.swift', '-o', helper]);
const native = new Native(helper, []);
const log = join(out, 'requests.jsonl');
writeFileSync(log, '');
const fixture = await startModelFixture({ log });
let child;
let app;
try {
  assert.ok((await native.call({ cmd: 'trust' })).accessibility, 'Accessibility access required');
  const fd = openSync(join(out, 'app.log'), 'w');
  child = spawn(resolve('src-tauri/target/debug/opencoven-chat'), [], {
    env: {
      ...env,
      CFFIXED_USER_HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}`,
      ANTHROPIC_API_KEY: 'sk-ant-installer-pin-fixture',
    },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  await until(
    'the isolated candidate window',
    async () => {
      assert.equal(child.exitCode, null, 'Candidate exited');
      return (
        (await native.call({ cmd: 'target', pid: child.pid })).ok &&
        (await native.call({ cmd: 'windows' })).windows?.length
      );
    },
    60_000,
  );
  app = new App(native, child.pid);
  await app.activate();
  await app.click(await app.one('button', 'Install the engine', { timeout: 60_000 }));
  await until(
    'Chat setup to open the conversation',
    async () => {
      if (await app.count('textbox', 'Message Finch')) return true;
      const next = await app.all('button', 'Continue to Chat');
      if (next.length) await app.click(next[0]);
      return false;
    },
    120_000,
  );
  const engine = run(cli, ['engine', 'which'], { env });
  assert.ok(engine.startsWith(`${home}/`), 'Expected a managed engine in the disposable home');
  const versions = run(cli, ['--version'], { env });
  const engineVersion = run(engine, ['--version'], { env });
  Object.assign(facts, { cli, versions, engine, engineVersion, asset, sha });
  const lane = new Lane({ app, native });
  await lane.idle();
  await app.click(await lane.composer('Finch'));
  await app.type('[[reviewrace]]');
  assert.equal(await lane.composerValue('Finch'), '[[reviewrace]]');
  await app.click(await app.one('button', 'Send'));
  await until(
    'the streamed reply',
    async () => {
      const rejection = (await app.all('text'))
        .map((node) => node.value)
        .find(
          (value) =>
            typeof value === 'string' &&
            value.includes('This Coven CLI cannot apply finite model-round budgets'),
        );
      if (rejection) {
        facts.outcome = 'run-budget capability rejected';
        facts.message = rejection;
        throw new Error(rejection);
      }
      return app.count('link', 'Completion boundary');
    },
    90_000,
  );
  // The model stream stays open while the native processes are inspected.
  const processes = run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,comm='])
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3] }]
        : [];
    });
  let parent = processes.find((row) => row.executable === engine);
  assert.ok(parent, 'The expected engine did not handle the model request');
  const chain = [];
  while (parent && parent.pid !== child.pid) {
    chain.push(parent.executable);
    parent = processes.find((row) => row.pid === parent.parent);
  }
  Object.assign(facts, { chain });
  assert.ok(parent && chain.includes(cli), 'Expected Chat to run the released CLI and engine');
  assert.equal(fixture.finishReview(), 1);
  await lane.idle();
  assert.ok(await app.count('link', 'Completion boundary'), 'Expected the completed transcript');
  facts.outcome = 'completed';
} finally {
  const requests = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const count = requests.filter((row) => row.path === '/v1/messages').length;
  facts.providerRequests = count;
  try {
    const tree = await app?.snapshot();
    if (tree) {
      const transcript = outline(tree).join('\n');
      writeFileSync(join(out, 'last-tree.txt'), transcript);
    }
    writeFileSync(join(out, 'result.json'), JSON.stringify(facts, null, 2));
    console.log(facts);
  } finally {
    child?.kill();
    native.close();
    await fixture.close();
  }
}
assert.ok(facts.providerRequests > 0, 'Expected a model request');
