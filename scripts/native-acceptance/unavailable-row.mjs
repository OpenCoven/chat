// A familiar whose recorded chat can't be read: Chat says so on that familiar
// and keeps its composer locked, while every other familiar can still send.
// The row stages it by pointing a new familiar's entry in Chat's own record at
// a chat id Coven never issued, while Chat runs.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM, sleep, until, walk } from './driver.mjs';
import { Row, showFamiliars, shownText } from './rows.mjs';

export const THIRD = 'Wren';
export const UNREADABLE = "Coven couldn't load this chat";
const RECORD = 'chat-canonical-v1.json';

/** Chat's local data folder, where it records each familiar's chat. */
export function chatDataDir(platform = PLATFORM, env = process.env, home = homedir()) {
  if (platform === 'mac') return join(home, 'Library', 'Application Support', 'ai.opencoven.chat');
  if (platform === 'windows')
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ai.opencoven.chat');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'ai.opencoven.chat');
}

/** The record with `familiar` pointed at `missing`, a chat no one created. */
export function withUnreadableChat(heads, familiar, missing) {
  if (Object.hasOwn(heads, familiar)) throw new Error(`${familiar} already has a recorded chat`);
  return { ...heads, [familiar]: missing };
}

/** The record without the staged entry, leaving anything Chat changed meanwhile. */
export function withoutUnreadableChat(heads, familiar, missing) {
  if (heads[familiar] !== missing) return heads;
  const { [familiar]: _staged, ...rest } = heads;
  return rest;
}

function rewrite(path, change) {
  const next = change(JSON.parse(readFileSync(path, 'utf8')));
  writeFileSync(`${path}.native`, JSON.stringify(next));
  renameSync(`${path}.native`, path);
}

/** The id of the familiar the window shows as `shown` (Coven's `display_name`). */
export function idOf(familiars, shown) {
  return familiars.find((familiar) => (familiar.display_name ?? familiar.name) === shown)?.id;
}

function familiarId(cli, shown) {
  const listed = spawnSync(cli, ['familiars', '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (listed.status !== 0) throw new Error(`coven familiars --json failed: ${listed.stderr}`);
  return idOf(JSON.parse(listed.stdout), shown);
}

/**
 * What an alert says. AT-SPI keeps inline text in the alert's own Text
 * interface (`raw.text`), not in child nodes; the other platforms name
 * the children.
 */
export function textOfAlert(alert) {
  return [...walk(alert)]
    .map((node) => [node.raw?.text, shownText(node) || node.name].filter(Boolean).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What AT-SPI reports drawn at `node`'s first line of text, from the deepest
 * accessible up: what a screen reader's flat review finds there. Candidate run
 * 43003020997 showed WebKitGTK exposing the alert without its message in the
 * tree, while the message was on screen.
 */
async function textDrawnIn(app, node) {
  const frame = node.frame;
  if (PLATFORM !== 'linux' || !frame?.w || !frame?.h) return '';
  const at = [
    Math.round(frame.x + Math.min(40, frame.w / 4)),
    Math.round(frame.y + Math.min(17, frame.h / 2)),
  ];
  const answer = await app.native.call({ cmd: 'at', at, pid: app.pid });
  return (answer.chain ?? [])
    .map((entry) => [entry.text, entry.name].filter(Boolean).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Each node under `alert` as role, name and text, for a row that can't read it. */
export function alertOutline(alert) {
  return [...walk(alert)].map((node) =>
    [
      node.raw?.role ?? node.role,
      node.name && `"${node.name}"`,
      node.raw?.text && `text="${node.raw.text}"`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

async function alertText(app) {
  const said = [];
  for (const alert of await app.all('alert')) {
    const text = textOfAlert(alert);
    said.push(text.includes(UNREADABLE) ? text : `${text} ${await textDrawnIn(app, alert)}`.trim());
  }
  return said.join(' | ');
}

async function refreshCoven(lane) {
  await lane.front();
  await showFamiliars(lane);
  await lane.app.click(await lane.app.one('button', 'Refresh Coven'));
  await sleep(1_500);
}

export async function unavailableRow(lane, familiar) {
  const row = new Row(
    'v010-unavailable',
    "A familiar whose chat Coven can't load stays locked; the others still send",
  );
  const { app } = lane;
  const record = join(chatDataDir(), RECORD);
  const missing = `native-unavailable-${Date.now().toString(36)}`;
  let staged = false;
  return lane.attempt(row, async () => {
    try {
      if (!existsSync(record)) throw new Error(`Chat has no record at ${record} after its runs`);
      const created = spawnSync(lane.cli, ['familiars', 'create', '--json', '--', THIRD], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      row.note(
        `${THIRD} created with the installed CLI`,
        created.status === 0 ? 'yes' : created.stderr,
      );
      const third = familiarId(lane.cli, THIRD);
      if (!third) throw new Error(`Coven lists no familiar named ${THIRD}`);
      rewrite(record, (heads) => withUnreadableChat(heads, third, missing));
      staged = true;
      row.note('staged', `${THIRD}'s recorded chat is ${missing}, which Coven never issued`);

      await refreshCoven(lane);
      await app.click(await app.one('button', THIRD, { timeout: 30_000 }));
      const said = await until(
        `"${UNREADABLE}" on ${THIRD}`,
        async () => {
          const text = await alertText(app);
          return text.includes(UNREADABLE) ? text : null;
        },
        30_000,
        500,
      ).catch(async () => alertText(app));
      row.check(`${THIRD} says its chat couldn't load`, said.includes(UNREADABLE), said);
      if (!said.includes(UNREADABLE))
        row.note('alerts as the tree gives them', (await app.all('alert')).map(alertOutline));
      const fresh = new RegExp(`start of your conversation with ${THIRD}`);
      const shownAsNew = [...walk(await app.snapshot())].some((node) =>
        [node.name, node.value, node.raw?.text].some(
          (text) => typeof text === 'string' && fresh.test(text),
        ),
      );
      row.expect(`${THIRD}'s chat is shown as a new conversation`, shownAsNew, false);
      const locked = await app.one('textbox', `Message ${THIRD}`);
      row.expect(`${THIRD}'s composer is enabled`, locked.enabled, false);
      lane.shot('unavailable-chat');

      await showFamiliars(lane);
      await app.click(await app.one('button', familiar));
      const open = await until(
        `${familiar}'s composer to be enabled`,
        async () => {
          const composer = await app.one('textbox', `Message ${familiar}`);
          return composer.enabled ? composer : null;
        },
        30_000,
        500,
      )
        .then(() => true)
        .catch(() => false);
      row.expect(`${familiar}'s composer is enabled`, open, true);
      row.expect(
        `${familiar} shows "${UNREADABLE}"`,
        (await alertText(app)).includes(UNREADABLE),
        false,
      );
      // A real run on another familiar while this one's chat can't load.
      await lane.clearComposer(familiar);
      await lane.send(familiar, '[[table]] Show me the table.', 'button', 'Expand table');
      row.note(`${familiar} sent and got its reply`, 'Expand table rendered');
    } finally {
      if (staged) {
        rewrite(record, (heads) =>
          withoutUnreadableChat(heads, familiarId(lane.cli, THIRD), missing),
        );
        await refreshCoven(lane).catch(() => undefined);
      }
    }
  });
}
