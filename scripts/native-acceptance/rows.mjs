// #504's rows (and #515's browser rows) through native input and the platform
// accessibility tree. Each row records what it observed; an expectation that is
// not met fails the row, and anything the lane could not stage is recorded as
// blocked, never as passed.

import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { addressBars, browserProcesses, quitBrowsers } from './browser.mjs';
import {
  center,
  MOD,
  markClipboard,
  normalize,
  outline,
  PLATFORM,
  readClipboard,
  sleep,
  until,
  walk,
} from './driver.mjs';
import { ADDRESSES, TABLE, USERINFO } from './fixture.mjs';
import {
  checkSettingsSpeech,
  checkSettingsWidth,
  settingsWidthEvidence,
} from './settings-width.mjs';

export const REVIEW = 'Open this link?';
const GUIDE = 'https://docs.example.test/guide';

export class Row {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.observations = [];
    this.failures = 0;
    this.blockers = [];
  }
  note(label, value) {
    this.observations.push({ label, value });
  }
  expect(label, actual, expected) {
    const ok = isDeepStrictEqual(actual, expected);
    if (!ok) this.failures += 1;
    this.observations.push({ label, value: actual, expected, ok });
    return ok;
  }
  check(label, condition, value = condition) {
    if (!condition) this.failures += 1;
    this.observations.push({ label, value, ok: Boolean(condition) });
    return Boolean(condition);
  }
  block(label, reason) {
    this.blockers.push(label);
    this.observations.push({ label, value: reason, blocked: true });
  }
  get status() {
    if (this.error) return 'failed';
    if (this.failures) return 'failed';
    if (this.blockers.length) return `partly blocked (${this.blockers.join('; ')})`;
    return 'observed';
  }
}

/** Bounded native observations: absence alone cannot prove a click was missed. */
export class ReviewTrace {
  constructor(app, row) {
    this.app = app;
    this.row = row;
    this.started = Date.now();
    this.seen = false;
    this.outcome = 'not-observed';
    this.samples = 0;
  }
  async sample(phase) {
    const root = await this.app.snapshot();
    if (!root || !root.children?.length)
      throw new Error('The native review observation has no accessible tree');
    const nodes = [...walk(root)];
    const open = nodes.some((node) => node.role === 'dialog' && node.name === REVIEW);
    this.seen ||= open;
    this.outcome = open ? 'open' : this.seen ? 'opened-then-dismissed' : 'not-observed';
    if (this.samples++ < 16)
      this.row.note('link review lifecycle', {
        phase,
        ms: Date.now() - this.started,
        outcome: this.outcome,
        runControlVisible: nodes.some((node) => node.role === 'button' && node.name === 'Stop run'),
      });
    return open;
  }
}

/** Enforce completion focus, with an explicit native UIA measurement limit. */
export async function verifyCompletionFocus(app, row, platform = PLATFORM) {
  const focused = await app.focused();
  row.note(
    'focus after completion invalidation',
    focused && {
      role: focused.role,
      name: focused.name,
    },
  );
  if (platform === 'windows' && focused?.role === 'document') {
    // UIA reports document for the noninteractive focused log. Prove native
    // keyboard position using its unique first control instead of accepting
    // arbitrary document focus as a successful Messages-focus measurement.
    await app.one('button', 'Connection details', { within: ['group', 'Messages'] });
    row.note(
      'completion focus measurement',
      'UIA reports document; native keyboard navigation must resume at the first transcript control',
    );
    await app.key('tab');
    row.expect(
      'Tab from completion reaches first transcript control',
      await app.focusedName(),
      'Connection details',
    );
    await app.key('tab', ['shift']);
    row.expect(
      'Shift+Tab returns to the transcript document',
      (await app.focused())?.role,
      'document',
    );
    await app.key('tab');
    row.expect(
      'Tab again reaches first transcript control',
      await app.focusedName(),
      'Connection details',
    );
    return;
  }
  row.expect('completion invalidation returns focus to Messages', focused?.name, 'Messages');
}

async function clickReviewedLink(app, name, row) {
  const trace = new ReviewTrace(app, row);
  await trace.sample('before-click');
  // Resolve after idle, never reuse the live reply's old node or coordinates.
  await app.click(await linkNamed(app, name));
  try {
    await until('the link review to appear', () => trace.sample('after-click'), 15_000);
  } catch (error) {
    row.note('link review outcome at timeout', trace.outcome);
    throw error;
  }
  return trace;
}

/** The lane's shared state: the app, the model log, the screen reader, the output folder. */
export class Lane {
  constructor({ app, native, requests, tokens, reader, shot, save, cli, frames }) {
    Object.assign(this, { app, native, requests, tokens, reader, shot, save, cli, frames });
  }

  composer(familiar) {
    return this.app.one('textbox', `Message ${familiar}`, { timeout: 30_000 });
  }

  async composerValue(familiar) {
    return String((await this.composer(familiar)).value ?? '');
  }

  async clearComposer(familiar) {
    // Select-all outside the composer would select the whole page, and a later
    // drag that starts inside a selection moves it instead of selecting.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.app.click(await this.composer(familiar));
      if ((await this.app.focused())?.name === `Message ${familiar}`) break;
      await this.front();
    }
    if ((await this.app.focused())?.name !== `Message ${familiar}`)
      throw new Error(
        `the composer did not take focus (focus: ${(await this.app.focused())?.name})`,
      );
    await this.app.key('a', [MOD]);
    await this.app.key('delete');
    await until(
      'an empty draft',
      async () => (await this.composerValue(familiar)) === '',
      5_000,
    ).catch(() => undefined);
  }

  async idle() {
    await until(
      'the run to finish',
      async () => {
        const nodes = [...walk(await this.app.snapshot())];
        const composers = nodes.filter(
          (node) => node.role === 'textbox' && node.name?.startsWith('Message '),
        );
        return (
          !nodes.some((node) => node.role === 'button' && node.name === 'Stop run') &&
          composers.length === 1 &&
          composers[0].enabled === true
        );
      },
      90_000,
      500,
    );
  }

  /** Types into the real composer, presses Send, and waits for the reply to render. */
  async send(familiar, text, role, name, { complete = true } = {}) {
    await this.idle();
    await this.app.click(await this.composer(familiar));
    await this.app.type(text);
    await until(
      `the draft to read "${text}"`,
      async () => (await this.composerValue(familiar)) === text,
      10_000,
    );
    await this.app.click(await this.app.one('button', 'Send'));
    await until(
      `the reply's ${role} "${name}"`,
      async () => {
        const alerts = await this.app.all('alert');
        const failed = alerts.find((alert) => /fail|error|couldn/i.test(textIn(alert)));
        if (failed) throw new Error(`The run failed: ${textIn(failed)}`);
        return (await this.app.count(role, name)) > 0;
      },
      150_000,
      500,
    );
    // A rendered live link is not a completed reply. Reacquire it only after
    // the run and its transcript reload release the real composer.
    if (complete) await this.idle();
  }

  /** Closes whatever review, sheet or menu a failed step left open. */
  async reset() {
    await this.front().catch(() => undefined);
    // A row that failed while the window was small must not leave it small.
    if (this.frames) await this.app.setFrame(this.frames.wide).catch(() => undefined);
    for (let index = 0; index < 3; index += 1) await this.app.key('escape').catch(() => undefined);
    for (let index = 0; index < 3; index += 1) {
      const open = await this.app.all('dialog').catch(() => []);
      if (!open.length) break;
      const top = open.at(-1);
      const control = [...walk(top)].find(
        (node) =>
          node.role === 'button' && ['Close', 'Cancel', 'Close settings'].includes(node.name),
      );
      if (!control) break;
      await this.app.click(control).catch(() => undefined);
    }
  }

  /**
   * Puts any browser an Open started out of the way and brings Chat forward, so
   * keys and clicks land in Chat and not in the browser window above it.
   */
  async front() {
    // On macOS activating Chat raises it over the browser; the X and Windows
    // window managers can leave the browser on top, so it is minimised there.
    if (PLATFORM !== 'mac')
      for (const each of browserProcesses())
        await this.native.call({ cmd: 'hideApp', pid: each.pid });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.app.activate();
      await sleep(400);
      const front = await this.native.call({ cmd: 'frontmost' });
      if (!front.ok || !front.pid || front.pid === this.app.pid) return true;
    }
    return false;
  }

  async attempt(row, work) {
    try {
      await work();
    } catch (error) {
      row.error = error.message;
      row.note('error', error.message);
      this.shot(`${row.id}-failure`);
      row.note(
        'tree at the failure',
        (
          await this.app
            .snapshot()
            .then((root) => outlineOf(root))
            .catch(() => [])
        ).slice(0, 160),
      );
      await this.reset();
    }
    return row;
  }
}

const CONTROLS = new Set([
  'button',
  'link',
  'textbox',
  'radio',
  'checkbox',
  'separator',
  'menuitem',
]);

/**
 * The text a node shows a person. AT-SPI (WebKitGTK) keeps inline words in
 * their container's own text, beside its child objects (a "360px" next to a
 * Reset button), so any node that is not a control counts its own text.
 */
export function shownText(node) {
  if (node.role === 'text') return String(node.value ?? node.name ?? node.raw?.text ?? '').trim();
  if (!CONTROLS.has(node.role) && typeof node.raw?.text === 'string') return node.raw.text.trim();
  return '';
}

function textsIn(node) {
  return [...walk(node)].map(shownText).filter(Boolean);
}

function textIn(node) {
  return textsIn(node).join(' ').replace(/\s+/g, ' ').trim();
}

function outlineOf(root) {
  const lines = [];
  for (const node of walk(root)) {
    if (lines.length > 400) break;
    if (node.role === 'group' && !node.name) continue;
    lines.push(
      `${node.role}${node.name ? ` "${node.name.slice(0, 70)}"` : ''}${node.value !== undefined && node.value !== '' ? ` = ${JSON.stringify(String(node.value).slice(0, 50))}` : ''}${node.focused ? ' [focused]' : ''}`,
    );
  }
  return lines;
}

/** The review's facts as a person reads them: the text after "Site" and "Full address". */
async function reviewFacts(app) {
  const review = await app.one('dialog', REVIEW);
  const texts = textsIn(review);
  const after = (label) => {
    const index = texts.indexOf(label);
    return index >= 0 ? texts[index + 1] : null;
  };
  const statusNode = [...walk(review)].find((node) => node.role === 'status');
  return {
    review,
    texts,
    host: after('Site'),
    address: after('Full address'),
    status: statusNode
      ? textIn(statusNode) || statusNode.name
      : texts.filter((t) => /^(Copied|Sent|Sending|Chat asked|Chat couldn)/.test(t)).join(' '),
    open: [...walk(review)].find((node) => node.role === 'button' && node.name === 'Open') ?? null,
    buttons: [...walk(review)].filter((node) => node.role === 'button').map((node) => node.name),
  };
}

async function waitStatus(app, pattern, timeout = 10_000) {
  return until(
    `the review status to match ${pattern}`,
    async () => {
      const { status } = await reviewFacts(app);
      return pattern.test(status) ? status : null;
    },
    timeout,
  ).catch(async () => (await reviewFacts(app)).status);
}

/** Escape, with Chat in front; the review's own button, disclosed, if Escape did not close it. */
async function closeReview(lane, row) {
  await lane.front();
  await lane.app.key('escape');
  await lane.app.gone('dialog', REVIEW, { timeout: 4_000 }).catch(async () => {
    row?.note('Escape did not close the review; pressed its Cancel or Close button', true);
    await cancelReview(lane.app);
  });
}

/** The review's first button reads Cancel, and Close once Open has been pressed. */
async function cancelReview(app) {
  const buttons = await app.all('button', undefined, { within: ['dialog', REVIEW] });
  const first = buttons.find((node) => node.name === 'Cancel' || node.name === 'Close');
  if (!first) throw new Error('the review has no Cancel or Close button');
  await app.click(first);
  await app.gone('dialog', REVIEW);
}

/** A click on the link that opens its review; a second click if the first was absorbed. */
async function openReview(app, name, row) {
  await app.click(await linkNamed(app, name));
  const opened = await app
    .one('dialog', REVIEW, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) return;
  row?.note(`the first click on "${name}" did not open the review; clicked again`, true);
  await app.click(await linkNamed(app, name));
  await app.one('dialog', REVIEW);
}

/** Clicks a control that opens a dialog; a second click, disclosed, if the first was absorbed. */
async function openDialog(app, control, dialog, row) {
  // Inside the window is not enough: a control under the composer or the
  // header is covered, so it is brought to the middle of the thread first.
  const find = async () => (await app.all(control.role, control.name)).at(-1);
  await app.click(await app.middle(control, find));
  const opened = await app
    .one('dialog', dialog, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) return;
  row?.note(`the first click on "${control.name}" did not open "${dialog}"; clicked again`, true);
  await app.click(await app.middle(await find(), find));
  await app.one('dialog', dialog);
}

/** Escape until the platform reports no open menu. */
async function dismissMenus(lane) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const menus = await lane.native.call({ cmd: 'menus' });
    if (!menus.ok || !(menus.menus ?? []).length) return;
    await lane.app.key('escape');
    await sleep(400);
  }
}

/** A web view's page action, which would navigate or reload Chat's own window. */
const pageAction = (item) =>
  /^(back|forward|stop|reload|refresh|save as|print|more tools|inspect|view page source)\b/i.test(
    String(item).trim(),
  );

/**
 * The items of the context menu open after a right-click at `pressed`, read
 * through accessibility; empty when no open menu could be read.
 */
async function readMenu(lane, row, label, pressed) {
  const { native } = lane;
  // The menu can reach accessibility a moment after it is drawn.
  let menus = await native.call({ cmd: 'menus' });
  for (let read = 0; read < 6 && menus.ok && !(menus.menus ?? []).length; read += 1) {
    await sleep(500);
    menus = await native.call({ cmd: 'menus' });
  }
  row.note(label, menus.ok ? menus.menus : menus.error);
  let items = (menus.menus ?? []).flat();
  if (!items.length && PLATFORM === 'windows') {
    // WebView2's menu opens below and right of the press; what accessibility
    // reports at a point inside it names the menu's own items. A menu of one
    // item is short, so the first point is near its top.
    for (const [dx, dy] of [
      [40, 16],
      [40, 50],
    ]) {
      const probe = await native.call({ cmd: 'menuAt', at: [pressed[0] + dx, pressed[1] + dy] });
      row.note(`${label}: accessibility at +${dx},+${dy}`, probe.ok ? probe.at : probe.error);
      items = probe.at?.items ?? [];
      if (items.length) break;
    }
  }
  return items;
}

async function linkNamed(app, name) {
  return await until(`link "${name}"`, async () => (await app.all('link', name)).at(-1), 15_000);
}

const browserSnapshot = () => browserProcesses().map((row) => `${row.browser}:${row.pid}`);

async function waitForAddress(native, browser, address, timeout = 30_000, lane = null) {
  let last = [];
  try {
    return await until(
      `the browser to show ${address}`,
      async () => {
        last = await addressBars(native, browser);
        const hit = last.find(
          (window) =>
            window.fields.some(
              (field) => field.value === address || field.value === address.replace(/\/$/, ''),
            ) || window.documents.includes(address),
        );
        return hit ? last : null;
      },
      timeout,
      1_000,
    );
  } catch {
    // What the browser exposed, kept so a miss can be told from a reading gap.
    if (lane?.save) {
      for (const pid of new Set(browserProcesses().map((row) => row.pid))) {
        const answer = await native.call(
          PLATFORM === 'mac'
            ? { cmd: 'otherTree', pid, depth: 40 }
            : { cmd: 'tree', pid, depth: 40, budget: 4000 },
        );
        if (answer.ok)
          lane.save(`browser-tree-${pid}.txt`, outline(normalize(answer.tree)).join('\n'));
      }
    }
    return last;
  }
}

/**
 * Starts the platform screen reader, performs `act`, and returns what it said.
 * The reader runs only around the action, so its browse-mode keys never stand
 * between the lane's input and the app.
 */
async function listen(lane, row, label, act) {
  const reader = lane.reader;
  if (!reader) {
    row.block(label, 'no screen reader is available on this runner');
    await act();
    return null;
  }
  try {
    await reader.start();
  } catch (error) {
    row.block(label, `${reader.name} did not start: ${error.message}`);
    await act();
    return null;
  }
  await lane.app.activate();
  // The reader's own start-up speech finishes before the action is taken.
  if (reader.settle) await reader.settle();
  else await sleep(1_000);
  let mark;
  let said = [];
  try {
    mark = await reader.mark();
    await act();
    said = await reader.since(mark);
  } finally {
    await reader.stop();
    await sleep(2_000);
    await lane.app.activate();
  }
  // A log is complete only once its reader has quit and flushed it.
  if (reader.settled) said = reader.settled(mark);
  if (!said.length && reader.diagnostics)
    row.note(`${reader.name} diagnostics`, reader.diagnostics);
  return said;
}

/** #567 keeps the completion race under test instead of hiding it behind idle. */
export async function linkCompletionRow(lane, familiar, finishReview) {
  const row = new Row('567', 'Review opened while streaming, then invalidated at completion');
  const { app } = lane;
  await lane.attempt(row, async () => {
    const browsers = browserSnapshot();
    const trace = new ReviewTrace(app, row);
    try {
      await lane.send(
        familiar,
        '[[reviewrace]] Hold this link until it is reviewed.',
        'link',
        'Completion boundary',
        { complete: false },
      );
      row.expect('run still active before the review', await app.count('button', 'Stop run'), 1);
      await trace.sample('stream-held-before-click');
      await app.click(await linkNamed(app, 'Completion boundary'));
      await until('the held-stream review to appear', () =>
        trace.sample('stream-held-after-click'),
      );
      row.expect('review observed before model completion', trace.outcome, 'open');
      row.expect('held review address', (await reviewFacts(app)).address, ADDRESSES.query);
      lane.shot('567-review-before-completion');
      row.expect('one held model stream released', finishReview(), 1);
      await until(
        'the completion-invalidated review to close',
        async () => !(await trace.sample('completion-released')),
      );
      await lane.idle();
      row.expect('review lifecycle at completion', trace.outcome, 'opened-then-dismissed');
      await verifyCompletionFocus(app, row);
      row.expect('completion did not launch a browser', browserSnapshot(), browsers);
      // A fresh settled target still opens normally, and dismisses back to it.
      await clickReviewedLink(app, 'Completion boundary', row);
      row.expect('fresh review address', (await reviewFacts(app)).address, ADDRESSES.query);
      await app.key('escape');
      await app.gone('dialog', REVIEW);
      row.expect(
        'focus after fresh review dismissal',
        await app.focusedName(),
        'Completion boundary',
      );
      row.expect('review without Open did not launch a browser', browserSnapshot(), browsers);
      lane.shot('567-completed-and-dismissed');
    } finally {
      // An assertion or native-input failure must not leave the fixture held.
      finishReview();
    }
  });
  return row;
}

/** Rows 1, 2 and 9, and #515's browser rows, from one reply with three links. */
export async function linkRows(lane, familiar, browser) {
  const { app, native } = lane;
  const row1 = new Row('504-1', 'Link gestures, context menu, exact clipboard, review');
  const row2 = new Row('504-2', 'Dialog modality, focus return and screen-reader announcement');
  const row9 = new Row('504-9', 'IPv6 address https://[::1]:8080/x');
  const handoff = new Row('515', 'Open hands the exact address to the default browser');
  handoff.note('default browser', browser);
  quitBrowsers();
  await sleep(1_500);

  await lane.attempt(row1, async () => {
    const before = lane.requests();
    await lane.send(familiar, '[[links]] Show me the links.', 'link', 'Handoff check');
    row1.note('model requests for the reply', lane.requests() - before);
    const launches = browserSnapshot();

    await clickReviewedLink(app, 'Handoff check', row1);
    const facts = await reviewFacts(app);
    row1.check('primary click opens the review', Boolean(facts.review));
    row1.expect('review site', facts.host, 'example.com');
    row1.expect('review address', facts.address, ADDRESSES.query);
    await cancelReview(app);

    await app.click(await linkNamed(app, 'Handoff check'), { mods: [MOD] });
    row1.expect(`${MOD}-click opens the review`, await app.count('dialog', REVIEW), 1);
    await cancelReview(app);
    await app.click(await linkNamed(app, 'Handoff check'), { button: 'middle' });
    row1.expect('middle-click opens the review', await app.count('dialog', REVIEW), 1);
    await cancelReview(app);

    // The native context menu: what the platform shows, read through accessibility.
    const pressed = center(await app.visible(await linkNamed(app, 'Handoff check')));
    await app.click(pressed, { button: 'right' });
    await sleep(1_200);
    const items = await readMenu(lane, row1, 'native context menu on the link', pressed);
    // README: links carry no address of their own, so the menu offers only text
    // actions. Page actions such as Reload would reload Chat's whole window.
    if (items.length) {
      row1.check(
        'the context menu offers no way to open the link',
        !items.some((item) => /open link|open in|new tab|new window/i.test(item)),
        items,
      );
      row1.check(
        'the context menu offers only text actions (no page actions such as Reload)',
        !items.some(pageAction),
        items,
      );
    } else if (PLATFORM === 'mac') {
      // A menu that could not be read proves nothing either way.
      row1.block(
        'context menu items',
        'no open menu could be read through accessibility (see the screenshot)',
      );
    } else {
      // On Windows and Linux Chat removes every item that is not a text action
      // (#547), so a link with nothing selected may open no menu. That is told
      // from a menu the lane cannot read by a control: right-click inside a
      // selection in the same reply, where Copy must be offered.
      lane.shot('504-1-context-menu-link');
      await dismissMenus(lane);
      await dragText(app, PASSAGE[0], PASSAGE[0]);
      const { start, end } = app.lastDrag;
      const inside = [Math.round((start[0] + end[0]) / 2), start[1]];
      await app.click(inside, { button: 'right' });
      await sleep(1_200);
      const control = await readMenu(
        lane,
        row1,
        'control: native context menu inside a selection in the same reply',
        inside,
      );
      if (control.length) {
        row1.check(
          'the context menu on a selection offers Copy and only text actions',
          control.some((item) => /^copy$/i.test(String(item).trim())) && !control.some(pageAction),
          control,
        );
        const none =
          'no menu opened on the link with nothing selected, while the same reader read the selection menu';
        row1.check('the context menu offers no way to open the link', true, none);
        row1.check(
          'the context menu offers only text actions (no page actions such as Reload)',
          true,
          none,
        );
      } else {
        row1.block(
          'context menu items',
          'no open menu could be read through accessibility, on the link or on a selection (see the screenshots)',
        );
        if (PLATFORM === 'windows')
          row1.note(
            'top-level windows while the menu was open',
            await native.call({ cmd: 'topWindows' }),
          );
      }
    }
    row1.expect('right-click opens the review', await app.count('dialog', REVIEW), 0);
    lane.shot('504-1-context-menu');
    await dismissMenus(lane);
    await sleep(500);
    row1.expect(
      'browser processes after click, modified click, middle-click and right-click',
      browserSnapshot(),
      launches,
    );

    // Copy address, read back from the system clipboard by another process.
    await openReview(app, 'Handoff check', row1);
    markClipboard();
    await app.click(await app.one('button', 'Copy address', { within: ['dialog', REVIEW] }));
    row1.expect(
      'Copy address status',
      await waitStatus(app, /Copied the address\./),
      'Copied the address.',
    );
    row1.expect('system clipboard after Copy address', readClipboard(), ADDRESSES.query);
  });

  await lane.attempt(row2, async () => {
    if (await app.count('dialog', REVIEW)) await cancelReview(app);
    // A modal review makes the page behind it inert, which also hides it from
    // assistive technology, so positions behind it are taken before it opens.
    const link = await linkNamed(app, 'Handoff check');
    const linkPoint = center(link);
    const composerPoint = center(await lane.composer(familiar));
    await app.click(linkPoint);
    await app.one('dialog', REVIEW);
    row2.expect('focus when the review opens', await app.focusedName(), 'Cancel');
    for (const name of ['Copy address', 'Open', 'Cancel']) {
      await app.key('tab');
      row2.expect(`Tab moves focus to ${name}`, await app.focusedName(), name);
    }
    await app.key('tab', ['shift']);
    row2.expect('Shift+Tab from Cancel', await app.focusedName(), 'Open');
    row2.expect(
      'the conversation behind is hidden from assistive technology while the review is open',
      await app.count('link', 'Handoff check'),
      0,
    );

    // The conversation behind must not scroll or take clicks.
    const sent = lane.requests();
    await native.must({ cmd: 'scroll', at: linkPoint, dy: -400 });
    await sleep(600);
    await app.click(composerPoint);
    await sleep(600);
    const after = await app.focused();
    row2.note(
      'focus after clicking the composer behind the review',
      after ? `${after.role} "${after.name}"` : null,
    );
    row2.check(
      'the composer behind did not take focus',
      !(after?.role === 'textbox' && after.name === `Message ${familiar}`),
      after?.name,
    );
    row2.note('review after that click', (await app.count('dialog', REVIEW)) ? 'open' : 'closed');
    row2.expect('model requests after that click', lane.requests(), sent);
    row2.expect('the composer is still empty', await lane.composerValue(familiar), '');
    if (!(await app.count('dialog', REVIEW))) await app.click(linkPoint);
    await app.one('dialog', REVIEW);

    // Escape: focus returns to the link, and the screen reader says so.
    const said = await listen(lane, row2, 'screen-reader announcement on focus return', () =>
      closeReview(lane, row2),
    );
    row2.expect('focus after Escape', await app.focusedName(), 'Handoff check');
    if (said) {
      row2.note(`${lane.reader.name} after Escape`, said);
      row2.check(
        `${lane.reader.name} announces the link`,
        said.some((phrase) => /Handoff check/.test(phrase)),
        said,
      );
    }
    row2.expect(
      'the conversation did not scroll under the review (link y)',
      (await linkNamed(app, 'Handoff check')).frame?.y,
      link.frame?.y,
    );
  });

  await lane.attempt(handoff, async () => {
    // With the browser closed: the first Open starts it with the exact address.
    quitBrowsers();
    await sleep(1_500);
    handoff.note('browser processes before the first Open', browserSnapshot());
    await app.click(await linkNamed(app, 'Handoff check'));
    const { open } = await reviewFacts(app);
    await app.click(open);
    handoff.note(
      'status after Open',
      await waitStatus(app, /Sent the address|couldn't|Chat asked/, 15_000),
    );
    const bars = await waitForAddress(native, browser.key, ADDRESSES.query, 30_000, lane);
    handoff.note('browser windows after the first Open (browser was closed)', bars);
    handoff.check(
      'the default browser shows the exact address (browser closed)',
      bars.some(
        (w) =>
          w.fields.some((f) => f.value === ADDRESSES.query) ||
          w.documents.includes(ADDRESSES.query),
      ),
      bars,
    );
    lane.shot('515-first-open');
    await lane.front();
    await sleep(800);
    // The address can show before its page has loaded, and a page that loads
    // later would look like a second hand-off: wait until two reads agree.
    let tabsBefore = await addressBars(native, browser.key);
    for (let read = 0; read < 10; read += 1) {
      await sleep(1_000);
      const next = await addressBars(native, browser.key);
      if (JSON.stringify(next) === JSON.stringify(tabsBefore)) break;
      tabsBefore = next;
    }
    const again = (await reviewFacts(app)).open;
    handoff.expect('Open is disabled after one press', again?.enabled, false);
    if (again) await app.click(again);
    await sleep(4_000);
    const tabsAfter = await addressBars(native, browser.key);
    await lane.front();
    // Firefox exposes no address field, only its pages, so both are counted:
    // a second hand-off would add a window, or one more page at the address.
    const handedOff = (windows) => ({
      windows: windows.length,
      atTheAddress: windows
        .flatMap((w) => [...w.fields.map((f) => f.value), ...w.documents])
        .filter((value) => value === ADDRESSES.query).length,
    });
    handoff.note('browser before and after a second press', {
      before: tabsBefore,
      after: tabsAfter,
    });
    handoff.check(
      'a second press opens nothing more (windows, and fields or pages at the address)',
      handedOff(tabsBefore).atTheAddress > 0 &&
        isDeepStrictEqual(handedOff(tabsAfter), handedOff(tabsBefore)),
      { before: handedOff(tabsBefore), after: handedOff(tabsAfter) },
    );
    await closeReview(lane, handoff);
    handoff.expect(
      'Escape after Open returns focus to the link',
      await app.focusedName(),
      'Handoff check',
    );

    // With the browser running: the next address reaches the same browser.
    await app.click(await linkNamed(app, 'Plain address'));
    handoff.expect('review address (plain)', (await reviewFacts(app)).address, ADDRESSES.plain);
    await app.click((await reviewFacts(app)).open);
    const plain = await waitForAddress(native, browser.key, ADDRESSES.plain, 30_000, lane);
    handoff.note('browser windows after Open on the plain address (browser running)', plain);
    // Firefox's address field is not exposed on this runner; the loaded document's URL is.
    const shown = plain.flatMap((w) => [...w.fields.map((f) => f.value), ...w.documents]);
    // Exactly the plain address, with or without its slash, or the browser's
    // own HTTPS upgrade of it (or the bare host some address fields show).
    handoff.check(
      'the running browser shows the plain address (or notes its own HTTPS upgrade)',
      shown.some((v) => /^(https?:\/\/)?example\.com\/?$/.test(v)),
      shown,
    );
    await closeReview(lane, handoff);
  });

  await lane.attempt(row9, async () => {
    await app.click(await linkNamed(app, 'Loopback six'));
    const facts = await reviewFacts(app);
    row9.expect('review site', facts.host, '[::1]:8080');
    row9.expect('review address', facts.address, ADDRESSES.ipv6);
    markClipboard();
    await app.click(await app.one('button', 'Copy address', { within: ['dialog', REVIEW] }));
    row9.expect('system clipboard after Copy address', readClipboard(), ADDRESSES.ipv6);
    await app.click((await reviewFacts(app)).open);
    const bars = await waitForAddress(native, browser.key, ADDRESSES.ipv6, 20_000, lane);
    row9.note('browser windows after Open', bars);
    row9.check(
      'the default browser shows the IPv6 address',
      bars.some(
        (w) =>
          w.fields.some((f) => f.value === ADDRESSES.ipv6 || f.value === '[::1]:8080/x') ||
          w.documents.includes(ADDRESSES.ipv6),
      ),
      bars.map((w) => ({ fields: w.fields, documents: w.documents })),
    );
    await closeReview(lane, row9);
  });

  await lane.attempt(handoff, async () => {
    // A sign-in name: offered to copy only, and nothing reaches the browser.
    await lane.send(familiar, '[[userinfo]] One more address.', 'link', 'Named login');
    const launches = browserSnapshot();
    await clickReviewedLink(app, 'Named login', handoff);
    const facts = await reviewFacts(app);
    handoff.expect('buttons in the review of https://name@example.com/', facts.buttons, [
      'Cancel',
      'Copy address',
    ]);
    handoff.note('review text', facts.texts.join(' | '));
    markClipboard();
    await app.click(await app.one('button', 'Copy address', { within: ['dialog', REVIEW] }));
    handoff.expect('system clipboard after Copy address', readClipboard(), USERINFO);
    await closeReview(lane, handoff);
    handoff.expect('browser processes after the sign-in-name review', browserSnapshot(), launches);
    const others = browserProcesses().filter((p) => p.browser !== browser.key);
    handoff.expect(
      'non-default browsers running after every Open',
      others.map((p) => p.browser),
      [],
    );
  });
  quitBrowsers();
  await app.activate();
  return [row1, row2, handoff, row9];
}

async function settingsGeneral(app) {
  await app.click(await app.one('button', 'Open settings'));
  await app.one('dialog', 'Settings');
  const general = await app.all('button', 'General', { within: ['dialog', 'Settings'] });
  const tab = general[0] ?? (await app.one('tab', 'General', { within: ['dialog', 'Settings'] }));
  await app.click(tab);
  await sleep(400);
}

async function closeSettings(app) {
  await app.click(await app.one('button', 'Close settings'));
  await app.gone('dialog', 'Settings', { timeout: 3_000 }).catch(async () => {
    await app.key('escape');
    await app.gone('dialog', 'Settings');
  });
}

const inside = (inner, outer) =>
  Boolean(inner && outer) &&
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.w <= outer.x + outer.w + 1 &&
  inner.y + inner.h <= outer.y + outer.h + 1;

/** Row 5: tables, the sheet, and Copy table Markdown at 480x520 with Larger text. */
export async function tableRow(lane, familiar, frames) {
  const { app } = lane;
  const row = new Row('504-5', 'Tables at 480x520 with Larger text');
  return lane.attempt(row, async () => {
    try {
      await tableSteps(lane, familiar, frames, row);
    } finally {
      await app.setFrame(frames.wide).catch(() => undefined);
      await sleep(1_500);
    }
  });
}

async function tableSteps(lane, familiar, frames, row) {
  const { app, native } = lane;
  {
    const sample = (await app.all('text')).find((node) =>
      /three steps/.test(String(node.value ?? node.name)),
    );
    await settingsGeneral(app);
    const larger = await app.one('radio', 'Larger', { within: ['dialog', 'Settings'] });
    await app.click(larger);
    await sleep(500);
    const chosen = await app.one('radio', 'Larger', { within: ['dialog', 'Settings'] });
    row.note('Larger after clicking it', { selected: chosen.selected, value: chosen.value });
    await closeSettings(app);
    const grown = (await app.all('text')).find((node) =>
      /three steps/.test(String(node.value ?? node.name)),
    );
    row.check(
      'text is larger after choosing Larger',
      (grown?.frame?.h ?? 0) > (sample?.frame?.h ?? Infinity),
      {
        before: sample?.frame?.h,
        after: grown?.frame?.h,
      },
    );

    await lane.send(familiar, '[[table]] Show me the table.', 'button', 'Expand table');
    await lane.idle();
    await app.setFrame({ ...frames.origin, w: 480, h: 520 });
    await sleep(1_500);
    const window = await app.window();
    row.note('window after resizing to 480x520', window?.frame);
    await app.click((await app.all('button', 'Expand table')).at(-1));
    const sheet = await app.one('dialog', 'Expanded table');
    row.expect('focus when the sheet opens', await app.focusedName(), 'Close');
    row.check('the sheet fits the window', inside(sheet.frame, window?.frame), {
      sheet: sheet.frame,
      window: window?.frame,
    });

    const cell = [...walk(sheet)].find(
      (node) => node.role === 'cell' && /wide-wide/.test(node.name),
    );
    if (cell) {
      const before = cell.frame;
      await native.must({ cmd: 'scroll', at: center(sheet), dx: -300, dy: 0 });
      await sleep(600);
      const moved = [...walk(await app.one('dialog', 'Expanded table'))].find(
        (node) => node.role === 'cell' && /wide-wide/.test(node.name),
      );
      row.check('the sheet scrolls across', moved?.frame?.x !== before?.x, {
        before: before?.x,
        after: moved?.frame?.x,
      });
      await native.must({ cmd: 'scroll', at: center(sheet), dx: 0, dy: -300 });
      await sleep(600);
      const down = [...walk(await app.one('dialog', 'Expanded table'))].find(
        (node) => node.role === 'cell' && /wide-wide/.test(node.name),
      );
      row.note('the sheet after a downward wheel (cell y)', {
        before: moved?.frame?.y,
        after: down?.frame?.y,
      });
    } else row.note('wide cell in the sheet', 'not found by name');

    markClipboard();
    await app.click(
      await app.one('button', 'Copy table Markdown', { within: ['dialog', 'Expanded table'] }),
    );
    await sleep(600);
    row.expect('system clipboard after Copy table Markdown in the sheet', readClipboard(), TABLE);

    await app.click(
      await app.one('link', 'Guide', { within: ['dialog', 'Expanded table'], first: true }),
    );
    const facts = await reviewFacts(app);
    row.expect('a link in the sheet opens the review', facts.host, 'docs.example.test');
    // The sheet under the review is inert, so assistive technology does not see it
    // until the review closes; "Escape closes the review only" below proves it stayed.
    row.note(
      'sheets visible to assistive technology under the review',
      await app.count('dialog', 'Expanded table'),
    );
    markClipboard();
    await app.click(await app.one('button', 'Copy address', { within: ['dialog', REVIEW] }));
    row.expect('system clipboard after Copy address in the sheet', readClipboard(), GUIDE);
    await app.key('escape');
    await app.gone('dialog', REVIEW);
    row.expect('Escape closes the review only', await app.count('dialog', 'Expanded table'), 1);
    row.expect('focus returns to the link', await app.focusedName(), 'Guide');
    await app.key('escape');
    await app.gone('dialog', 'Expanded table');
    row.expect('focus returns to Expand table', await app.focusedName(), 'Expand table');

    markClipboard();
    await app.click((await app.all('button', 'Copy table Markdown')).at(-1));
    await sleep(600);
    row.expect('system clipboard after Copy table Markdown in the reply', readClipboard(), TABLE);
    const composer = await lane.composer(familiar);
    row.check('composer inside the 480x520 window', inside(composer.frame, window?.frame), {
      composer: composer.frame,
      window: window?.frame,
    });
    await app.click(composer);
    row.expect(
      'composer takes focus at 480x520',
      (await app.focused())?.name,
      `Message ${familiar}`,
    );
    lane.shot('504-5-480x520');
  }
}

/** A drag across text that a person would make: from the start of one node to the end of another. */
async function dragText(app, fromPattern, toPattern, { fromIndex = 0, toIndex = -1 } = {}) {
  // UI Automation exposes a link's words only as the link, with no text child.
  // Nor a table cell's words, which are its name.
  const words = (node) =>
    shownText(node) || (node.role === 'link' || node.role === 'cell' ? node.name : '');
  const ends = async () => {
    const texts = [...walk(await app.snapshot())].filter(
      (node) => node.frame && node.frame.w > 0 && words(node),
    );
    return [
      texts.filter((node) => fromPattern.test(words(node))).at(fromIndex),
      texts.filter((node) => toPattern.test(words(node))).at(toIndex),
    ];
  };
  let [from, to] = await ends();
  if (!from || !to) throw new Error(`no text to drag across (${fromPattern} to ${toPattern})`);
  // A person scrolls the passage to the middle of the window before dragging
  // across it; its edges are under the header and the composer.
  await app.middle(from, async () => (await ends())[0]);
  // Chromium updates its reported bounds a moment after a scroll: the press
  // waits until two reads agree, or it lands where the text used to be.
  let previous = '';
  for (let read = 0; read < 10; read += 1) {
    [from, to] = await ends();
    const where = JSON.stringify([from?.frame, to?.frame]);
    if (where === previous) break;
    previous = where;
    await sleep(300);
  }
  if (!from || !to || !(await app.onScreen(from)) || !(await app.onScreen(to))) {
    const { top, bottom, left, right } = await app.viewport();
    throw new Error(
      `the passage (${fromPattern} to ${toPattern}) does not fit in the window: from ${JSON.stringify(from?.frame)}, to ${JSON.stringify(to?.frame)}, visible ${JSON.stringify({ top, bottom, left, right })}`,
    );
  }
  // A few pixels inside the first glyph: a press in a bubble's padding can
  // start the selection at the top of the page.
  const inset = (frame) => Math.min(4, Math.max(1, Math.floor(frame.w / 4)));
  const start = [
    Math.round(from.frame.x + inset(from.frame)),
    Math.round(from.frame.y + from.frame.h / 2),
  ];
  // A press inside an existing selection starts drag-and-drop instead of a new
  // selection, so on Windows, where a stray select-all was seen, a selection
  // left over is collapsed with a click first. On Linux a full selection read
  // just after row 5's dialogs closed cost the run its accessibility tree.
  const collapsedFirst = PLATFORM === 'windows' && Boolean(await app.selection());
  if (collapsedFirst) {
    await app.click([
      Math.round(from.frame.x + inset(from.frame)),
      Math.round(from.frame.y + from.frame.h / 2),
    ]);
    await sleep(300);
  }
  // The end stays one pixel inside: a final "." is narrower than the inset.
  const end = [Math.round(to.frame.x + to.frame.w - 1), Math.round(to.frame.y + to.frame.h / 2)];
  await app.drag(
    [start, [Math.round((start[0] + end[0]) / 2), Math.round((start[1] + end[1]) / 2)], end],
    200,
  );
  app.lastDrag = { start, end, from: from.frame, to: to.frame, collapsedFirst };
  return app.selection();
}

const count = (text, needle) => text.split(needle).length - 1;

/**
 * Tabs forward toward Quote selection, checking after every press that the
 * action is still offered; stops once focus reaches it or it is gone.
 */
async function tabToAction(app, max) {
  const path = [];
  for (let press = 1; press <= max; press += 1) {
    await app.key('tab');
    const focus = await app.focusedName();
    path.push(focus);
    if (focus === 'Quote selection') return { reached: true, presses: press, path };
    if (!(await app.count('button', 'Quote selection')))
      return { reached: false, presses: press, path, goneAfter: { press, focus } };
  }
  return { reached: false, presses: max, path };
}

/** Puts the caret at the end of the draft, by keyboard. */
async function caretToEnd(lane, familiar) {
  const { app } = lane;
  if ((await app.focused())?.name !== `Message ${familiar}`)
    await app.click(await lane.composer(familiar));
  if (PLATFORM === 'mac') await app.key('down', ['cmd']);
  else await app.key('end', ['ctrl']);
}

/**
 * A freshly selected input method can take a moment to own the window's text
 * input, and the keys meanwhile arrive as Latin. One probe key shows which:
 * Japanese input turns "a" into composing kana, which Delete then cancels.
 */
/**
 * Choosing Kotoeri while it is already the current source changes nothing, and
 * on the macOS runners its first choice often leaves the input method
 * unstarted, so the keys stay Latin. A probe on both runners (TextEdit, one key
 * after each way of choosing) found it starts on a fresh choice: away to Latin
 * and back with the app in front composed on the Intel runner, and an app
 * becoming active with Japanese already chosen composed on both. Later attempts
 * try those in turn; whether the keys compose is still judged by the probe key.
 */
async function rechooseKotoeri(lane, ime, attempt) {
  const { native } = lane;
  await native.call({ cmd: 'selectInputSource', source: ime.latin });
  await sleep(1_000);
  if (attempt === 4)
    spawnSync('pluginkit', ['-e', 'use', '-i', ime.japanese.replace(/\.Japanese$/, '')], {
      stdio: 'ignore',
    });
  if (attempt % 2 === 1) {
    // Another app in front while Japanese is chosen, then Chat again.
    spawnSync('open', ['-a', 'Finder'], { stdio: 'ignore' });
    await sleep(1_500);
    await native.call({ cmd: 'selectInputSource', source: ime.japanese });
    await sleep(1_500);
    return 'Latin, then Japanese with Finder in front, then Chat';
  }
  await lane.front();
  await native.call({ cmd: 'selectInputSource', source: ime.japanese });
  await sleep(3_000);
  return attempt === 4
    ? 'pluginkit use, then Latin and Japanese again'
    : 'Latin, then Japanese again';
}

async function imeReady(lane, familiar, ime, quoted) {
  const { app, native } = lane;
  const tries = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const how =
      attempt > 1 && PLATFORM === 'mac' ? await rechooseKotoeri(lane, ime, attempt) : 'chosen';
    await lane.front();
    const chosen = await native.call({ cmd: 'selectInputSource', source: ime.japanese });
    await caretToEnd(lane, familiar);
    if (ime.on) await app.key(ime.on);
    await sleep(1_000 * attempt);
    await app.type('a');
    await sleep(600);
    const probe = (await lane.composerValue(familiar)).slice(quoted.length);
    const focus = (await app.focused())?.name;
    await app.key('delete');
    await sleep(500);
    // Before the input method owns the keys, its switch key can arrive as a
    // control character beside the Latin "a"; whatever is left is deleted.
    let after = await lane.composerValue(familiar);
    for (
      let extra = after.length - quoted.length;
      extra > 0 && after.startsWith(quoted);
      extra -= 1
    ) {
      await app.key('delete');
      await sleep(150);
      after = await lane.composerValue(familiar);
    }
    tries.push({ attempt, how, current: chosen.current, probe, focus, restored: after === quoted });
    if (after !== quoted) break;
    if (probe && !/[a-z]/i.test(probe)) return { composing: true, tries };
    // WebKitGTK keeps IBus's uncommitted text out of the field's accessible
    // text: a key the focused composer took without showing it went to the IME.
    if (!probe && focus === `Message ${familiar}`)
      return { composing: true, hiddenPreedit: true, tries };
  }
  return { composing: false, tries };
}

const PASSAGE = [/^The plan has three steps\.$/, /^Handoff check$/];

/** Row 3: a real drag-selection, Tab to the action, held Enter, IME, a cell, two messages. */
export async function quoteRow(lane, familiar, ime) {
  const { app, native } = lane;
  const row = new Row(
    '504-3',
    'Quote selection: drag, Tab, held Enter, IME, table cell, two messages',
  );
  return lane.attempt(row, async () => {
    await lane.clearComposer(familiar);
    const selected = await dragText(app, ...PASSAGE);
    row.note('selection from a real drag across a paragraph break and a list', selected);
    row.note('drag points and the passage as the platform placed it', app.lastDrag);
    await until(
      'Quote selection',
      async () => (await app.count('button', 'Quote selection')) === 1,
      5_000,
    ).catch(() => undefined);
    row.expect('Quote selection offered once', await app.count('button', 'Quote selection'), 1);

    // The checklist's path: Tab from the passage to the action.
    const fromPassage = await tabToAction(app, 60);
    row.note('Tab from the dragged passage toward the action', fromPassage);
    row.expect('focus reaches Quote selection by Tab from the passage', fromPassage.reached, true);

    let held = fromPassage.reached ? '> The plan has three steps.' : null;
    if (!fromPassage.reached) {
      // The quote's lines, through the action pressed with the pointer.
      await dragText(app, ...PASSAGE);
      await app.click(await app.one('button', 'Quote selection'));
      await sleep(600);
      const pointed = await lane.composerValue(familiar);
      row.note('composer after pressing Quote selection with the pointer', pointed);
      row.expect(
        'one quote from the pointer press',
        count(pointed, '> The plan has three steps.'),
        1,
      );
      row.check('line breaks kept', pointed.includes('>\n> First, read the source.'), pointed);
      await lane.clearComposer(familiar);
      // Held Enter needs focus on the action: a passage after the conversation's
      // last control leaves the action as the next Tab stop.
      await dragText(app, /^Done\.$/, /^Done\.$/, { fromIndex: -1, toIndex: -1 });
      const fromEnd = await tabToAction(app, 8);
      row.note('Tab from a passage at the end of the last reply ("Done.")', fromEnd);
      if (fromEnd.reached) held = '> Done.';
      else
        row.block(
          'held Enter on the action',
          'focus could not reach Quote selection by Tab from either passage',
        );
    }

    const sent = lane.requests();
    if (held) {
      await app.key('return', [], { repeats: 14, intervalMs: 40 });
      await sleep(1_000);
      const value = await lane.composerValue(familiar);
      row.note('composer after holding Enter on the action', value);
      row.expect(`one quote after holding Enter (${held})`, count(value, held), 1);
      if (held.includes('three steps'))
        row.check('line breaks kept', value.includes('>\n> First, read the source.'), value);
      row.expect('model requests after holding Enter (no send)', lane.requests(), sent);
      row.expect(
        'composer focused after quoting',
        (await app.focused())?.name,
        `Message ${familiar}`,
      );
    }

    // IME: compose Japanese after a quote; committing must not send.
    if (!(await lane.composerValue(familiar)).startsWith('> ')) {
      await dragText(app, ...PASSAGE);
      await app.click(await app.one('button', 'Quote selection'));
      await sleep(600);
    }
    const quoted = await lane.composerValue(familiar);
    const chosen = ime
      ? await native.call({ cmd: 'selectInputSource', source: ime.japanese })
      : null;
    if (chosen) row.note('input source for Japanese', chosen);
    if (chosen && !chosen.ok) {
      // Enter on Latin input would send the draft, so nothing is typed.
      row.block(
        'IME',
        `the Japanese input source could not be selected: ${JSON.stringify(chosen)}`,
      );
    } else if (ime) {
      const ready = await imeReady(lane, familiar, ime, quoted);
      row.note('Japanese input composing before typing', ready);
      await caretToEnd(lane, familiar);
      await app.type('nihonn');
      await sleep(400);
      await app.key('space');
      await sleep(800);
      // Enter commits a composition; on Latin input it would send the draft.
      // So Enter is pressed only once the draft shows the IME composing.
      const composing = (await lane.composerValue(familiar)).slice(quoted.length);
      row.note('draft after "nihonn" and Space, before Enter', composing);
      const stillHere = (await app.focused())?.name === `Message ${familiar}`;
      const imeActive =
        (composing.length > 0 && !/nihonn?/i.test(composing)) ||
        (composing === '' && Boolean(ready.hiddenPreedit) && stillHere);
      if (imeActive) await app.key('return');
      else {
        row.block('IME', 'the input source reported Japanese, but the keys arrived as Latin text');
        for (let index = 0; index < composing.length; index += 1) await app.key('delete');
      }
      await sleep(800);
      const composed = await lane.composerValue(familiar);
      await native.call({ cmd: 'selectInputSource', source: ime.latin });
      if (ime.off) await app.key(ime.off);
      row.note('composer after composing "nihonn", Space, Enter', composed);
      // What the IME commits depends on its candidates (Kotoeri's live conversion
      // can land on 🇯🇵); what matters is a commit with no romaji left over.
      const committed = composed.slice(quoted.length);
      if (imeActive)
        row.check(
          'Japanese input committed after the quote (no romaji left)',
          committed.trim().length > 0 && !/[A-Za-z]/.test(committed),
          committed,
        );
      row.check(
        'the quote is intact after composing',
        composed.startsWith(quoted.replace(/\s+$/, '')),
        composed.slice(0, 80),
      );
      row.expect('model requests after the IME commit (no send)', lane.requests(), sent);
    } else row.block('IME', 'no Japanese input method could be enabled on this runner');

    await lane.clearComposer(familiar);
    const cell = await dragText(app, /^a \| b$/, /^a \| b$/, { toIndex: 0 });
    row.note('selection inside one table cell', cell);
    await app.click(await app.one('button', 'Quote selection'));
    await sleep(500);
    row.expect('a table cell quotes', await lane.composerValue(familiar), '> a | b\n\n');
    await lane.clearComposer(familiar);

    // The table request and its reply: two messages a short drag apart.
    const across = await dragText(app, /^\[\[table\]\] Show me the table\.$/, /^Here it is\.$/);
    row.note('selection across two messages', String(across).slice(0, 120));
    await sleep(800);
    row.expect(
      'no action for a selection across two messages',
      await app.count('button', 'Quote selection'),
      0,
    );
    await app.click(await lane.composer(familiar));
  });
}

async function inspectorWidth(app) {
  const panel = await app.all('complementary', 'Familiar inspector');
  const handle = await app.all('separator', 'Resize inspector');
  return {
    width: panel[0]?.frame?.w ?? null,
    value: handle[0] ? Number(handle[0].value) : null,
    handle: handle[0] ?? null,
  };
}

/** A press on the handle starts a drag and does not focus it, so focus arrives by Tab. */
async function tabToSeparator(lane, familiar) {
  await lane.app.click(await lane.composer(familiar));
  let tabs = 0;
  while ((await lane.app.focused())?.role !== 'separator' && tabs < 80) {
    await lane.app.key('tab');
    tabs += 1;
  }
  return tabs;
}

/**
 * Settings > General shows the width as text ("400px"). What the platform
 * reports is kept beside the check when it is missing, to tell an absent
 * value from one the tree does not carry.
 */
export async function settingsShowWidth(lane, row, label, width) {
  const settings = await lane.app.one('dialog', 'Settings');
  const nodes = [...walk(settings)];
  const shown = `${nodes.map((node) => String(node.value ?? node.name ?? '')).join(' ')} ${textIn(settings)}`;
  const ok = new RegExp(`\\b${width}\\s*px`).test(shown);
  row.check(label, ok, { widthsShown: shown.match(/\d+\s*px/g) ?? [] });
  // Retain the complete dialog even when assertions pass, including native
  // descriptions and relations. The relevant Inspector group is kept too.
  lane.save(`settings-tree-${width}.json`, JSON.stringify(settings.raw, null, 2));
  lane.shot(`settings-width-${width}`);
  if (PLATFORM === 'linux') {
    const evidence = settingsWidthEvidence(settings, width);
    lane.save(`settings-inspector-${width}.json`, JSON.stringify(evidence.subtree, null, 2));
    row.note(`Settings ${width}px Inspector text`, evidence.text);
    checkSettingsWidth(row, evidence, width);
    const said = await listen(lane, row, `Orca Settings ${width}px`, async () => {
      // WebKitGTK's dialog script does not bind ordinary Down to browse
      // navigation. Use Orca's documented desktop flat-review commands:
      // Insert+KP7 moves home; KP9 reads the next spatial line.
      // https://help.gnome.org/orca/commands_flat_review.html
      await lane.app.key('Insert+KP_Home');
      for (let index = 0; index < 32; index += 1) {
        await lane.app.key('KP_Page_Up');
        await sleep(200);
      }
    });
    if (said) {
      lane.save(`settings-orca-${width}.json`, JSON.stringify(said, null, 2));
      checkSettingsSpeech(row, said, width);
    }
  }
}

/** Row 6: the separator through a real pointer that leaves the window, the keys, Settings, Reset, 1100px. */
export async function inspectorRow(lane, familiar, frames) {
  const { app, native } = lane;
  const row = new Row(
    '504-6',
    'Inspector resize: pointer capture outside the window, separator, keys, Reset, persisted width',
  );
  return lane.attempt(row, async () => {
    if (frames.wide.w <= 1180) {
      // Below 1100px the inspector is a drawer, not a resizable rail.
      row.block(
        'inspector rail',
        `the runner's screen holds a window only ${frames.wide.w}px wide; the rail and its 1100px trip need more`,
      );
      return;
    }
    await app.setFrame(frames.wide);
    await sleep(1_200);
    if (await app.count('button', 'Show inspector')) {
      await app.click(await app.one('button', 'Show inspector'));
      row.note('inspector at the start of the row', 'closed; pressed Show inspector');
    }
    let state = await until('the separator', async () =>
      (await inspectorWidth(app)).handle ? inspectorWidth(app) : null,
    );
    row.expect('default value', state.value, 360);
    row.note('separator as the platform reports it', {
      orientation: state.handle.raw.orientation,
      min: state.handle.raw.min,
      max: state.handle.raw.max,
      roleDescription: state.handle.roleDescription,
    });

    // Tab to the handle, step back one, and hear the screen reader on the last Tab.
    const tabs = await tabToSeparator(lane, familiar);
    row.note('Tab presses from the composer to the separator', tabs);
    row.expect('Tab reaches the separator', (await app.focused())?.name, 'Resize inspector');
    await app.key('tab', ['shift']);
    const said = await listen(lane, row, 'separator read aloud', () => app.key('tab'));
    row.expect('focus on the separator again', (await app.focused())?.name, 'Resize inspector');
    if (said) {
      const spoken = said.join(' | ');
      row.note(`${lane.reader.name} at the separator`, said);
      // 360px is 25% of the 280-600 range; VoiceOver speaks a splitter's value as a percentage.
      row.check(
        `${lane.reader.name} reads the separator's name and value (360, or 25% of its range)`,
        /Resize inspector/.test(spoken) && (/360/.test(spoken) || /\b25\s?%/.test(spoken)),
        spoken,
      );
      row.check(
        `${lane.reader.name} names it a separator or splitter`,
        /separator|splitter/i.test(spoken),
        spoken,
      );
    }

    await app.key('left');
    row.expect('Left widens by 16px', (await inspectorWidth(app)).value, 376);
    await app.key('right');
    row.expect('Right narrows by 16px', (await inspectorWidth(app)).value, 360);
    // What VoiceOver says as the value changes, for the record. NVDA and Orca
    // take arrow keys for their own reading cursor, so this runs on macOS only.
    if (PLATFORM === 'mac') {
      const onLeft = await listen(lane, row, 'separator value change read aloud', () =>
        app.key('left'),
      );
      if (onLeft) row.note(`${lane.reader.name} after Left (376px)`, onLeft);
      await app.key('right');
    }
    await app.key('home');
    row.note('Home', (await inspectorWidth(app)).value);
    await app.key('end');
    state = await inspectorWidth(app);
    row.note('End', state.value);
    row.check(
      'End reaches the maximum the separator reports',
      state.handle.raw.max === undefined || Number(state.handle.raw.max) === state.value,
      { value: state.value, max: state.handle.raw.max },
    );
    await app.key('home');
    state = await inspectorWidth(app);
    const min = state.value;

    // A real drag that leaves the handle and is released outside the window.
    const window = await app.window();
    const [hx, hy] = center(state.handle);
    const outside = [hx - 120, Math.round(window.frame.y - 40)];
    await native.must({ cmd: 'down', at: [hx, hy] });
    for (let step = 1; step <= 10; step += 1) {
      await native.must({ cmd: 'move', at: [hx - step * 8, hy], held: true });
      await sleep(30);
    }
    const midway = await inspectorWidth(app);
    for (let step = 1; step <= 12; step += 1) {
      await native.must({
        cmd: 'move',
        at: [
          hx - 80 - Math.round((step * 40) / 12),
          Math.round(hy + ((outside[1] - hy) * step) / 12),
        ],
        held: true,
      });
      await sleep(30);
    }
    const leftWindow = await inspectorWidth(app);
    const selectedDuring = await app.selection();
    await native.must({ cmd: 'up', at: outside });
    await sleep(300);
    const released = await inspectorWidth(app);
    await native.must({ cmd: 'move', at: [hx - 300, hy] });
    await sleep(500);
    const afterwards = await inspectorWidth(app);
    row.note('drag', {
      start: min,
      midway: midway.value,
      outsideWindow: leftWindow.value,
      released: released.value,
      pointerBackInside: afterwards.value,
      outside,
      window: window.frame,
    });
    row.check('the width follows the pointer off the handle', midway.value > min, {
      min,
      midway: midway.value,
    });
    row.check(
      'capture holds while the pointer is outside the window',
      leftWindow.value > midway.value,
      { midway: midway.value, outside: leftWindow.value },
    );
    row.expect('releasing outside the window ends the drag', afterwards.value, released.value);
    row.expect('no text selected during the drag', selectedDuring, '');

    await settingsGeneral(app);
    row.expect('drag stages the 400px Settings check', released.value, 400);
    await settingsShowWidth(lane, row, 'Settings > General shows the width', 400);
    await app.click(
      await app.one('button', 'Reset inspector width', { within: ['dialog', 'Settings'] }),
    );
    await sleep(400);
    await settingsShowWidth(lane, row, 'Settings after Reset shows 360px', 360);
    await closeSettings(app);
    row.expect('Reset restores 360px', (await inspectorWidth(app)).value, 360);

    await tabToSeparator(lane, familiar);
    await app.key('end');
    row.expect('stored width before narrowing', (await inspectorWidth(app)).value, 600);
    await app.setFrame({ ...frames.wide, w: 1000 });
    await sleep(1_500);
    row.note('at 1000px wide', {
      separators: await app.count('separator', 'Resize inspector'),
      show: await app.count('button', 'Show inspector'),
    });
    const narrow = await app.window();
    const composerNarrow = await lane.composer(familiar);
    row.check(
      'composer inside the window at 1000px',
      inside(composerNarrow.frame, narrow?.frame),
      composerNarrow.frame,
    );
    await app.setFrame(frames.wide);
    await sleep(1_500);
    row.expect(
      'after widening again the rail stays folded',
      await app.count('separator', 'Resize inspector'),
      0,
    );
    await app.click(await app.one('button', 'Show inspector'));
    await until('the inspector to open', async () => (await inspectorWidth(app)).handle, 10_000);
    row.expect(
      'Show inspector opens it at the stored 600px',
      (await inspectorWidth(app)).value,
      600,
    );
    await settingsGeneral(app);
    await settingsShowWidth(lane, row, 'Settings still shows 600px', 600);
    await closeSettings(app);
  });
}

/** Unfolds the familiars rail if a narrow window left it folded. */
export async function showFamiliars(lane, row) {
  const show = (await lane.app.all('button')).find((node) => /^Show familiars/.test(node.name));
  if (!show) return false;
  await lane.app.click(show);
  await until(
    'the familiars rail',
    async () => (await lane.app.count('complementary', 'Familiars sidebar')) > 0,
    5_000,
  ).catch(() => undefined);
  row?.note('familiars rail', `folded; pressed "${show.name}"`);
  return true;
}

/** Row 4: a passage, a sheet and a review open, then switch familiars. */
export async function switchRow(lane, first, second) {
  const { app } = lane;
  const row = new Row('504-4', 'Chat-switch isolation');
  const state = async () => ({
    review: await app.count('dialog', REVIEW),
    sheet: await app.count('dialog', 'Expanded table'),
    quote: await app.count('button', 'Quote selection'),
    chat: (await app.count('textbox', `Message ${second}`)) ? second : first,
  });
  return lane.attempt(row, async () => {
    await showFamiliars(lane, row);
    await app.click(await app.one('button', second));
    await lane.composer(second);
    await app.click(await lane.composer(second));
    await app.type('Draft kept for later');
    const typed = await lane.composerValue(second);
    row.note(`${second}'s draft after typing`, typed);
    await app.click(await app.one('button', first));
    await lane.composer(first);

    // The rail is inert under a modal, so its position is taken first.
    const railPoint = center(await app.one('button', second));
    await dragText(app, /^The plan has three steps\.$/, /^First, read the source\.$/);
    row.expect(
      'Quote selection offered for the passage',
      await app.count('button', 'Quote selection'),
      1,
    );
    await openDialog(app, (await app.all('button', 'Expand table')).at(-1), 'Expanded table', row);
    await openDialog(
      app,
      await app.one('link', 'Guide', { within: ['dialog', 'Expanded table'], first: true }),
      REVIEW,
      row,
    );
    row.note('visible to assistive technology before switching', await state());

    // Cmd/Ctrl+[ and ] are off while a dialog is open (rail-shortcuts.ts).
    await app.key(']', [MOD]);
    await sleep(1_000);
    row.expect(
      `${MOD}+] with the review open leaves it open`,
      await app.count('dialog', REVIEW),
      1,
    );

    // The rail: the first click closes the review, the next the sheet, the third switches.
    const steps = [];
    for (let click = 1; click <= 3; click += 1) {
      await app.click(railPoint);
      await sleep(1_000);
      const now = await state();
      steps.push(now);
      row.note(`after click ${click} on ${second} in the rail`, now);
      if (now.chat === second) break;
    }
    row.expect(
      'click 1 closes the review only',
      steps[0] && { review: steps[0].review, sheet: steps[0].sheet },
      { review: 0, sheet: 1 },
    );
    row.expect(
      'click 2 closes the sheet, still on the first chat',
      steps[1] && { review: steps[1].review, sheet: steps[1].sheet, chat: steps[1].chat },
      { review: 0, sheet: 0, chat: first },
    );
    const now = steps.at(-1);
    row.expect(
      'click 3 switches',
      { clicks: steps.length, chat: now.chat },
      { clicks: 3, chat: second },
    );
    row.expect('review after the switch', now.review, 0);
    row.expect('sheet after the switch', now.sheet, 0);
    row.expect('waiting quote after the switch', now.quote, 0);
    row.expect('the other chat kept its draft', await lane.composerValue(second), typed);
    await lane.clearComposer(second);

    // With nothing open and focus outside the composer, the shortcut steps back.
    const heading =
      (await app.all('heading')).find((node) => node.name.includes(second)) ??
      (await app.all('heading'))[0];
    if (heading) await app.click(heading);
    await app.key('[', [MOD]);
    await until(
      `${MOD}+[ to step back`,
      async () => (await app.count('textbox', `Message ${first}`)) === 1,
      10_000,
    );
    row.note(`${MOD}+[ with nothing open`, `stepped back to ${first}`);
  });
}

/** Row 7: quote during a real run, cancel it, and the quote stays with nothing sent twice. */
export async function cancelledRunRow(lane, familiar) {
  const { app } = lane;
  const row = new Row('504-7', 'Quote kept through a real cancelled run');
  return lane.attempt(row, async () => {
    await lane.idle();
    await lane.clearComposer(familiar);
    const before = lane.requests();
    const slowBefore = lane.tokens('slow');
    await app.click(await lane.composer(familiar));
    await app.type('[[slow]] Take your time.');
    await app.click(await app.one('button', 'Send'));
    await app.one('button', 'Stop run', { timeout: 60_000 });
    await until(
      'the slow reply to start',
      async () => (await app.all('text')).some((n) => /Slow line/.test(String(n.value ?? n.name))),
      60_000,
      500,
    );
    row.note('model requests when the run started', lane.requests() - before);

    await dragText(app, /^The plan has three steps\.$/, /^First, read the source\.$/, {
      fromIndex: 0,
      toIndex: 0,
    });
    const offered = await app.count('button', 'Quote selection');
    row.expect('Quote selection offered during the run', offered, 1);
    if (offered) await app.click(await app.one('button', 'Quote selection'));
    await sleep(600);
    row.note('composer during the run', await lane.composerValue(familiar));
    await app.click(await app.one('button', 'Stop run'));
    await lane.idle();
    await sleep(3_000);
    const value = await lane.composerValue(familiar);
    row.note('composer after Stop run', value);
    row.expect(
      'the quote stays after the cancelled run',
      count(value, '> The plan has three steps.'),
      1,
    );
    row.expect('slow runs sent to the model', lane.tokens('slow') - slowBefore, 1);
    const settled = lane.requests();
    await sleep(5_000);
    row.expect('nothing sent after the cancel', lane.requests(), settled);
    await lane.clearComposer(familiar);
  });
}
