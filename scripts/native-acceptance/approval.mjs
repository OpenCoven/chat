// Asking for permission (#542), driven through the window with native input
// (#573). The fixture asks the real engine to write a real file on every turn, so
// the file on disk, not the window, says what each turn could do. The paired
// phone is the lane's stand-in (phone.mjs), talking to the companion's own API.
//
// Which rows run follows the build: `approvalRows` when asking is switched on in
// it, `askingOffRow` when it is off (`ASKING_ENABLED` in
// `src-tauri/src/chat_approvals.rs`). run.mjs decides, and says so in the results.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sleep, until, walk } from './driver.mjs';
import {
  APPROVAL_DONE,
  APPROVAL_NO_NOTE,
  APPROVAL_REFUSED,
  APPROVAL_SUMMARY,
  APPROVAL_UNASKED,
  MOVED_ON,
} from './fixture.mjs';
import { Phone } from './phone.mjs';
import { closeSettings, Row, shownText, textsIn } from './rows.mjs';

export const ASKING_SOURCE = 'src-tauri/src/chat_approvals.rs';
export const ASKING_MODES = ['as-built', 'switched-on', 'rows-on-as-built'];

/**
 * Which rows a run drives, from the run's `asking` mode and the source the build
 * came from. `asking` rows when the build has asking on, or when the run asks for
 * them anyway (`rows-on-as-built`, to see them fail where asking is off);
 * `asking-off` when it is off; `none` when it can't be told, with the reason.
 * `switched-on` only applies to a candidate built on the runner.
 */
export function askingRowsFor({ mode = 'as-built', tag = '', source, error }) {
  const from = tag ? `${ASKING_SOURCE} at tag ${tag}` : `${ASKING_SOURCE} as built`;
  const none = (reason) => ({ mode, built: 'unknown', from, rows: 'none', reason });
  if (!ASKING_MODES.includes(mode)) return none(`unknown asking mode "${mode}"`);
  if (mode === 'switched-on' && tag)
    return none(
      'switched-on applies only to a candidate built on the runner, not a published release',
    );
  if (error) return mode === 'rows-on-as-built' ? { ...none(error), rows: 'asking' } : none(error);
  const built = /const ASKING_ENABLED: bool = (true|false);/.exec(source ?? '')?.[1] ?? 'unknown';
  if (built === 'unknown') {
    const reason = `${ASKING_SOURCE} has no ASKING_ENABLED switch`;
    return mode === 'rows-on-as-built' ? { ...none(reason), rows: 'asking' } : none(reason);
  }
  if (mode === 'switched-on' && built !== 'true')
    return { ...none(`switched-on was asked for, but the build reads ${built}`), built };
  const rows = mode === 'rows-on-as-built' || built === 'true' ? 'asking' : 'asking-off';
  return { mode, built, from, rows };
}

const heading = (familiar) => `${familiar} asks for permission`;
const railAsks = (familiar) => `${familiar} (asks for permission)`;
const ALLOWED_NOTE = 'You allowed this turn to change files';
const declinedLine = `You declined this request: ${APPROVAL_SUMMARY}`;

async function pageTexts(app) {
  return [...walk(await app.snapshot())].map(shownText).filter(Boolean);
}

async function pageHas(app, text) {
  return (await pageTexts(app)).some((line) => line.includes(text));
}

/** How many shown lines hold `text`. Compared before and after, never as a total. */
async function pageCount(app, text) {
  return (await pageTexts(app)).filter((line) => line.includes(text)).length;
}

/**
 * What the request card shows: the nearest container of its heading that holds
 * Allow once. The thread also shows the person's own words, which can match.
 */
async function cardTexts(app, familiar) {
  const [title] = await app.all('heading', heading(familiar));
  for (let node = title?.parent; node; node = node.parent)
    if ([...walk(node)].some((each) => each.role === 'button' && each.name === 'Allow once'))
      return textsIn(node);
  return [];
}

/** The folder the familiar's engine works in, as Chat shows it under the thread. */
async function familiarFolder(app) {
  const pattern = /^(Chat project|Familiar workspace): /;
  const line = (await pageTexts(app)).find((text) => pattern.test(text));
  if (!line) throw new Error("Chat did not show the familiar's folder.");
  return line.replace(pattern, '');
}

async function openSettingsSection(app, label) {
  await app.click(await app.one('button', 'Open settings'));
  await app.one('dialog', 'Settings');
  const buttons = await app.all('button', label, { within: ['dialog', 'Settings'] });
  const tab = buttons[0] ?? (await app.one('tab', label, { within: ['dialog', 'Settings'] }));
  await app.click(tab);
  await sleep(600);
}

/** Clicks a control once it can be used: Allow once waits for a run to end. */
async function press(app, name) {
  const control = await until(
    `${name} to be offered`,
    async () => {
      const found = await app.all('button', name);
      return found.length === 1 && found[0].enabled ? found[0] : null;
    },
    30_000,
    300,
  );
  await app.click(control);
}

/** A fresh path in the familiar's folder: an engine may refuse paths outside it. */
function proofIn(folder, name) {
  const path = resolve(join(folder, name));
  rmSync(path, { force: true });
  return path;
}

/** Turns the companion on through Settings › Devices and reads the pairing link. */
async function pairingLink(lane, row) {
  const { app } = lane;
  await openSettingsSection(app, 'Devices');
  await app.click(await app.one('button', 'iPhone companion'));
  await app.one('dialog', 'iPhone companion', { timeout: 10_000 });
  const off = await app.all('button', 'Turn on companion');
  if (off.length) await app.click(off[0]);
  const link = await until(
    'the private pairing link',
    async () => {
      const alerts = await app.all('alert', undefined, { within: ['dialog', 'iPhone companion'] });
      const said = alerts
        .flatMap((alert) => textsIn(alert))
        .join(' ')
        .trim();
      if (said) throw new Error(`The companion said: ${said}`);
      const boxes = await app.all('textbox', 'Private pairing link');
      const value = String(boxes[0]?.value ?? '');
      return value.startsWith('coven-chat://') ? value : null;
    },
    30_000,
    500,
  );
  row.note('companion', 'turned on in Settings › Devices; the link was read from its text box');
  await app.click(await app.one('button', 'Close companion'));
  await app.gone('dialog', 'iPhone companion').catch(() => app.key('escape'));
  await closeSettings(app);
  return link;
}

/** The newest permission log lines, as Settings › Access shows them. */
async function windowLog(app) {
  await openSettingsSection(app, 'Access');
  const list = await app.one('list', 'Permission log, newest first', { timeout: 10_000 });
  const lines = textsIn(list);
  await closeSettings(app);
  return lines.join('\n');
}

/**
 * Four rows with asking switched on. The phone is paired first so it can watch
 * every request: what it is told is checked each time the window shows or drops
 * a card, and one request is declined from it.
 */
export async function approvalRows(lane, familiar) {
  const { app } = lane;
  const allow = new Row('542-1', 'Allow once lets exactly one write land, and starts one turn');
  const decline = new Row('542-2', 'Decline lands nothing, from this window or the phone');
  const closes = new Row('542-3', 'Sending a new message closes the waiting request');
  const phoneRow = new Row('542-4', "The phone's view of requests matches the window's");
  const proofs = {};
  let folder = '';
  let phone = null;

  /** What the phone is told, checked against what the window shows. */
  const phoneSees = async (when, expected) => {
    if (!phone) return null;
    try {
      const snapshot = await phone.snapshot();
      phoneRow.expect(`the phone reads the Mac ${when}`, snapshot.status, 200);
      const pending = snapshot.json?.pendingApprovals ?? [];
      phoneRow.expect(`requests the phone is told about ${when}`, pending.length, expected);
      const open = pending[0];
      if (expected && open) {
        phoneRow.expect(`the request the phone shows ${when}`, open.summary, APPROVAL_SUMMARY);
        const whose = (snapshot.json?.familiars ?? []).find((item) => item.id === open.familiarId);
        phoneRow.check(
          `whose request the phone shows ${when}`,
          [whose?.displayName, whose?.name].some(
            (name) => String(name ?? '').toLowerCase() === familiar.toLowerCase(),
          ),
          whose ?? open.familiarId,
        );
      }
      return open ?? null;
    } catch (error) {
      phoneRow.check(`the phone reads the Mac ${when}`, false, error.message);
      return null;
    }
  };

  /** What the window shows while no request is open. */
  const nothingOpen = async (row, when) => {
    row.expect(`a request is shown ${when}`, await app.count('heading', heading(familiar)), 0);
    row.expect(`Allow once is offered ${when}`, await app.count('button', 'Allow once'), 0);
    row.expect(
      `the rail says ${familiar} asks ${when}`,
      await app.count('button', railAsks(familiar)),
      0,
    );
  };

  await lane.attempt(phoneRow, async () => {
    await lane.idle();
    await lane.reset();
    try {
      phone = new Phone(await pairingLink(lane, phoneRow));
    } catch (error) {
      // The companion is macOS and Linux only, and says so; anything else fails.
      if (!/requires macOS or Linux/.test(error.message)) throw error;
      phoneRow.block('pairing a phone', error.message);
      await lane.reset();
      return;
    }
    phoneRow.note('the phone connects to', phone.address);
    await phoneSees('before anyone asks', 0);
  });

  await lane.attempt(allow, async () => {
    await lane.idle();
    await lane.reset();
    folder = await familiarFolder(app);
    allow.note("the familiar's folder", folder);
    proofs.allowed = proofIn(folder, 'native-allowed.txt');
    const writesBefore = lane.steps('write');
    await lane.send(
      familiar,
      `[[ask ${proofs.allowed}]] Write the proof file.`,
      'heading',
      heading(familiar),
    );
    allow.expect('the read-only turn wrote the file', existsSync(proofs.allowed), false);
    const card = await cardTexts(app, familiar);
    allow.check(
      'the card shows the request',
      card.some((line) => line.includes(APPROVAL_SUMMARY)),
      card.slice(0, 8),
    );
    allow.expect(
      'the request block reads as prose',
      await pageHas(app, 'coven-permission-request'),
      false,
    );
    allow.expect(
      `the rail says ${familiar} asks`,
      await app.count('button', railAsks(familiar)),
      1,
    );
    const open = await phoneSees('while the window shows the request', 1);

    await press(app, 'Allow once');
    await until(
      'the allowed turn to report',
      async () => {
        const texts = await pageTexts(app);
        const refused = texts.find((line) => line.includes(APPROVAL_REFUSED));
        if (refused) throw new Error(refused);
        return texts.some((line) => line.includes(APPROVAL_DONE));
      },
      150_000,
      500,
    );
    await lane.idle();
    allow.check('the allowed turn wrote the file', existsSync(proofs.allowed));
    allow.expect(
      'what the file holds',
      existsSync(proofs.allowed) ? readFileSync(proofs.allowed, 'utf8') : null,
      'allowed turn\n',
    );
    allow.note('Write calls the model made across both turns', lane.steps('write') - writesBefore);
    allow.check('the thread says the turn had access', await pageHas(app, ALLOWED_NOTE));
    allow.check('the thread shows the click', await pageHas(app, `Allowed: ${APPROVAL_SUMMARY}`));
    await nothingOpen(allow, 'after the allowed turn');
    await phoneSees('after the allowed turn', 0);

    // The answer is spent: the phone can't use it to start another turn.
    if (open) {
      const settled = lane.requests();
      const again = await phone.answer(open.id, 'allow');
      allow.expect('the phone allowing the answered request again', again.status, 409);
      allow.note('what the Mac told the phone', again.json?.error ?? again.text);
      await sleep(3_000);
      allow.expect('model requests after that second allow', lane.requests(), settled);
    } else {
      allow.block('a second allow from the phone', 'the phone was not paired, or saw no request');
    }

    // Access ended with that turn: the next turn is read-only and has to ask again.
    proofs.again = proofIn(folder, 'native-again.txt');
    await lane.send(
      familiar,
      `[[ask ${proofs.again}]] Write another.`,
      'heading',
      heading(familiar),
    );
    allow.expect('the next turn wrote its file', existsSync(proofs.again), false);
    allow.expect(
      'the allowed turn left its file alone',
      existsSync(proofs.allowed) ? readFileSync(proofs.allowed, 'utf8') : null,
      'allowed turn\n',
    );
  });

  await lane.attempt(decline, async () => {
    if (!folder) throw new Error("not run: 542-1 did not find the familiar's folder");
    if (!proofs.again || !(await app.count('heading', heading(familiar)))) {
      // 542-1 failed before its second request; ask afresh.
      proofs.again = proofIn(folder, 'native-again.txt');
      await lane.send(
        familiar,
        `[[ask ${proofs.again}]] Write another.`,
        'heading',
        heading(familiar),
      );
    }
    await phoneSees('while the window shows the second request', 1);
    const before = lane.requests();
    const declined = await pageCount(app, declinedLine);
    await press(app, 'Decline');
    await until(
      'the decline to show in the thread',
      async () => (await pageCount(app, declinedLine)) > declined,
      30_000,
      500,
    );
    await nothingOpen(decline, 'after Decline');
    decline.expect('Decline is offered after Decline', await app.count('button', 'Decline'), 0);
    decline.expect('declining wrote the file', existsSync(proofs.again), false);
    await sleep(4_000);
    decline.expect('model requests after Decline', lane.requests(), before);
    await phoneSees('after Decline in the window', 0);

    // Declined from the phone: the window's card goes too, and nothing runs.
    if (!phone) {
      decline.block('Decline from the phone', 'the phone was not paired');
      return;
    }
    proofs.phone = proofIn(folder, 'native-phone.txt');
    await lane.send(
      familiar,
      `[[ask ${proofs.phone}]] Write from the phone.`,
      'heading',
      heading(familiar),
    );
    const open = await phoneSees('while the window shows the third request', 1);
    if (!open) throw new Error('the phone was told about no request to decline');
    const settled = lane.requests();
    const declinedHere = await pageCount(app, declinedLine);
    const answered = await phone.answer(open.id, 'decline');
    decline.expect('the phone declining', answered.status, 200);
    await app.gone('heading', heading(familiar), { timeout: 20_000 });
    await nothingOpen(decline, 'after Decline on the phone');
    await until(
      'the phone decline to show in the thread',
      async () => (await pageCount(app, declinedLine)) > declinedHere,
      20_000,
      500,
    )
      .then(() => decline.check('the thread shows the phone decline', true))
      .catch(() => decline.check('the thread shows the phone decline', false));
    decline.expect('declining on the phone wrote the file', existsSync(proofs.phone), false);
    await sleep(4_000);
    decline.expect('model requests after Decline on the phone', lane.requests(), settled);
    await phoneSees('after Decline on the phone', 0);
  });

  await lane.attempt(closes, async () => {
    if (!folder) throw new Error("not run: 542-1 did not find the familiar's folder");
    await lane.idle();
    await lane.reset();
    proofs.replaced = proofIn(folder, 'native-replaced.txt');
    await lane.send(
      familiar,
      `[[ask ${proofs.replaced}]] Write a third.`,
      'heading',
      heading(familiar),
    );
    closes.expect('the read-only turn wrote the file', existsSync(proofs.replaced), false);
    const open = await phoneSees('while the window shows the request a message replaces', 1);
    await lane.send(familiar, '[[moveon]] Never mind.', 'heading', MOVED_ON);
    await nothingOpen(closes, 'after the new message');
    closes.expect('the replaced request wrote its file', existsSync(proofs.replaced), false);
    await phoneSees('after the new message', 0);
    if (open) {
      const settled = lane.requests();
      const late = await phone.answer(open.id, 'allow');
      closes.expect('the phone allowing the replaced request', late.status, 409);
      await sleep(3_000);
      closes.expect('model requests after that late allow', lane.requests(), settled);
    } else {
      closes.block('a late allow from the phone', 'the phone was not paired, or saw no request');
    }
  });

  // The record of all of it, as the window and the phone read it.
  await lane.attempt(phoneRow, async () => {
    await lane.idle();
    await lane.reset();
    const shown = await windowLog(app);
    phoneRow.note('Settings › Access, permission log', shown);
    for (const [row, line] of [
      [allow, `Allowed on this computer for ${familiar}: ${APPROVAL_SUMMARY}`],
      [allow, `${familiar} used Write`],
      [allow, `${familiar}'s allowed turn finished.`],
      [decline, `Declined on this computer for ${familiar}: ${APPROVAL_SUMMARY}`],
      ...(phone ? [[decline, `Declined on iPhone for ${familiar}: ${APPROVAL_SUMMARY}`]] : []),
      [closes, `A new message replaced ${familiar}'s request: ${APPROVAL_SUMMARY}`],
    ])
      row.check(`Settings › Access says "${line}"`, shown.includes(line), shown.slice(0, 400));
    if (!phone) return;
    const log = await phone.permissionLog();
    phoneRow.expect('the phone reads the permission log', log.status, 200);
    const entries = log.json?.entries ?? [];
    const count = (test) => entries.filter(test).length;
    phoneRow.note(
      'permission log events, oldest first',
      [...entries]
        .reverse()
        .map(
          (entry) =>
            `${entry.event}${entry.device ? `:${entry.device}` : ''}${entry.tool ? `:${entry.tool}` : ''}`,
        ),
    );
    allow.expect(
      'times the log says a request was allowed',
      count((e) => e.event === 'allowed'),
      1,
    );
    allow.expect(
      'Write calls the log records from allowed turns',
      count((e) => e.event === 'action' && e.tool === 'Write'),
      1,
    );
    decline.expect(
      'declines the log records, by device',
      ['desktop', 'iphone'].map((device) =>
        count((e) => e.event === 'declined' && e.device === device),
      ),
      [1, 1],
    );
    closes.expect(
      'requests the log says a message replaced',
      count((e) => e.event === 'superseded'),
      1,
    );
    phoneRow.expect(
      'requests the log says were made',
      count((e) => e.event === 'requested'),
      4,
    );
  });

  return [allow, decline, closes, phoneRow];
}

/**
 * Asking is off in the build. A read-only turn writes nothing, and a reply that
 * carries a request block anyway offers nothing to answer, in the window or to a
 * paired phone, and Settings › Access shows no permission log.
 */
export async function askingOffRow(lane, familiar) {
  const { app } = lane;
  const row = new Row('asking-off', 'A read-only turn writes nothing and asks for nothing');
  const nothingOffered = async (when) => {
    // Chat reads for requests when a run ends, so give that a moment to show one.
    await sleep(1_500);
    row.expect(`a request is shown ${when}`, await app.count('heading', heading(familiar)), 0);
    row.expect(`Allow once is offered ${when}`, await app.count('button', 'Allow once'), 0);
    row.expect(`Decline is offered ${when}`, await app.count('button', 'Decline'), 0);
    row.expect(
      `the rail says ${familiar} asks ${when}`,
      await app.count('button', railAsks(familiar)),
      0,
    );
  };
  return lane.attempt(row, async () => {
    await lane.idle();
    await lane.reset();
    const folder = await familiarFolder(app);
    row.note("the familiar's folder", folder);
    const proof = proofIn(folder, 'native-asking-off.txt');
    await lane.send(
      familiar,
      `[[ask ${proof}]] Write the proof file.`,
      'heading',
      APPROVAL_NO_NOTE,
    );
    row.expect('the read-only turn wrote the file', existsSync(proof), false);
    await nothingOffered('after a refused write');

    const unasked = proofIn(folder, 'native-asking-off-unasked.txt');
    await lane.send(
      familiar,
      `[[ask ${unasked}]] [[request anyway]] Write another.`,
      'heading',
      APPROVAL_UNASKED,
    );
    row.expect('the second read-only turn wrote the file', existsSync(unasked), false);
    await nothingOffered('after a reply carrying a request');
    row.expect(
      'the request block reads as prose',
      await pageHas(app, 'coven-permission-request'),
      false,
    );

    try {
      const phone = new Phone(await pairingLink(lane, row));
      const snapshot = await phone.snapshot();
      row.expect('the paired phone reads the Mac', snapshot.status, 200);
      row.expect('requests the phone is told about', snapshot.json?.pendingApprovals?.length, 0);
    } catch (error) {
      row.block('what a paired phone is told', error.message);
      await lane.reset();
    }

    await openSettingsSection(app, 'Access');
    const access = textsIn(await app.one('dialog', 'Settings')).join('\n');
    row.expect(
      'Settings shows a permission log',
      access.toLowerCase().includes('permission log'),
      false,
    );
    await closeSettings(app);
  });
}
