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

/** Called with a row's id when it fails, before the window is reset. */
let snapshot = async () => undefined;
export function onFailure(take) {
  snapshot = take;
}

export async function composerOf(s, familiar) {
  return s.one('textbox', `Message ${familiar}`, { timeout: 30_000 });
}

/** Empties the draft as a person would. WebDriver's clear() bypasses React's state. */
async function clearComposer(s, composer) {
  await composer.focus();
  await s.press([Key.Control, 'a'], Key.Backspace);
  await until('an empty draft', async () => (await composer.property('value')) === '', 5_000);
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

/** Closes whatever review, sheet or menu a failed step left open. */
async function reset(s) {
  for (let index = 0; index < 3; index += 1) await s.press(Key.Escape).catch(() => undefined);
  await s.execute('getSelection()?.removeAllRanges();').catch(() => undefined);
}

/** Runs one row's steps; a failure is recorded on that row and the window is reset. */
async function attempt(s, row, work) {
  try {
    await work();
  } catch (error) {
    row.error = error.message;
    await snapshot(row.id);
    await reset(s);
  }
}

async function copyAddress(s, row, label, expected) {
  const { review } = await reviewParts(s);
  await (await s.one('button', 'Copy address', { within: review })).click();
  await until(
    'the copy status',
    async () => (await reviewParts(s)).status === 'Copied the address.',
  );
  row.expect(`${label}: Copy address status`, (await reviewParts(s)).status, 'Copied the address.');
  row.expect(`${label}: system clipboard after Copy address`, readClipboard(), expected);
}

/** Rows 1, 2 (keyboard part) and 9, and #515's handoff. */
export async function linkRows(s, familiar, opened, requests) {
  const row1 = new Row('504-1', 'Link gestures, copy, review');
  const row2 = new Row('504-2', 'Modality and focus return (keyboard part)');
  const row9 = new Row('504-9', 'IPv6 address');
  const handoff = new Row('515', 'Open hands the exact address to the system browser');
  const results = [row1, row2, row9, handoff];

  try {
    await send(s, familiar, '[[links]] Where are the docs?', 'link', 'Handoff check');
  } catch (error) {
    row1.error = `The reply never rendered: ${error.message}`;
    for (const row of results.slice(1)) row.skipped = true;
    return results;
  }
  const link = () => s.one('link', 'Handoff check');

  await attempt(s, row1, async () => {
    row1.expect(
      'transcript anchors with a live http(s) href',
      (await s.css('.fr-transcript a[href^="http"]')).length,
      0,
    );
    await s.click(await link());
    const parts = await reviewParts(s);
    row1.check('primary click opens the review', Boolean(parts.review));
    row1.expect('review site', parts.host, 'example.com');
    row1.expect('review address', parts.address, ADDRESSES.query);
    await closeReview(s);
    await s.click(await link(), { modifier: Key.Control });
    row1.expect('Ctrl-click opens the review', (await s.all('dialog', REVIEW)).length, 1);
    await (await s.one('button', 'Cancel', { within: (await reviewParts(s)).review })).click();
    await s.gone('dialog', REVIEW);
    await s.click(await link(), { button: 1 });
    row1.expect('middle-click opens the review', (await s.all('dialog', REVIEW)).length, 1);
    await closeReview(s);
    row1.expect('nothing reached the browser from review gestures', opened.received().length, 0);
    await s.click(await link());
    await copyAddress(s, row1, 'query address', ADDRESSES.query);
    await closeReview(s);
  });

  await attempt(s, row2, async () => {
    const anchor = await link();
    await s.click(anchor);
    await reviewParts(s);
    row2.expect('focus when the review opens', await focusedName(s), 'Cancel');
    for (const name of ['Copy address', 'Open', 'Cancel']) {
      await s.press(Key.Tab);
      row2.expect(`Tab moves focus to ${name}`, await focusedName(s), name);
    }
    await closeReview(s);
    row2.expect(
      'Escape closes the review and focus returns to the link',
      await s.isActive(anchor),
      true,
    );

    // A click outside closes the review by design; it must not reach what is behind it.
    await s.click(anchor);
    await reviewParts(s);
    const behind =
      await s.execute(`const composer = document.querySelector('.oc-composer textarea');
      const box = composer.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      return { hit: composer.contains(document.elementFromPoint(x, y)), x, y, value: composer.value };`);
    row2.expect('the composer behind the review is hit-testable', behind.hit, false);
    const sent = requests();
    await s.actions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          {
            type: 'pointerMove',
            origin: 'viewport',
            x: Math.round(behind.x),
            y: Math.round(behind.y),
          },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await s.release();
    await sleep(500);
    row2.note(
      'review after a click where the composer is',
      (await s.all('dialog', REVIEW)).length ? 'open' : 'closed',
    );
    row2.expect(
      'the composer took focus from that click',
      await s.execute("return Boolean(document.activeElement?.closest('.oc-composer'));"),
      false,
    );
    row2.expect(
      'composer text after that click',
      await s.execute("return document.querySelector('.oc-composer textarea').value;"),
      behind.value,
    );
    row2.expect('model requests after that click', requests(), sent);
    if ((await s.all('dialog', REVIEW)).length === 0) {
      row2.expect(
        'focus returns to the link after the outside click',
        await s.isActive(anchor),
        true,
      );
    } else {
      await closeReview(s);
    }
  });

  await attempt(s, handoff, async () => {
    await s.click(await link());
    await openOnce(s, handoff, opened, ADDRESSES.query);
    await closeReview(s);
    await s.click(await s.one('link', 'Plain address'));
    handoff.expect('review address (plain)', (await reviewParts(s)).address, ADDRESSES.plain);
    await openOnce(s, handoff, opened, ADDRESSES.plain);
    await closeReview(s);
  });

  await attempt(s, row9, async () => {
    await s.click(await s.one('link', 'Loopback six'));
    const parts = await reviewParts(s);
    row9.expect('review site', parts.host, '[::1]:8080');
    row9.expect('review address', parts.address, ADDRESSES.ipv6);
    await copyAddress(s, row9, 'IPv6 address', ADDRESSES.ipv6);
    await openOnce(s, row9, opened, ADDRESSES.ipv6);
    await closeReview(s);
  });
  return results;
}

async function openOnce(s, row, opened, address) {
  const before = opened.received().length;
  const { review } = await reviewParts(s);
  const open = await s.one('button', 'Open', { within: review });
  await open.click();
  try {
    await until('the Open status', async () =>
      ((await review.text()) ?? '').includes('Sent the address to your browser.'),
    );
  } catch {
    row.note('review text after Open', ((await review.text()) ?? '').replace(/\s+/g, ' ').trim());
    row.note('browser launches recorded', opened.received().length - before);
    throw new Error('The review never said "Sent the address to your browser."');
  }
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
    await clearComposer(s, composer);
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
    // The action follows the conversation in the tab order: Tab from whatever precedes it.
    const previous = await s.execute(
      `const focusable = [...document.querySelectorAll('a[href], button, textarea, input, select, [tabindex]')]
        .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
      const index = focusable.indexOf(arguments[0]);
      return index > 0 ? focusable[index - 1] : null;`,
      quote,
    );
    row.check('a control precedes the action in the tab order', Boolean(previous));
    row.note(
      'the control before the action',
      await previous.evaluate(
        "return (node.getAttribute('aria-label') || node.textContent || node.tagName).trim().slice(0, 60);",
      ),
    );
    await previous.focus();
    await s.press(Key.Tab);
    row.expect(
      'Tab reaches the action with the passage still captured',
      await s.isActive(quote),
      true,
    );
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

    await clearComposer(s, composer);
    const cell = await selectText(
      s,
      `const cell = [...document.querySelectorAll('.fr-bubble--familiar td')]
        .find((node) => node.textContent.trim() === 'a | b');
      range.selectNodeContents(cell);`,
    );
    row.note('selection inside one table cell', cell);
    await (await s.one('button', 'Quote selection')).click();
    row.expect('a table cell quotes', await composer.property('value'), '> a | b\n\n');

    await clearComposer(s, composer);
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
    await clearComposer(s, composer);
  } catch (error) {
    row.error = error.message;
    await snapshot(row.id);
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
    row.note(
      'inspector and its resize handle at 480x520',
      await s.execute(`const aside = document.querySelector('.fr-inspector');
        const handle = document.querySelector('.coven-inspector-resizer');
        const describe = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          const c = getComputedStyle(el);
          return {
            rect: [b.left, b.top, b.width, b.height].map(Math.round),
            inert: el.inert, ariaHidden: el.getAttribute('aria-hidden'),
            opacity: c.opacity, visibility: c.visibility, transform: c.transform,
            pointerEvents: c.pointerEvents, zIndex: c.zIndex,
          };
        };
        const strip = [];
        for (let x = 40; x < innerWidth; x += 40) {
          const hit = document.elementFromPoint(x, 260);
          strip.push(x + ':' + (hit ? hit.className.toString().split(' ')[0] || hit.tagName.toLowerCase() : 'none'));
        }
        return {
          inspector: document.querySelector('.coven-chat')?.getAttribute('data-inspector') ?? null,
          aside: describe(aside), handle: describe(handle), hitsAtY260: strip,
        };`),
    );

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
    await snapshot(row.id);
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
    await s.execute('getSelection()?.removeAllRanges();');
    await resize(s, 1400, 800);
    const show = await s.all('button', 'Show inspector');
    if (show.length) {
      row.note('inspector at the start of the row', 'closed; pressed Show inspector');
      await s.click(show[0]);
    }
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
    const box = await handle.evaluate(
      'const b = node.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };',
    );
    await s.execute('getSelection()?.removeAllRanges();');
    await s.drag(box, { x: box.x - 100, y: box.y });
    row.note('in-window synthetic drag of 100px (not real pointer capture)', {
      before: min,
      after: await width(),
      selectedText: await s.execute('return getSelection().toString();'),
    });

    await handle.focus();
    await s.press(Key.End);
    row.expect('End at 1400 wide', await width(), 600);
    let settings = await openSettingsGeneral(s);
    const general = await settings.evaluate('return node.textContent.replace(/\\s+/g, " ");');
    row.check(
      'Settings > General shows the width',
      general.includes('600px'),
      general.slice(0, 400),
    );
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
    const returned = await until(
      'the rail to return',
      async () => (await s.all('separator', 'Resize inspector')).length === 1,
      10_000,
    ).catch(() => false);
    if (!returned) {
      row.note(
        'inspector after widening to 1400px',
        await s.execute(`const rail = document.querySelector('.fr-inspector');
          const box = rail?.getBoundingClientRect();
          const named = (label) => [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === label && b.getClientRects().length);
          return {
            present: Boolean(rail), width: box?.width ?? 0, left: box?.left ?? null, view: innerWidth,
            showInspector: named('Show inspector'), closeInspector: named('Close inspector'),
            chat: document.querySelector('.coven-chat')?.getAttribute('data-inspector') ?? null,
          };`),
      );
      const show = await s.all('button', 'Show inspector');
      if (show.length) {
        await s.click(show[0]);
        await sleep(500);
        row.note(
          'width after pressing Show inspector',
          await s.execute(
            "return document.querySelector('.fr-inspector')?.getBoundingClientRect().width ?? null;",
          ),
        );
      }
      throw new Error(
        'After narrowing across 1100px and widening to 1400px, the inspector came back closed, not as the 600px rail.',
      );
    }
    row.expect('600px returns after widening again', await width(), 600);
    settings = await openSettingsGeneral(s);
    const again = await settings.evaluate('return node.textContent.replace(/\\s+/g, " ");');
    row.check('Settings still shows 600px', again.includes('600px'), again.slice(0, 400));
    await closeSettings(s);
  } catch (error) {
    row.error = error.message;
    await snapshot(row.id);
  } finally {
    await resize(s, 1180, 780).catch(() => undefined);
  }
  return row;
}

/** Waits for a reply containing `text`; reports how long, or how long it showed loading. */
export async function conversationLoaded(s, row, text, timeout = 90_000) {
  const started = Date.now();
  try {
    await until(
      `a reply containing "${text}"`,
      () =>
        s.execute(
          "return [...document.querySelectorAll('.fr-bubble--familiar')].some((node) => node.textContent.includes(arguments[0]));",
          text,
        ),
      timeout,
      250,
    );
  } catch {
    const loading = await s.execute(
      "return document.body.innerText.includes('Loading conversation');",
    );
    row.note('conversation still showing "Loading conversation"', loading);
    throw new Error(
      `No reply containing "${text}" after ${timeout / 1000} s (loading shown: ${loading}).`,
    );
  }
  return Date.now() - started;
}

/** Opens a waiting passage, the expanded table and a link review inside it. */
async function openEverything(s, row) {
  await conversationLoaded(s, row, 'three steps');
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
  await s.click((await s.all('button', 'Expand table')).at(-1));
  const sheet = await s.one('dialog', 'Expanded table');
  const link = await s.one('link', 'Guide', { within: sheet });
  await link.focus();
  await s.press(Key.Enter);
  await s.one('dialog', REVIEW);
}

/** Types into a familiar's composer once focus has settled there. */
async function typeDraft(s, familiar, text) {
  const composer = await composerOf(s, familiar);
  await sleep(500);
  await composer.focus();
  await until('the composer to hold focus', () => s.isActive(composer), 5_000);
  await composer.type(text);
  return composer;
}

/** Row 4: switching familiars with a passage, a sheet and a review open. */
export async function switchRow(s, first, second) {
  const row = new Row('504-4', 'Chat-switch isolation');
  const state = async () => ({
    review: (await s.all('dialog', REVIEW)).length,
    sheet: (await s.all('dialog', 'Expanded table')).length,
    quote: (await s.all('button', 'Quote selection')).length,
    chat: (await s.all('textbox', `Message ${second}`)).length ? second : first,
  });
  try {
    await s.click(await s.one('button', second));
    await typeDraft(s, second, 'Draft kept for later');
    await s.click(await s.one('button', first));
    await composerOf(s, first);
    await openEverything(s, row);
    row.note('open before switching', await state());

    // Ctrl+[ and Ctrl+] step familiars, but not while a dialog is open
    // (shellChord in rail-shortcuts.ts), so with the review open nothing moves.
    await s.press([Key.Control, ']']);
    await sleep(1_000);
    row.expect('Ctrl+] with the review and sheet open', await state(), {
      review: 1,
      sheet: 1,
      quote: 1,
      chat: first,
    });

    // The rail: each click first closes one open layer, then the next switches.
    const target = await s.execute(
      `const row = [...document.querySelectorAll('button.coven-agent-row')].find((b) => b.getAttribute('aria-label') === arguments[0]);
      const box = row.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };`,
      second,
    );
    let now = await state();
    for (let click = 1; click <= 3 && now.chat !== second; click += 1) {
      await s.clickPoint(target.x, target.y);
      await sleep(800);
      now = await state();
      row.note(`after click ${click} on ${second} in the rail`, now);
    }
    row.expect('switched by the rail', now.chat, second);
    row.expect('review after the switch', now.review, 0);
    row.expect('sheet after the switch', now.sheet, 0);
    row.expect('waiting quote after the switch', now.quote, 0);
    row.expect(
      'the other chat kept its draft',
      await (await composerOf(s, second)).property('value'),
      'Draft kept for later',
    );
    row.note('focus after the switch', await focusedName(s));
    await clearComposer(s, await composerOf(s, second));

    // With nothing open, the keyboard switch works.
    await s.execute('document.activeElement?.blur();');
    await s.press([Key.Control, '[']);
    await until(
      'Ctrl+[ to step back',
      async () => (await s.all('textbox', `Message ${first}`)).length === 1,
      10_000,
    );
    row.note('Ctrl+[ with nothing open', `stepped back to ${first}`);
  } catch (error) {
    row.error = error.message;
    await snapshot(row.id);
    await reset(s);
    await s.click(await s.one('button', first)).catch(() => undefined);
  }
  return row;
}

/** Row 8: only navigation and preferences, a numeric width, and no conversation text. */
export async function storageRow(s) {
  const row = new Row('504-8', 'Preference-only storage (per SECURITY.md)');
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
    // SECURITY.md: the window keeps only the selected familiar (navigation) and
    // Settings choices (preferences) in localStorage. #504's row names only the latter.
    const keys = Object.keys(stored.local).sort();
    row.note('localStorage keys', keys);
    row.check(
      'only the navigation and preferences keys',
      keys.every((key) =>
        ['opencoven.chat.navigation.v1', 'opencoven.chat.preferences.v1'].includes(key),
      ) && keys.includes('opencoven.chat.preferences.v1'),
      keys,
    );
    if (stored.local['opencoven.chat.navigation.v1']) {
      const navigation = JSON.parse(stored.local['opencoven.chat.navigation.v1']);
      row.expect('navigation fields', Object.keys(navigation).sort(), ['familiarId', 'sessionId']);
    }
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
    await snapshot(row.id);
  }
  return row;
}

/** Row 1's right-click part, last because a native menu can hold input. */
export async function rightClickRow(s, familiar, opened) {
  const row = new Row('504-1-context', 'Right-click on a link (partial)');
  try {
    const before = opened.received().length;
    await s.click(await s.one('button', familiar));
    await conversationLoaded(s, row, 'three steps');
    const link = (await s.all('link', 'Handoff check')).at(-1);
    await link.evaluate(`window.__linkEvents = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu']) {
        node.addEventListener(type, (event) => window.__linkEvents.push(type + ':' + event.button), true);
      }`);
    await s.click(link, { button: 2 });
    await sleep(1_500);
    const events = await s.execute('return window.__linkEvents;');
    row.note('events the link received', events);
    if (events.includes('click:0')) {
      // A real right-button release sends no primary click. This driver does,
      // so whatever the review does next says nothing about a person's right-click.
      row.notJudged =
        'WebKitWebDriver followed the right press with mouseup and click for the primary button.';
      await s.press(Key.Escape);
      return row;
    }
    row.expect('right-click opens the review', (await s.all('dialog', REVIEW)).length, 0);
    row.expect('right-click reaches the browser', opened.received().length - before, 0);
    row.note('native menu contents', 'not observable through WebDriver; hand-run');
    await s.press(Key.Escape);
  } catch (error) {
    row.error = error.message;
    await snapshot(row.id);
  }
  return row;
}
