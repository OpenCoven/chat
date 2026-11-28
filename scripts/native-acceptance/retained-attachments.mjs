// Run under private X11 and D-Bus sessions. See CONTRIBUTING.md for the two phases.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, Native, outline, sleep, until, walk } from './driver.mjs';
import { startModelFixture } from './fixture.mjs';

const [phase, binary, directory, cli] = process.argv.slice(2);
assert.ok(
  process.platform === 'linux' && ['seed', 'verify'].includes(phase) && binary && directory && cli,
  'Usage: node retained-attachments.mjs seed|verify <packaged executable> <disposable directory> <Coven 0.4.10 CLI>',
);
// What Chat v0.1.3's own setup leaves behind: Coven 0.4.10 in ~/.local/bin and
// the managed engine 0.9.1, installed by version and digest (v0.1.3 setup.rs).
const V013_ENGINE = ['0.9.1', 'f9e426e7fecc01696ff40a0cc2702cd4069b27daad53ff57fe49db49330e1b9f'];
const work = resolve(directory),
  home = join(work, 'home'),
  bin = join(home, '.local/bin');
const names = ['Amber', 'Birch'];
const contents = ['Amber attachment 700\n', 'Birch attachment 700\n'];
const filename = 'report.txt';
const env = {
  HOME: home,
  XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  DISPLAY: process.env.DISPLAY,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  XAUTHORITY: process.env.XAUTHORITY,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  PATH: bin + ':/usr/bin:/bin',
  LANG: 'C.UTF-8',
  COVEN_HOME: join(home, '.coven'),
  ANTHROPIC_API_KEY: 'local-attachment-fixture',
  GTK_MODULES: 'gail:atk-bridge',
  NO_AT_BRIDGE: '0',
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
};
if (phase === 'seed') {
  mkdirSync(home); // Require an unused profile.
  mkdirSync(bin, { recursive: true });
  copyFileSync(resolve(cli), join(bin, 'coven'));
  chmodSync(join(bin, 'coven'), 0o755);
  const [version, sha256] = V013_ENGINE;
  execFileSync(
    join(bin, 'coven'),
    ['engine', 'install', '--version', version, '--sha256', sha256],
    { env, stdio: 'inherit' },
  );
  for (const name of names)
    execFileSync(resolve(cli), ['familiars', 'create', '--json', '--', name], { env });
} else {
  assert.equal(readFileSync(join(work, 'seed-complete'), 'utf8'), filename);
}
const model = await startModelFixture({ log: join(work, 'requests.jsonl') });
env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + model.port;
const helper = join(dirname(fileURLToPath(import.meta.url)), 'linux/native_driver.py');
const native = new Native('/usr/bin/python3', [helper]);
let proc, app;
const data = join(env.XDG_DATA_HOME, 'ai.opencoven.chat');
const state = async () => outline(await app.snapshot()).join('\n');
const accessibleText = (root) =>
  [...walk(root)]
    .map((node) => [node.name, node.value, node.raw.text].filter(Boolean).join(' '))
    .join('\n');
async function press(role, name) {
  const target = await app.one(role, name, { timeout: 45000 });
  await app.click(target);
}
const runtimeFacts = () => {
  const coven = join(bin, 'coven');
  const run = (exe, args) => execFileSync(exe, args, { env, encoding: 'utf8' }).trim();
  const engine = run(coven, ['engine', 'which']);
  const adapter = JSON.parse(run(coven, ['adapter', 'list', '--json'])).find(
    (row) => row.id === 'coven-code',
  );
  return {
    coven: run(coven, ['--version']),
    engine,
    engineVersion: run(engine, ['--version']),
    runBudget: adapter?.run_budget ?? null,
  };
};
const setupSteps = [];
async function open() {
  const fd = openSync(join(work, phase + '-app.log'), 'a');
  proc = spawn(resolve(binary), [], { env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  await until(
    'packaged window',
    async () => {
      assert.equal(proc.exitCode, null);
      return (
        (await native.call({ cmd: 'target', pid: proc.pid })).ok &&
        (await native.call({ cmd: 'windows' })).windows?.length
      );
    },
    150000,
  );
  app = new App(native, proc.pid);
  await app.activate();
  // The candidate finds v0.1.3's Coven too old for run budgets, so its setup
  // offers Update Coven and then the engine. Each step is pressed once.
  const pressed = new Set();
  await until(
    'familiar rail or setup completion',
    async () => {
      for (const label of ['Update Coven', 'Update the engine', 'Continue to Chat']) {
        if (pressed.has(label) || !(await app.all('button', label)).length) continue;
        pressed.add(label);
        setupSteps.push(label);
        console.log('Setup offered ' + label);
        await press('button', label);
        return false;
      }
      return (
        (await app.all('button', names[0])).length || (await app.all('button', names[1])).length
      );
    },
    phase === 'verify' ? 20 * 60000 : 150000,
  );
}
// Every Coven Code chat must still send after the upgrade: one new turn in each.
async function sendAfterUpgrade(i) {
  await select(i);
  const reply = 'Second familiar here.';
  const before = accessibleText(await app.snapshot()).split(reply).length;
  await press('textbox', 'Message ' + names[i]);
  await app.type('[[other]] Upgrade check for ' + names[i] + '.');
  await app.key('Return');
  await until(
    names[i] + ' reply after the upgrade',
    async () => {
      const text = accessibleText(await app.snapshot());
      assert.ok(
        !text.includes("can't give Coven Code chats a model-round allowance"),
        'The upgraded Coven refused the run budget',
      );
      return text.split(reply).length > before && (await app.count('button', 'Stop run')) === 0;
    },
    180000,
  );
  console.log('Sent a Coven Code turn in ' + names[i] + ' after the upgrade');
}
async function close() {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await app.activate();
  await app.key('F4', ['alt']);
  await until('app exit', () => proc.exitCode !== null || proc.signalCode !== null, 35000);
}
function savedInputs() {
  const dir = join(data, 'coven-transcripts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    )
    .filter((e) => e.type === 'user' && e.source === 'chat-input' && e.attachments?.length);
}
function retainedPath(record) {
  assert.match(record.attachment_run_id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(record.attachments[0].name, filename);
  return join(data, 'coven-attachments', record.attachment_run_id, '0-' + filename);
}
async function select(i) {
  await press('button', names[i]);
  await app.one('textbox', 'Message ' + names[i], { timeout: 45000 });
}
async function send(i) {
  await select(i);
  const folder = join(work, names[i]);
  mkdirSync(folder);
  const file = join(folder, filename);
  writeFileSync(file, contents[i]);
  const xdo = (...args) => execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
  const editor = xdo('getactivewindow');
  await press('button', 'Attach file');
  const chooser = await until(
    'active GTK file chooser',
    () => {
      const id = xdo('getactivewindow');
      return id !== editor && /open|select|choose/i.test(xdo('getwindowname', id)) && id;
    },
    20000,
  );
  // GTK first maps its window and only then makes the location entry available.
  await sleep(800);
  xdo('key', '--clearmodifiers', 'ctrl+l');
  await sleep(400);
  xdo('key', '--clearmodifiers', 'ctrl+a');
  xdo('type', '--clearmodifiers', '--delay', '4', file);
  await sleep(700);
  for (let attempt = 0; attempt < 3 && xdo('getactivewindow') === chooser; attempt++) {
    xdo('key', '--clearmodifiers', 'Return');
    await sleep(900);
  }
  assert.equal(xdo('getactivewindow'), editor, 'file chooser did not return to the chat window');
  await app.one('button', 'Preview ' + filename, { timeout: 35000 });
  await press('textbox', 'Message ' + names[i]);
  await app.type('Inspect the attached report.');
  await app.key('Return');
  await until(
    'saved copy and finished turn',
    async () => {
      return (
        savedInputs().length === i + 1 &&
        (await app.count('button', 'Stop run')) === 0 &&
        accessibleText(await app.snapshot()).includes(filename)
      );
    },
    180000,
  );
  assert.ok(
    savedInputs().some((record) => readFileSync(retainedPath(record), 'utf8') === contents[i]),
    'expected staged bytes',
  );
  assert.equal(
    await app.count('button', 'Preview ' + filename),
    0,
    'published sent card unexpectedly has an action',
  );
  const list = await app.one(undefined, 'Message attachments');
  const card = [...walk(list)].find(
    (node) =>
      node !== list &&
      node.frame?.w > 0 &&
      node.frame?.h > 0 &&
      accessibleText(node).includes(filename),
  );
  assert.ok(card, 'published transcript did not expose the sent attachment');
  await app.click(card);
  assert.equal(
    await app.count('dialog', filename),
    0,
    'published sent card unexpectedly opened a preview',
  );
  console.log('Clicked inert published card for ' + names[i]);
}
// `key` is false for a click, or the key that opens the focused card.
async function preview(i, key = false, missing = false) {
  const card = await app.one('button', 'Preview ' + filename, { timeout: 60000 });
  if (key) {
    await app.click(card);
    await press('button', 'Close preview');
    assert.equal(await app.focusedName(), 'Preview ' + filename);
    await app.key(key);
  } else await app.click(card);
  await app.one('dialog', filename, { timeout: 30000 });
  await until(
    'preview contents',
    async () => {
      const text = accessibleText(await app.one('dialog', filename));
      if (missing)
        return (
          text.includes('attach the original file again') && !text.includes(contents[i].trim())
        );
      return text.includes(contents[i].trim()) && !text.includes(contents[1 - i].trim());
    },
    30000,
  );
  await press('button', 'Close preview');
  console.log(
    `Verified ${names[i]} with ${key || 'click'}: ${missing ? 'unavailable' : 'exact saved contents'}`,
  );
}
async function toggleArchived() {
  await press('button', 'Open settings');
  await press('button', 'Chats');
  await press('checkbox', 'Show archived chats');
  await press('button', 'Close settings');
}
try {
  await open();
  if (phase === 'seed') {
    for (let i = 0; i < 2; i++) await send(i);
    await close();
    writeFileSync(join(work, 'seed-complete'), filename);
    console.log('v0.1.3 runtime: ' + JSON.stringify(runtimeFacts()));
  } else {
    const facts = runtimeFacts();
    console.log('Upgraded runtime after ' + setupSteps.join(', ') + ': ' + JSON.stringify(facts));
    assert.ok(setupSteps.includes('Update Coven'), 'The candidate did not offer Update Coven');
    assert.deepEqual(facts.runBudget?.version, 1, 'The upgraded Coven declares no run budget');
    for (let i = 0; i < 2; i++) await sendAfterUpgrade(i);
    for (let launch = 0; launch < 2; launch++) {
      if (launch) await open();
      for (let i = 0; i < 2; i++) {
        await select(i);
        await preview(i, i === 1 && 'space');
      }
      if (!launch) await close();
    }
    await select(0);
    await press('button', 'Chat actions');
    await press('menuitem', 'Archive chat');
    await toggleArchived();
    await select(0);
    await preview(0, 'Return');
    await press('button', 'Restore chat');
    await toggleArchived();
    await select(0);
    await preview(0);
    const files = savedInputs().map(retainedPath);
    const removed = files.find((p) => readFileSync(p, 'utf8') === contents[0]);
    assert.ok(removed && basename(removed) === '0-' + filename);
    rmSync(removed);
    await preview(0, false, true);
    await select(1);
    await preview(1);
    const survivingFile = files.find((path) => existsSync(path));
    assert.ok(survivingFile && readFileSync(survivingFile, 'utf8') === contents[1]);
    await press('button', 'Chat actions');
    await press('menuitem', 'Delete chat');
    await press('button', 'Delete from Chat');
    await until('deleted chat removed its retained bytes', () => !existsSync(survivingFile));
    await close();
    await open();
    await select(0);
    await preview(0, false, true);
    assert.ok(!existsSync(survivingFile), 'relaunch restored a deleted attachment');
    console.log('Verified Delete from Chat removes the remaining retained file across relaunch.');
    await close();
    console.log(
      'Passed the Coven update, sends in both chats, same-name isolation, upgrade, restart, mouse, Space, Enter, archive, restore, and missing saved copy.',
    );
  }
} catch (error) {
  if (app) {
    writeFileSync(join(work, phase + '-tree.txt'), await state());
    console.error(
      'Focused X11 window:',
      spawnSync('xdotool', ['getactivewindow', 'getwindowname'], {
        encoding: 'utf8',
      }).stdout?.trim() || 'unavailable',
    );
  }
  throw error;
} finally {
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill();
  native.close();
  await model.close();
}
