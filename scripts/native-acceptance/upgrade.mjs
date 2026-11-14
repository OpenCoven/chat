// Row 578, on the Windows lane: what v0.0.8 saved in WebView2's autofill is
// gone once the build under test is installed over v0.0.8 and started.
//
// v0.0.8 left WebView2's general autofill on (#546). On this lane it saved what
// the composer held through a cancelled run in EBWebView\Default\Web Data
// (row 504-7's quote, in every v0.0.8 run). v0.0.9 turned autofill off but left
// those entries on disk; the build under test clears them when it starts.
//
// v0.0.8's first screen is setup, with no text field until Coven is installed,
// and installing Coven would end the fresh profile the other rows need. So this
// row runs last. By then the profile has Coven 0.4.10, the pin v0.0.8 shares,
// and two familiars, so v0.0.8 opens straight to the chat. Installing v0.0.8
// over the build under test is staging. The step judged is the upgrade a person
// makes: the build under test installed over v0.0.8, then started.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sleep, until } from './driver.mjs';
import { Lane, Row, showFamiliars } from './rows.mjs';
import { browserFiles, containing, sqlitePlaces } from './storage.mjs';

/** Synthetic, and typed by no other row. */
export const UPGRADE_PHRASE = 'Autofill left by v0.0.8';
/** msiexec's success codes: done, and done but a restart is wanted. */
const INSTALLED = new Set([0, 3010]);

const home = homedir();
const shown = (path) => path.replace(home, '~');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function productVersion(exe) {
  try {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
  } catch (error) {
    return `unread (${String(error.message).split('\n')[0]})`;
  }
}

function msiexec(args, log) {
  const result = spawnSync('msiexec.exe', [...args, '/qn', '/norestart', '/l*v', log], {
    timeout: 15 * 60_000,
  });
  return result.status ?? `unfinished (${result.error?.message ?? result.signal})`;
}

/** Waits for WebView2 to let go of the profile after the app has quit. */
function webViewGone() {
  return until(
    'the web view processes to exit',
    async () =>
      !/msedgewebview2\.exe/i.test(
        execFileSync('tasklist', ['/FI', 'IMAGENAME eq msedgewebview2.exe', '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          timeout: 20_000,
        }),
      ),
    30_000,
    1_000,
  )
    .then(() => true)
    .catch(() => false);
}

function transcripts() {
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const folder = join(local, 'ai.opencoven.chat', 'coven-transcripts');
  return existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith('.jsonl')).length
    : 0;
}

/** The `Web Data` files (and their journals) that hold the phrase, with where it sits. */
function webDataHits(row, when) {
  const all = browserFiles();
  const hits = containing(all, UPGRADE_PHRASE);
  row.note(
    `${when}: Web Data files`,
    all.filter((path) => basename(path).startsWith('Web Data')).map(shown),
  );
  row.note(`${when}: browser storage files containing "${UPGRADE_PHRASE}"`, hits.map(shown));
  const webData = hits.filter((path) => basename(path).startsWith('Web Data'));
  for (const path of webData.filter((each) => basename(each) === 'Web Data'))
    row.note(`${when}: where it sits in ${shown(path)}`, sqlitePlaces(path, UPGRADE_PHRASE));
  return webData.map(shown);
}

/** The chat or the setup screen, whichever the window shows first. */
function firstScreen(app) {
  return until(
    'the chat or the setup screen',
    async () => {
      if (await app.count('heading', 'Set up Coven Chat')) return 'setup';
      return (await app.all('textbox', /^Message /))[0]?.name ?? null;
    },
    120_000,
    1_000,
  );
}

/**
 * `from` is the published v0.0.8 MSI and `to` the build under test's, both
 * checked by the lane. `launch(log)` starts the installed app and returns
 * `{ app, child }`; `quit(app, child)` quits it with its own shortcut.
 */
export async function autofillUpgradeRow({
  from,
  to,
  exe,
  installedSha,
  launch,
  quit,
  native,
  shot,
  out,
  familiars: [first, second],
  resolveInstalledExe = () => exe,
  installMsi = msiexec,
  waitForWebViewGone = webViewGone,
  getProductVersion = productVersion,
}) {
  const row = new Row('578', 'Autofill an earlier version saved is cleared on upgrade');
  let running = null;
  try {
    row.note('installers', { from: from.label, to: to.label });
    row.note('web view processes gone before v0.0.8', await waitForWebViewGone());

    // Staging: v0.0.8 over the build under test. If the installer refuses the
    // downgrade, the build under test is removed first; Chat's data stays.
    let code = installMsi(['/i', from.path], join(out, 'msiexec-v0.0.8.log'));
    if (!INSTALLED.has(code)) {
      row.note('v0.0.8 over the build under test', `msiexec ${code}; removing it first`);
      installMsi(['/x', to.path], join(out, 'msiexec-remove.log'));
      code = installMsi(['/i', from.path], join(out, 'msiexec-v0.0.8.log'));
    }
    row.check('v0.0.8 installed', INSTALLED.has(code), `msiexec ${code}`);
    const oldExe = resolveInstalledExe();
    const oldVersion = getProductVersion(oldExe);
    row.note('installed app', { version: oldVersion, sha256: sha256(oldExe) });
    row.check('v0.0.8 is the installed app', oldVersion.startsWith('0.0.8'), oldVersion);

    running = await launch('app-v0.0.8.log', oldExe);
    const lane = new Lane({ app: running.app, native, shot, requests: () => 0, tokens: () => 0 });
    const screen = await firstScreen(lane.app);
    row.note('v0.0.8 first screen', screen);
    if (screen === 'setup') throw new Error('v0.0.8 opened setup, not the chat');
    if (screen !== `Message ${first}`) {
      await showFamiliars(lane, row);
      await lane.app.click(await lane.app.one('button', first));
      await lane.composer(first);
    }

    // What v0.0.8 saved on every run of this lane: the composer's text when
    // Stop run disabled it (row 504-7's quote). Here the phrase is typed.
    await lane.idle();
    await lane.app.click(await lane.composer(first));
    await lane.app.type('[[slow]] One more slow reply.');
    await lane.app.click(await lane.app.one('button', 'Send'));
    await lane.app.one('button', 'Stop run', { timeout: 60_000 });
    await sleep(4_000);
    await lane.app.click(await lane.composer(first));
    await lane.app.type(UPGRADE_PHRASE);
    await until(
      `the draft to read "${UPGRADE_PHRASE}"`,
      async () => (await lane.composerValue(first)) === UPGRADE_PHRASE,
      10_000,
    );
    await lane.app.click(await lane.app.one('button', 'Stop run'));
    await lane.idle();
    await sleep(3_000);
    row.note('v0.0.8 composer after Stop run', await lane.composerValue(first));

    // Left on the second familiar, so the next start shows whether local
    // storage (opencoven.chat.navigation.v1) outlived the clear.
    let left = first;
    if (second) {
      await showFamiliars(lane, row);
      const button = (await lane.app.all('button', second))[0];
      if (button) {
        await lane.app.click(button);
        await lane.composer(second);
        left = second;
        // Local storage reaches disk a few seconds after a change.
        await sleep(6_000);
      }
    }
    row.note('v0.0.8 left on', left);
    shot('578-v0.0.8');
    row.note('v0.0.8 quit by its own shortcut', await quit(lane.app, running.child));
    running = null;
    row.note('web view processes gone after v0.0.8', await webViewGone());

    const saved = webDataHits(row, 'after v0.0.8');
    if (saved.length) row.note('precondition: v0.0.8 saved the phrase in Web Data', saved);
    else row.block('precondition', 'v0.0.8 did not save the phrase in Web Data');
    const kept = transcripts();
    row.note('transcripts before the upgrade', kept);

    // The upgrade: the build under test installed over v0.0.8, then started.
    code = installMsi(['/i', to.path], join(out, 'msiexec-upgrade.log'));
    row.check('the build under test installed over v0.0.8', INSTALLED.has(code), `msiexec ${code}`);
    const upgradedExe = resolveInstalledExe();
    row.expect('the build under test is the installed app again', sha256(upgradedExe), installedSha);
    row.note('installed app', { version: getProductVersion(upgradedExe) });
    running = await launch('app-upgraded.log', upgradedExe);
    lane.app = running.app;
    const reopened = await firstScreen(lane.app);
    row.expect(
      `the upgraded app reopens on ${left}, the familiar v0.0.8 left selected (local storage kept)`,
      reopened,
      `Message ${left}`,
    );
    if (left === first)
      row.note('local storage', `${second ?? 'a second familiar'} was not in v0.0.8's rail`);
    // The clear is asked for at start and finishes on its own.
    await sleep(10_000);
    shot('578-upgraded');
    row.note('upgraded app quit by its own shortcut', await quit(lane.app, running.child));
    running = null;
    row.note('web view processes gone after the upgrade', await webViewGone());

    const after = webDataHits(row, 'after the upgrade');
    if (saved.length) row.expect(`Web Data files containing "${UPGRADE_PHRASE}"`, after, []);
    row.expect('transcripts after the upgrade', transcripts(), kept);
  } catch (error) {
    row.error = error.message;
    row.note('error', error.message);
    shot('578-failure');
  } finally {
    if (running && running.child.exitCode === null) running.child.kill();
  }
  return row;
}
