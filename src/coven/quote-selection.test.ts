import { afterEach, describe, expect, it } from 'vitest';
import {
  appendQuote,
  QUOTE_LIMIT_BYTES,
  QUOTE_SOURCE,
  quoteLines,
  selectedPassage,
} from './quote-selection';

const LIMIT = 32 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('quoteLines', () => {
  it('marks every line as a Markdown quote, blank lines included', () => {
    expect(quoteLines('one line')).toBe('> one line');
    expect(quoteLines('first\n\nsecond\n  indented')).toBe('> first\n>\n> second\n>   indented');
  });

  it('keeps the passage as written, apart from line endings and blank edges', () => {
    expect(quoteLines('a\r\nb\rc')).toBe('> a\n> b\n> c');
    expect(quoteLines('\n  \nkept  \n\n')).toBe('> kept');
    expect(quoteLines('  leading spaces stay')).toBe('>   leading spaces stay');
    expect(quoteLines('> already quoted')).toBe('> > already quoted');
    expect(quoteLines('líne twö 🌙 字')).toBe('> líne twö 🌙 字');
  });

  it('has nothing to quote in a blank passage', () => {
    expect(quoteLines('')).toBe('');
    expect(quoteLines(' \n\t\n ')).toBe('');
  });
});

describe('appendQuote', () => {
  it('appends after the draft as written, with blank lines around the quote', () => {
    expect(appendQuote('', 'passage', LIMIT)).toEqual({ kind: 'ready', draft: '> passage\n\n' });
    expect(appendQuote('Thanks!', 'passage', LIMIT)).toEqual({
      kind: 'ready',
      draft: 'Thanks!\n\n> passage\n\n',
    });
    expect(appendQuote('Thanks!\n', 'passage', LIMIT)).toEqual({
      kind: 'ready',
      draft: 'Thanks!\n\n> passage\n\n',
    });
    expect(appendQuote('> first\n\n', 'second', LIMIT)).toEqual({
      kind: 'ready',
      draft: '> first\n\n> second\n\n',
    });
    // Trailing spaces and odd spacing in the draft are the reader's; they stay.
    expect(appendQuote('  draft  ', 'p', LIMIT)).toEqual({
      kind: 'ready',
      draft: '  draft  \n\n> p\n\n',
    });
  });

  it('refuses a blank passage without touching the draft', () => {
    expect(appendQuote('draft', ' \n ', LIMIT)).toEqual({ kind: 'empty' });
  });

  it.each([
    ['ASCII', 'a', 1],
    ['two-byte', 'é', 2],
    ['four-byte', '🌙', 4],
  ])('allows a %s quote of exactly 4,096 bytes and refuses one more', (_kind, unit, size) => {
    // "> " + passage + "\n\n" is the whole insertion into an empty draft.
    const fits = unit.repeat((QUOTE_LIMIT_BYTES - 4) / size);
    const exact = appendQuote('', fits, LIMIT);
    expect(exact.kind).toBe('ready');
    expect(exact.kind === 'ready' && bytes(exact.draft)).toBe(QUOTE_LIMIT_BYTES);
    const over = appendQuote('', fits + unit, LIMIT);
    expect(over).toEqual({ kind: 'too-long', bytes: QUOTE_LIMIT_BYTES + size });
  });

  it('counts the blank lines that separate a quote from the draft', () => {
    const fits = 'a'.repeat(QUOTE_LIMIT_BYTES - 4);
    expect(appendQuote('', fits, LIMIT).kind).toBe('ready');
    // The same passage after existing text needs two more bytes of separator.
    expect(appendQuote('draft', fits, LIMIT)).toEqual({
      kind: 'too-long',
      bytes: QUOTE_LIMIT_BYTES + 2,
    });
  });

  it.each([
    ['ASCII', 'd', 1, 'q'],
    ['two-byte', 'é', 2, 'qq'],
  ])('keeps the combined %s draft at or under 32,768 bytes', (_kind, unit, size, passage) => {
    // "\n\n> " + passage + "\n\n" follows the draft.
    const insertion = 6 + passage.length;
    const draft = unit.repeat((LIMIT - insertion) / size);
    const exact = appendQuote(draft, passage, LIMIT);
    expect(exact.kind).toBe('ready');
    expect(exact.kind === 'ready' && bytes(exact.draft)).toBe(LIMIT);
    expect(appendQuote(draft + unit, passage, LIMIT)).toEqual({
      kind: 'draft-too-long',
      bytes: LIMIT + size,
    });
  });

  it('never shortens a passage to make it fit', () => {
    const long = `${'word '.repeat(900)}end`;
    const result = appendQuote('', long, LIMIT);
    expect(result.kind).toBe('too-long');
    expect(result).not.toHaveProperty('draft');
  });
});

describe('selectedPassage', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  /** Builds a message with its own text marked, and selects `from`..`to` inside the page. */
  function selectIn(html: string, from: string, to = from) {
    document.body.innerHTML = html;
    const texts: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node instanceof Text) texts.push(node);
    const start = texts.find((node) => node.data.includes(from));
    const end = texts.find((node) => node.data.includes(to));
    if (!start || !end) throw new Error('Missing text');
    const range = document.createRange();
    range.setStart(start, start.data.indexOf(from));
    range.setEnd(end, end.data.indexOf(to) + to.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selectedPassage(selection);
  }

  it('names the message and the text of a selection inside its own text', () => {
    const passage = selectIn(
      `<div ${QUOTE_SOURCE}="7"><p>alpha beta</p><p>gamma</p></div>`,
      'beta',
      'gam',
    );
    expect(passage?.id).toBe('7');
    expect(passage?.source.getAttribute(QUOTE_SOURCE)).toBe('7');
    expect(passage?.text).toBe('betagam');
  });

  it.each([
    ['a dialog opened from the message', '<dialog open><p>dialog text</p></dialog>'],
    ['hidden content', '<div hidden><p>dialog text</p></div>'],
    ['content kept from assistive technology', '<span aria-hidden="true">dialog text</span>'],
    ['folded details', '<details><summary>dialog text</summary></details>'],
  ])('refuses a selection that takes in %s', (_case, chrome) => {
    expect(
      selectIn(
        `<div ${QUOTE_SOURCE}="7"><p>before</p>${chrome}<p>after</p></div>`,
        'before',
        'after',
      ),
    ).toBeNull();
    expect(
      selectIn(`<div ${QUOTE_SOURCE}="7"><p>before</p>${chrome}</div>`, 'dialog text'),
    ).toBeNull();
  });

  it('refuses text outside any message, and a selection split over several ranges', () => {
    expect(selectIn('<p>loose text</p>', 'loose')).toBeNull();
    // Firefox can hold several ranges at once; jsdom keeps one, so stand one in.
    const split = { rangeCount: 2, isCollapsed: false } as unknown as Selection;
    expect(selectedPassage(split)).toBeNull();
    expect(selectedPassage(null)).toBeNull();
  });
});
