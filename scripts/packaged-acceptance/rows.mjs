// The #504 and #515 rows this suite can drive in a packaged build. Each row
// records what it observed. A failed expectation throws, and the row is
// reported as failed with everything observed up to that point.

import { ADDRESSES, TABLE } from './model-fixture.mjs';
import { readClipboard } from './platform.mjs';
import { Key, Stop, sleep, until } from './webdriver.mjs';

export class Row {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.observations = [];
  }

  note(label, value) {
    this.observations.push({ label, value });
  }

  /** Records the observed value, then fails the row unless it matches. */
  expect(label, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    this.observations.push({ label, value: actual, ...(same ? {} : { expected }) });
    if (!same) {
      throw new Error(
        `${label}: observed ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  check(label, condition, value = condition) {
    this.observations.push({ label, value, ...(condition ? {} : { expected: 'true' }) });
    if (!condition) throw new Error(`${label}: observed ${JSON.stringify(value)}`);
  }
}

const REVIEW = 'Open this link?';

export async function composerOf(s, familiar) {
  return s.one('textbox', `Message ${familiar}`, { timeout: 30_000 });
}

/** Sends through the real composer and waits for the reply's marker to render. */
export async function send(s, familiar, text, role, name) {
  const composer = await composerOf(s, familiar);
  await until('the composer to accept input', () => composer.property('disabled').then((d) => !d));
  await composer.click();
  await composer.type(text);
  await (await s.one('button', 'Send')).click();
  // A failed run shows its error; report those words rather than time out.
  await until(
    `the reply's ${role} "${name}"`,
    async () => {
      const errors = await s.css('.coven-error-text');
      if (errors.length) throw new Stop(`The run failed: ${await errors[0].text()}`);
      return (await s.all(role, name)).length > 0;
    },
    120_000,
    250,
  );
  // The reply is on screen; wait for the run to settle so the next send is not a follow-up.
  await until(
    'the run to finish',
    async () => (await s.css('.oc-composer[data-running]')).length === 0,
    60_000,
  );
}

async function reviewParts(s) {
  const review = await s.one('dialog', REVIEW);
  const parts = await review.evaluate(`return {
    host: node.querySelector('.coven-link-review-host')?.textContent ?? null,
    address: node.querySelector('.coven-link-review-address')?.textContent ?? null,
    status: node.querySelector('.coven-link-review-status')?.textContent ?? null,
  };`);
  return { review, ...parts };
}

async function focusedName(s) {
  return s.execute(`const node = document.activeElement;
    return node ? (node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim() : null;`);
}

async function closeReview(s) {
  await s.press(Key.Escape);
  await s.gone('dialog', REVIEW);
}

/** Rows 1, 2 (keyboard part) and 9, and #515's handoff. */
export async function linkRows(s, familiar, opened) {
  const results = [];
  const row1 = new Row('504-1', 'Link gestures, copy, review');
  const row2 = new Row('504-2', 'Modality and focus return (keyboard part)');
  const row9 = new Row('504-9', 'IPv6 address');
  const handoff = new Row('515', 'Open hands the exact address to the system browser');
  results.push(row1, row2, row9, handoff);

  let current = row1;
  try {
    await send(s, familiar, '[[links]] Where are the docs?', 'link', 'Handoff check');
    const link = await s.one('link', 'Handoff check');
    row1.expect(
      'transcript anchors with a live http(s) href',
      (await s.css('.fr-transcript a[href^="http"]')).length,
      0,
    );

    await s.click(link);
    let parts = await reviewParts(s);
    row1.check('primary click opens the review', Boolean(parts.review));
    row1.expect('review site', parts.host, 'example.com');
    row1.expect('review address', parts.address, ADDRESSES.query);

    current = row2;
    row2.expect('focus when the review opens', await focusedName(s), 'Cancel');
    for (const name of ['Copy address', 'Open', 'Cancel']) {
      await s.press(Key.Tab);
      row2.expect(`Tab moves focus to ${name}`, await focusedName(s), name);
    }
    const blocked =
      await s.execute(`const composer = document.querySelector('.coven-composer textarea, textarea');
      const box = composer.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { composerUnderPointer: composer.contains(hit), x: box.x + box.width / 2, y: box.y + box.height / 2 };`);
    row2.expect(
      'the composer behind the review is not hit-testable',
      blocked.composerUnderPointer,
      false,
    );
    await s.actions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          {
            type: 'pointerMove',
            origin: 'viewport',
            x: Math.round(blocked.x),
            y: Math.round(blocked.y),
          },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await s.release();
    row2.expect(
      'review still open after a click on the composer',
      (await s.all('dialog', REVIEW)).length,
      1,
    );
    row2.expect(
      'composer focused after that click',
      await s.execute('return document.activeElement?.tagName === "TEXTAREA";'),
      false,
    );
    await closeReview(s);
    row2.expect(
      'Escape closes the review and focus returns to the link',
      await s.isActive(link),
      true,
    );

    current = row1;
    await s.click(link, { modifier: Key.Control });
    row1.expect('Ctrl-click opens the review', (await s.all('dialog', REVIEW)).length, 1);
    await (await s.one('button', 'Cancel', { within: (await reviewParts(s)).review })).click();
    await s.gone('dialog', REVIEW);
    await s.click(link, { button: 1 });
    row1.expect('middle-click opens the review', (await s.all('dialog', REVIEW)).length, 1);
    await closeReview(s);
    row1.expect('nothing reached the browser from review gestures', opened.received().length, 0);

    await s.click(link);
    parts = await reviewParts(s);
    await (await s.one('button', 'Copy address', { within: parts.review })).click();
    await until(
      'the copy status',
      async () => (await reviewParts(s)).status === 'Copied the address.',
    );
    row1.expect('Copy address status', (await reviewParts(s)).status, 'Copied the address.');
    row1.expect('system clipboard after Copy address', readClipboard(), ADDRESSES.query);

    current = handoff;
    await openOnce(s, handoff, opened, ADDRESSES.query, 0);
    await closeReview(s);

    await s.click(await s.one('link', 'Plain address'));
    handoff.expect('review address (plain)', (await reviewParts(s)).address, ADDRESSES.plain);
    await openOnce(s, handoff, opened, ADDRESSES.plain, 1);
    await closeReview(s);

    current = row9;
    await s.click(await s.one('link', 'Loopback six'));
    parts = await reviewParts(s);
    row9.expect('review site', parts.host, '[::1]:8080');
    row9.expect('review address', parts.address, ADDRESSES.ipv6);
    await (await s.one('button', 'Copy address', { within: parts.review })).click();
    await until(
      'the copy status',
      async () => (await reviewParts(s)).status === 'Copied the address.',
    );
    row9.expect('system clipboard after Copy address', readClipboard(), ADDRESSES.ipv6);
    await openOnce(s, row9, opened, ADDRESSES.ipv6, 2);
    await closeReview(s);
  } catch (error) {
    current.error = error.message;
  }
  for (const row of results) if (!row.error && row.observations.length === 0) row.skipped = true;
  return results;
}

async function openOnce(s, row, opened, address, before) {
  const { review } = await reviewParts(s);
  const open = await s.one('button', 'Open', { within: review });
  await open.click();
  await until('the Open status', async () =>
    ((await review.text()) ?? '').includes('Sent the address to your browser.'),
  );
  row.note('Open status', 'Sent the address to your browser.');
  const received = await until(
    'the recorder to receive the address',
    () => {
      const entries = opened.received();
      return entries.length > before ? entries : null;
    },
    20_000,
  );
  row.expect('address the system opener handed to the browser', received[before].address, address);
  row.expect('Open is disabled after one press', await open.attribute('aria-disabled'), 'true');
  await open.click().catch(() => undefined);
  await sleep(3_000);
  row.expect('browser launches after a second press', opened.received().length - before, 1);
}

async function selectText(s, script) {
  return s.execute(`const selection = getSelection(); selection.removeAllRanges();
    const range = document.createRange(); ${script} selection.addRange(range);
    return selection.toString();`);
}

/** Row 3, the parts a keyboard and a programmatic selection can prove. */
export async function quoteRow(s, familiar, requests) {
  const row = new Row('504-3', 'Quote selection, held Enter (keyboard part)');
  try {
    const composer = await composerOf(s, familiar);
    await composer.clear();
    const selected = await selectText(
      s,
      `const bubble = [...document.querySelectorAll('.fr-bubble--familiar')]
        .find((node) => node.textContent.includes('three steps'));
      const items = bubble.querySelectorAll('li');
      range.setStart(bubble.querySelector('p'), 0);
      range.setEnd(items[0], items[0].childNodes.length);`,
    );
    row.note('selection across a paragraph break and a list item', selected);
    const quote = await s.one('button', 'Quote selection');
    row.check('Quote selection offered', Boolean(quote));
    row.check(
      'the action names whose reply it quotes',
      (await s.all('button', 'Quote selection')).length === 1 &&
        (await s.execute(`return document.body.innerText.includes("from ${familiar}'s reply");`)),
    );
    const sent = requests();
    await (await s.all('button', 'Copy reply')).at(-1).focus();
    await s.press(Key.Tab);
    row.expect('Tab from the conversation reaches the action', await s.isActive(quote), true);
    await s.actions([
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: Key.Enter },
          { type: 'pause', duration: 600 },
          { type: 'keyDown', value: Key.Enter },
          { type: 'keyDown', value: Key.Enter },
          { type: 'keyUp', value: Key.Enter },
        ],
      },
    ]);
    await s.release();
    await sleep(1_500);
    const value = await composer.property('value');
    row.note('composer after holding Enter on the action', value);
    row.check(
      'the draft holds one quote of the selection',
      value.startsWith('> ') && value.split('> The plan has three steps.').length === 2,
      value,
    );
    row.check(
      'the quote keeps the line breaks',
      value.includes('>\n> First, read the source.'),
      value,
    );
    row.expect('model requests after holding Enter (no send)', requests(), sent);
    row.expect('composer focused after quoting', await s.isActive(composer), true);

    await composer.clear();
    const cell = await selectText(
      s,
      `const cell = [...document.querySelectorAll('.fr-bubble--familiar td')]
        .find((node) => node.textContent.trim() === 'a | b');
      range.selectNodeContents(cell);`,
    );
    row.note('selection inside one table cell', cell);
    await (await s.one('button', 'Quote selection')).click();
    row.expect('a table cell quotes', await composer.property('value'), '> a | b\n\n');

    await composer.clear();
    const across = await selectText(
      s,
      `const bubbles = document.querySelectorAll('.fr-bubble');
      range.setStart(bubbles[0], 0);
      range.setEnd(bubbles[1], bubbles[1].childNodes.length);`,
    );
    row.note('selection across two messages', across.slice(0, 80));
    await sleep(800);
    row.expect(
      'no action offered across two messages',
      (await s.all('button', 'Quote selection')).length,
      0,
    );
    await s.execute('getSelection().removeAllRanges();');
    await composer.clear();
  } catch (error) {
    row.error = error.message;
  }
  return row;
}

async function openSettingsGeneral(s) {
  await (await s.one('button', 'Open settings')).click();
  const settings = await s.one('dialog', 'Settings');
  await (await s.one('button', 'General', { within: settings })).click();
  return settings;
}

async function closeSettings(s) {
  await (await s.one('button', 'Close settings')).click();
  await s.gone('dialog', 'Settings');
}

async function viewport(s) {
  return s.execute(`return {
    width: innerWidth, height: innerHeight,
    pageWidth: document.documentElement.scrollWidth,
  };`);
}

async function resize(s, width, height) {
  await s.windowRect({ width, height });
  return until(
    `a ${width}x${height} window`,
    async () => {
      const size = await viewport(s);
      return Math.abs(size.width - width) <= 2 && Math.abs(size.height - height) <= 40
        ? size
        : null;
    },
    10_000,
  );
}

/** Row 5: tables at 480x520 with Larger text. */
export async function tableRow(s, familiar) {
  const row = new Row('504-5', 'Tables and Copy table Markdown at 480x520 with Larger text');
  try {
    const settings = await openSettingsGeneral(s);
    await (
      await settings.evaluate(
        `return node.querySelector('input[name="coven-text-size"][value="larger"]').closest('label');`,
      )
    ).click();
    row.expect(
      'stored text size',
      await s.execute(
        `return JSON.parse(localStorage.getItem('opencoven.chat.preferences.v1') ?? '{}').textSize;`,
      ),
      'larger',
    );
    await closeSettings(s);

    await send(s, familiar, '[[table]] Show me the table.', 'button', 'Expand table');
    const size = await resize(s, 480, 520);
    row.note('viewport after resizing to 480x520', size);

    const expand = await s.one('button', 'Expand table');
    await expand.click();
    const sheet = await s.one('dialog', 'Expanded table');
    row.expect('focus when the sheet opens', await focusedName(s), 'Close');
    const fit = await sheet.evaluate(`const box = node.getBoundingClientRect();
      const scroller = [...node.querySelectorAll('*')].find((el) => el.scrollWidth > el.clientWidth + 1);
      return {
        inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
        pageWidth: document.documentElement.scrollWidth, width: innerWidth,
        scrollsAcross: Boolean(scroller),
      };`);
    row.expect('the sheet fits the window', fit.inside, true);
    row.check('no horizontal page scroll', fit.pageWidth <= fit.width, fit);
    row.expect('the wide table scrolls across inside the sheet', fit.scrollsAcross, true);

    const copy = await s.one('button', 'Copy table Markdown', { within: sheet });
    await copy.click();
    await until('Copied', async () => /Copied/.test(await copy.text()));
    row.expect('system clipboard after Copy table Markdown in the sheet', readClipboard(), TABLE);

    const link = await s.one('link', 'Guide', { within: sheet });
    await link.focus();
    await s.press(Key.Enter);
    const { review, host } = await reviewParts(s);
    row.expect('a link in the sheet opens the review', host, 'docs.example.test');
    row.expect(
      'the review is above the sheet',
      await review.evaluate(`const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));`),
      true,
    );
    await (await s.one('button', 'Copy address', { within: review })).click();
    await until(
      'the copy status',
      async () => (await reviewParts(s)).status === 'Copied the address.',
    );
    row.expect(
      'clipboard after Copy address from the sheet',
      readClipboard(),
      'https://docs.example.test/guide',
    );
    await s.press(Key.Escape);
    await s.gone('dialog', REVIEW);
    row.expect(
      'Escape closes only the review',
      (await s.all('dialog', 'Expanded table')).length,
      1,
    );
    row.expect('focus returns to the link', await s.isActive(link), true);
    await s.press(Key.Escape);
    await s.gone('dialog', 'Expanded table');
    row.expect('focus returns to Expand table', await s.isActive(expand), true);

    const inline = (await s.all('button', 'Copy table Markdown')).at(-1);
    await inline.click();
    await until('Copied', async () => /Copied/.test(await inline.text()));
    row.expect('system clipboard after Copy table Markdown in the reply', readClipboard(), TABLE);

    const composer = await composerOf(s, familiar);
    const reach = await composer.evaluate(`const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight + 0.5 && box.left >= 0 && box.right <= innerWidth + 0.5;`);
    row.expect('composer reachable at 480x520 after closing', reach, true);
  } catch (error) {
    row.error = error.message;
  } finally {
    await resize(s, 1180, 780).catch(() => undefined);
    try {
      const settings = await openSettingsGeneral(s);
      await (
        await settings.evaluate(
          `return node.querySelector('input[name="coven-text-size"][value="default"]').closest('label');`,
        )
      ).click();
      await closeSettings(s);
    } catch {
      // The text size is a convenience for later rows, not part of their evidence.
    }
  }
  return row;
}

/** Row 6, keyboard and in-window pointer parts. */
export async function inspectorRow(s, familiar) {
  const row = new Row('504-6', 'Inspector resize (keyboard part)');
  try {
    await resize(s, 1400, 800);
    const handle = await s.one('separator', 'Resize inspector');
    const width = () =>
      s.execute(`return document.querySelector('.fr-inspector').getBoundingClientRect().width;`);
    row.expect('default width', await width(), 360);
    row.expect('separator value', await handle.attribute('aria-valuenow'), '360');
    row.expect('separator orientation', await handle.attribute('aria-orientation'), 'vertical');
    await handle.focus();
    await s.press(Key.ArrowLeft);
    row.expect('ArrowLeft widens by 16px', await width(), 376);
    await s.press(Key.ArrowRight);
    row.expect('ArrowRight narrows by 16px', await width(), 360);
    await s.press(Key.Home);
    row.note('Home', await width());
    await s.press(Key.End);
    const max = await width();
    row.expect('End reaches aria-valuemax', String(max), await handle.attribute('aria-valuemax'));

    await s.press(Key.Home);
    const min = await width();
    const box = await handle.rect();
    const x = box.x + box.width / 2;
    const y = box.y + 300;
    await s.drag({ x, y }, { x: x - 100, y });
    row.note('in-window synthetic drag of 100px (not real pointer capture)', {
      before: min,
      after: await width(),
      selectedText: await s.execute('return getSelection().toString();'),
    });

    await handle.focus();
    await s.press(Key.End);
    row.expect('End at 1400 wide', await width(), 600);
    let settings = await openSettingsGeneral(s);
    row.check('Settings > General shows the width', (await settings.text()).includes('600px'));
    await (await s.one('button', 'Reset inspector width', { within: settings })).click();
    await closeSettings(s);
    row.expect('Reset restores 360px', await width(), 360);

    await (await s.one('separator', 'Resize inspector')).focus();
    await s.press(Key.End);
    row.expect('stored width before narrowing', await width(), 600);
    await resize(s, 1000, 800);
    const narrow = await s.execute(`const rail = document.querySelector('.fr-inspector');
      const box = rail?.getBoundingClientRect();
      return { present: Boolean(rail), width: box?.width ?? 0, left: box?.left ?? null, view: innerWidth };`);
    row.note('inspector at 1000px wide (drawer tier)', narrow);
    const composer = await composerOf(s, familiar);
    row.check(
      'composer reachable at 1000px',
      await composer.evaluate(
        'const b = node.getBoundingClientRect(); return b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5;',
      ),
    );
    await resize(s, 1400, 800);
    await until(
      'the rail to return',
      async () => (await s.all('separator', 'Resize inspector')).length === 1,
    );
    row.expect('600px returns after widening again', await width(), 600);
    settings = await openSettingsGeneral(s);
    row.check('Settings still shows 600px', (await settings.text()).includes('600px'));
    await closeSettings(s);
  } catch (error) {
    row.error = error.message;
  } finally {
    await resize(s, 1180, 780).catch(() => undefined);
  }
  return row;
}

async function clickAt(s, element) {
  const box = await element.rect();
  await s.actions([
    {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        {
          type: 'pointerMove',
          origin: 'viewport',
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await s.release();
}

/** Row 4: switching familiars with a passage, a sheet and a review open. */
export async function switchRow(s, first, second) {
  const row = new Row('504-4', 'Chat-switch isolation');
  try {
    await (await s.one('button', second)).click();
    const other = await composerOf(s, second);
    await other.click();
    await other.type('Draft kept for later');
    await (await s.one('button', first)).click();
    await composerOf(s, first);

    await selectText(
      s,
      `const bubble = [...document.querySelectorAll('.fr-bubble--familiar')]
        .find((node) => node.textContent.includes('three steps'));
      range.selectNodeContents(bubble.querySelector('p'));`,
    );
    row.expect(
      'a passage is waiting to be quoted',
      (await s.all('button', 'Quote selection')).length,
      1,
    );
    await (await s.all('button', 'Expand table')).at(-1).click();
    const sheet = await s.one('dialog', 'Expanded table');
    const link = await s.one('link', 'Guide', { within: sheet });
    await link.focus();
    await s.press(Key.Enter);
    await s.one('dialog', REVIEW);
    row.note('open before the switch', 'passage, expanded table and link review');

    const rail = await s.one('button', second);
    const hit = await rail.evaluate(`const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));`);
    row.note('the familiar rail takes the pointer while the review is open', hit);
    await clickAt(s, rail);
    const switched = await until(
      'the switch to settle',
      async () => ((await s.all('textbox', `Message ${second}`)).length === 1 ? 'switched' : null),
      5_000,
    ).catch(() => 'not switched');
    row.note('pointer click on the other familiar', switched);
    if (switched !== 'switched') {
      throw new Error(
        'With the review open, a pointer click on the familiar rail does not switch familiars; no keyboard path was driven.',
      );
    }
    row.expect('review after the switch', (await s.all('dialog', REVIEW)).length, 0);
    row.expect('sheet after the switch', (await s.all('dialog', 'Expanded table')).length, 0);
    row.expect(
      'waiting quote after the switch',
      (await s.all('button', 'Quote selection')).length,
      0,
    );
    row.expect(
      'the new chat keeps its draft',
      await (await composerOf(s, second)).property('value'),
      'Draft kept for later',
    );
    row.note('focus after the switch', await focusedName(s));
    await (await composerOf(s, second)).clear();
    await (await s.one('button', first)).click();
    await composerOf(s, first);
  } catch (error) {
    row.error = error.message;
    for (let index = 0; index < 3; index += 1) await s.press(Key.Escape).catch(() => undefined);
  }
  return row;
}

/** Row 8: only the preferences key, with a numeric width, and no conversation text. */
export async function storageRow(s) {
  const row = new Row('504-8', 'Preference-only storage');
  try {
    const stored = await s.executeAsync(`const done = arguments[arguments.length - 1];
      const local = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        local[key] = localStorage.getItem(key);
      }
      const session = sessionStorage.length;
      const finish = (databases) => done({ local, session, databases });
      if (indexedDB.databases) indexedDB.databases().then((list) => finish(list.map((db) => db.name)), () => finish('unreadable'));
      else finish('unsupported');`);
    row.expect('localStorage keys', Object.keys(stored.local), ['opencoven.chat.preferences.v1']);
    const preferences = JSON.parse(stored.local['opencoven.chat.preferences.v1']);
    row.note('stored preferences', preferences);
    row.expect('inspectorWidth is a number', typeof preferences.inspectorWidth, 'number');
    row.expect('sessionStorage entries', stored.session, 0);
    row.note('IndexedDB databases', stored.databases);
    if (Array.isArray(stored.databases)) row.expect('IndexedDB databases', stored.databases, []);
    const text = JSON.stringify(stored);
    for (const needle of [
      'example.com',
      'example.test',
      '[::1]',
      'three steps',
      'Field',
      'wide-',
      'Draft kept',
    ]) {
      row.expect(`stored text containing "${needle}"`, text.includes(needle), false);
    }
  } catch (error) {
    row.error = error.message;
  }
  return row;
}

/** Row 1's right-click part, last because a native menu can hold input. */
export async function rightClickRow(s, opened) {
  const row = new Row('504-1-context', 'Right-click on a link (partial)');
  try {
    const before = opened.received().length;
    const link = (await s.all('link', 'Handoff check')).at(-1);
    await s.click(link, { button: 2 });
    await sleep(1_500);
    row.expect('right-click opens the review', (await s.all('dialog', REVIEW)).length, 0);
    row.expect('right-click reaches the browser', opened.received().length - before, 0);
    row.note('native menu contents', 'not observable through WebDriver; hand-run');
    await s.press(Key.Escape);
  } catch (error) {
    row.error = error.message;
  }
  return row;
}
