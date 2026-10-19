import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchNavigation } from '../test/watch-navigation';
import { LinkReviewContext } from './external-link-review';
import { FormattedMessage } from './formatted-message';
import {
  TABLE_COLUMN_LIMIT,
  TABLE_ROW_LIMIT,
  TABLE_SOURCE_LIMIT,
  type TableNode,
  tableSource,
} from './markdown-table';

const EXPANDED = { name: 'Expanded table' } as const;
const REVIEW = { name: 'Open this link?' } as const;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let navigation: ReturnType<typeof watchNavigation>;

beforeEach(() => {
  navigation = watchNavigation();
});

afterEach(() => {
  navigation.stop();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  vi.restoreAllMocks();
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  // The legacy path refuses too, so a rejected write is a real failure.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
}

function expanded() {
  return screen.getByRole('dialog', EXPANDED);
}

function expandButtons() {
  return screen.getAllByRole('button', { name: 'Expand table' });
}

function copyButtons() {
  return screen.getAllByRole('button', { name: 'Copy table Markdown' });
}

/** A transcript stand-in: a focusable conversation log around messages, bound to a chat. */
function Conversation({ chat, children }: { chat: string; children: ReactNode }) {
  const log = useRef<HTMLDivElement>(null);
  return (
    <LinkReviewContext.Provider value={{ key: chat, fallback: () => log.current }}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: mirrors the scrollable transcript. */}
      <div ref={log} role="log" aria-label="Messages" tabIndex={0}>
        {children}
      </div>
    </LinkReviewContext.Provider>
  );
}

const TABLE = '| Name | State |\n| --- | :-: |\n| Item | **Ready** |';

/** A syntax-tree table as react-markdown hands it to the `table` component. */
function tableNode(start: number, end: number, columns: number, rows: number): TableNode {
  const cell = (tagName: string): TableNode => ({ type: 'element', tagName, children: [] });
  const row = (tagName: string): TableNode => ({
    type: 'element',
    tagName: 'tr',
    children: Array.from({ length: columns }, () => cell(tagName)),
  });
  const body: TableNode[] = rows
    ? [
        {
          type: 'element',
          tagName: 'tbody',
          children: Array.from({ length: rows }, () => row('td')),
        },
      ]
    : [];
  return {
    type: 'element',
    tagName: 'table',
    position: { start: { offset: start }, end: { offset: end } },
    children: [{ type: 'element', tagName: 'thead', children: [row('th')] }, ...body],
  };
}

function tableText(columns: number, rows: number, cell = 'x'): string {
  const line = (value: string) => `| ${Array.from({ length: columns }, () => value).join(' | ')} |`;
  return [line('h'), line('---'), ...Array.from({ length: rows }, () => line(cell))].join('\n');
}

describe('tableSource', () => {
  it('returns the exact source slice, escapes and alignment markers included', () => {
    const text =
      'Before\n\n| a \\| b | `c|d` |\n|:--|--:|\n| [x](https://e.example/?q=1|2) | *é* 🙂 |\n\nAfter';
    const start = text.indexOf('| a');
    const end = text.indexOf('\n\nAfter');
    expect(tableSource(text, tableNode(start, end, 2, 1))).toEqual({
      kind: 'ready',
      source: '| a \\| b | `c|d` |\n|:--|--:|\n| [x](https://e.example/?q=1|2) | *é* 🙂 |',
      rows: 1,
      columns: 2,
    });
  });

  it('tells two identical tables apart by their own ranges', () => {
    const text = `${TABLE}\n\n${TABLE}`;
    const second = TABLE.length + 2;
    expect(tableSource(text, tableNode(0, TABLE.length, 2, 1))).toMatchObject({
      kind: 'ready',
      source: TABLE,
    });
    expect(tableSource(text, tableNode(second, second + TABLE.length, 2, 1))).toMatchObject({
      kind: 'ready',
      source: TABLE,
    });
  });

  it('keeps a row that ends in a carriage return as written', () => {
    const text = '| a |\n|---|\n| 1 |\r\n| 2 |';
    expect(tableSource(text, tableNode(0, text.length, 1, 2))).toMatchObject({
      kind: 'ready',
      source: text,
    });
  });

  it('accepts a header-only table', () => {
    const text = '| a | b |\n|---|---|';
    expect(tableSource(text, tableNode(0, text.length, 2, 0))).toMatchObject({
      kind: 'ready',
      rows: 0,
      columns: 2,
    });
  });

  it('is unavailable when the slice is not the table alone', () => {
    // Inside a quote the parser's range spans the quote markers of later lines.
    const quoted = '> | a |\n> |---|\n> | 1 |';
    expect(tableSource(quoted, tableNode(2, quoted.length, 1, 1))).toEqual({
      kind: 'unavailable',
    });
    // A range that does not cover one line per row cannot be the table's source.
    expect(tableSource(TABLE, tableNode(0, TABLE.length, 2, 3))).toEqual({ kind: 'unavailable' });
    // Columns the delimiter row does not declare.
    expect(tableSource(TABLE, tableNode(0, TABLE.length, 3, 1))).toEqual({ kind: 'unavailable' });
    // No position at all, or one past the text.
    expect(tableSource(TABLE, undefined)).toEqual({ kind: 'unavailable' });
    expect(tableSource(TABLE, { type: 'element', tagName: 'table' })).toEqual({
      kind: 'unavailable',
    });
    expect(tableSource(TABLE, tableNode(0, TABLE.length + 5, 2, 1))).toEqual({
      kind: 'unavailable',
    });
    expect(tableSource(TABLE, tableNode(4, 2, 2, 1))).toEqual({ kind: 'unavailable' });
  });

  it('offers tables up to the row and column limits and refuses one more', () => {
    const atRows = tableText(1, TABLE_ROW_LIMIT);
    expect(tableSource(atRows, tableNode(0, atRows.length, 1, TABLE_ROW_LIMIT))).toMatchObject({
      kind: 'ready',
      rows: TABLE_ROW_LIMIT,
    });
    const overRows = tableText(1, TABLE_ROW_LIMIT + 1);
    expect(tableSource(overRows, tableNode(0, overRows.length, 1, TABLE_ROW_LIMIT + 1))).toEqual({
      kind: 'too-large',
      limit: 'rows',
      rows: TABLE_ROW_LIMIT + 1,
    });
    const atColumns = tableText(TABLE_COLUMN_LIMIT, 1);
    expect(
      tableSource(atColumns, tableNode(0, atColumns.length, TABLE_COLUMN_LIMIT, 1)),
    ).toMatchObject({ kind: 'ready', columns: TABLE_COLUMN_LIMIT });
    const overColumns = tableText(TABLE_COLUMN_LIMIT + 1, 1);
    expect(
      tableSource(overColumns, tableNode(0, overColumns.length, TABLE_COLUMN_LIMIT + 1, 1)),
    ).toEqual({ kind: 'too-large', limit: 'columns', columns: TABLE_COLUMN_LIMIT + 1 });
  });

  it('measures the source limit in UTF-8 bytes, not characters', () => {
    const frame = '| h |\n|---|\n| ';
    const close = ' |';
    const room = TABLE_SOURCE_LIMIT - frame.length - close.length;
    const ascii = `${frame}${'a'.repeat(room)}${close}`;
    expect(new TextEncoder().encode(ascii)).toHaveLength(TABLE_SOURCE_LIMIT);
    expect(tableSource(ascii, tableNode(0, ascii.length, 1, 1))).toMatchObject({ kind: 'ready' });
    const over = `${frame}${'a'.repeat(room + 1)}${close}`;
    expect(tableSource(over, tableNode(0, over.length, 1, 1))).toEqual({
      kind: 'too-large',
      limit: 'bytes',
      bytes: TABLE_SOURCE_LIMIT + 1,
    });
    // Two bytes each: the same character count as a fitting ASCII cell is over.
    const wide = `${frame}${'é'.repeat(room)}${close}`;
    expect(tableSource(wide, tableNode(0, wide.length, 1, 1))).toEqual({
      kind: 'too-large',
      limit: 'bytes',
      bytes: TABLE_SOURCE_LIMIT + room,
    });
  });
});

describe('table controls in a message', () => {
  it('adds Copy table Markdown and Expand table to each table and keeps the table itself', () => {
    const { container } = render(
      <FormattedMessage text={`Intro\n\n${TABLE}\n\nMiddle\n\n| x |\n|---|\n| 1 |\n\nEnd`} />,
    );
    expect(copyButtons()).toHaveLength(2);
    expect(expandButtons()).toHaveLength(2);
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ready' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Table' })).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies the exact source of the table that was pressed, escapes and links included', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const first = '| a \\| b | code |\n|:--|--:|\n| [x](https://e.example/?q=1) | `c|d` *é* 🙂 |';
    const second = '| only |\n| --- |\n| two |';
    render(<FormattedMessage text={`${first}\n\nBetween\n\n${second}`} />);
    const [copyFirst, copySecond] = copyButtons();
    await act(async () => {
      fireEvent.click(copySecond as HTMLElement);
    });
    expect(writeText).toHaveBeenLastCalledWith(second);
    await act(async () => {
      fireEvent.click(copyFirst as HTMLElement);
    });
    expect(writeText).toHaveBeenLastCalledWith(first);
    expect(copyFirst).toHaveTextContent('Copied');
    expect(screen.getByRole('cell', { name: 'two' })).toBeInTheDocument();
  });

  it('never says Copied when the clipboard refuses, and a retry can succeed', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined);
    stubClipboard(writeText);
    render(<FormattedMessage text={TABLE} />);
    const [copy] = copyButtons();
    await act(async () => {
      fireEvent.click(copy as HTMLElement);
    });
    expect(copy).toHaveTextContent('Copy failed');
    expect(copy).not.toHaveTextContent('Copied');
    await act(async () => {
      fireEvent.click(copy as HTMLElement);
    });
    expect(copy).toHaveTextContent('Copied');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('cell', { name: 'Ready' })).toBeInTheDocument();
  });

  it('preserves reference links resolved outside the table in its snapshot', () => {
    render(
      <FormattedMessage
        text={'| Site |\n| --- |\n| [Docs][docs] |\n\n[docs]: https://docs.example/'}
      />,
    );
    fireEvent.click(expandButtons()[0] as HTMLElement);
    const link = within(expanded()).getByRole('link', { name: 'Docs' });
    fireEvent.click(link);
    expect(screen.getByRole('dialog', REVIEW)).toHaveTextContent('https://docs.example/');
  });

  it('expands into a labelled dialog, keeps Tab inside, and Escape returns focus to Expand', () => {
    render(<FormattedMessage text={`${TABLE}\n\nMore [docs](https://d.example/) here.`} />);
    const [expand] = expandButtons();
    fireEvent.click(expand as HTMLElement);
    const dialog = expanded();
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveTextContent('as it read when you expanded it');
    expect(within(dialog).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(within(dialog).getByRole('cell', { name: 'Ready' })).toBeInTheDocument();
    // The snapshot holds the table alone, not the prose around it.
    expect(dialog).not.toHaveTextContent('More');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    const copy = within(dialog).getByRole('button', { name: 'Copy table Markdown' });
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(close);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const last = document.activeElement as HTMLElement;
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
    expect(copy).toBeInTheDocument();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(expand).toHaveFocus();
  });

  it('closes on the Close control or a click outside and returns focus to Expand', () => {
    render(<FormattedMessage text={TABLE} />);
    const [expand] = expandButtons();
    fireEvent.click(expand as HTMLElement);
    fireEvent.click(within(expanded()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(expand).toHaveFocus();
    fireEvent.click(expand as HTMLElement);
    fireEvent.click(expanded());
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(expand).toHaveFocus();
  });

  it('shows a snapshot that a changed message does not alter until it is expanded again', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const view = render(<FormattedMessage text={TABLE} />);
    fireEvent.click(expandButtons()[0] as HTMLElement);
    const grown = `${TABLE}\n| Later | **Added** |`;
    view.rerender(<FormattedMessage text={grown} />);
    const dialog = expanded();
    expect(within(dialog).queryByRole('cell', { name: 'Added' })).toBeNull();
    expect(within(dialog).getByRole('cell', { name: 'Ready' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy table Markdown' }));
    });
    expect(writeText).toHaveBeenLastCalledWith(TABLE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(expandButtons()[0] as HTMLElement);
    expect(within(expanded()).getByRole('cell', { name: 'Added' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(expanded()).getByRole('button', { name: 'Copy table Markdown' }));
    });
    expect(writeText).toHaveBeenLastCalledWith(grown);
  });

  it('keeps the same table element and an open snapshot while prose streams in after it', () => {
    const view = render(<FormattedMessage text={`${TABLE}\n\nThen`} />);
    const table = screen.getByRole('table');
    fireEvent.click(expandButtons()[0] as HTMLElement);
    view.rerender(<FormattedMessage text={`${TABLE}\n\nThen more words arrive`} />);
    view.rerender(<FormattedMessage text={`${TABLE}\n\nThen more words arrive, and more.`} />);
    expect(screen.getAllByRole('table')[0]).toBe(table);
    expect(expanded()).toBeInTheDocument();
    expect(expandButtons()).toHaveLength(1);
  });

  it('holds one expanded table at a time', () => {
    render(
      <Conversation chat="a">
        <FormattedMessage text={TABLE} />
        <FormattedMessage text={'| x |\n|---|\n| 1 |'} />
      </Conversation>,
    );
    const [first, second] = expandButtons();
    fireEvent.click(first as HTMLElement);
    fireEvent.click(second as HTMLElement);
    expect(screen.getAllByRole('dialog', EXPANDED)).toHaveLength(1);
    expect(within(expanded()).queryByRole('cell', { name: '1' })).toBeNull();
    fireEvent.click(within(expanded()).getByRole('button', { name: 'Close' }));
    fireEvent.click(second as HTMLElement);
    expect(within(expanded()).getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  it('reviews a link inside the expanded table and closes only the topmost flow on Escape', () => {
    const address = 'https://table.example/row?x=1';
    render(
      <Conversation chat="a">
        <FormattedMessage text={`| Site |\n|---|\n| [Row link](${address}) |`} />
      </Conversation>,
    );
    fireEvent.click(expandButtons()[0] as HTMLElement);
    const dialog = expanded();
    const link = within(dialog).getByRole('link', { name: 'Row link' });
    expect(link).not.toHaveAttribute('href');
    fireEvent.click(link);
    expect(navigation.opened).toEqual([]);
    const review = screen.getByRole('dialog', REVIEW);
    expect(within(review).getByText(address)).toHaveClass('coven-link-review-address');
    fireEvent.keyDown(within(review).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(expanded()).toBeInTheDocument();
    expect(link).toHaveFocus();
    fireEvent.click(link);
    fireEvent.click(within(screen.getByRole('dialog', REVIEW)).getByRole('link', { name: 'Open' }));
    expect(navigation.opened).toEqual([address]);
    expect(expanded()).toBeInTheDocument();
    fireEvent.keyDown(
      within(screen.getByRole('dialog', REVIEW)).getByRole('button', { name: 'Close' }),
      {
        key: 'Escape',
      },
    );
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(expandButtons()[0]).toHaveFocus();
  });

  it('closes when the conversation changes and returns focus to it', () => {
    const view = render(
      <Conversation chat="astra:s-1">
        <FormattedMessage text={TABLE} />
      </Conversation>,
    );
    fireEvent.click(expandButtons()[0] as HTMLElement);
    view.rerender(
      <Conversation chat="bram:s-2">
        <FormattedMessage text={TABLE} />
      </Conversation>,
    );
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveFocus();
  });

  it('closes when its message is removed and returns focus to the conversation', () => {
    const view = render(
      <Conversation chat="a">
        <FormattedMessage text={TABLE} />
      </Conversation>,
    );
    fireEvent.click(expandButtons()[0] as HTMLElement);
    view.rerender(<Conversation chat="a">{null}</Conversation>);
    expect(screen.queryByRole('dialog', EXPANDED)).toBeNull();
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveFocus();
  });

  it('keeps raw HTML and remote images out of the snapshot and fetches nothing', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = render(
      <FormattedMessage
        text={
          '| Cell |\n|---|\n| <script>alert(1)</script> ![pixel](https://e.example/p.png) [bad](javascript:alert(1)) |'
        }
      />,
    );
    fireEvent.click(expandButtons()[0] as HTMLElement);
    const dialog = expanded();
    expect(dialog.querySelector('script, img, a[href]')).toBeNull();
    expect(within(dialog).getByText('[Image: pixel]')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy table Markdown' }));
    expect(container.querySelector('script, img')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps the table and explains when it is past a limit, without the controls', () => {
    const rows = tableText(1, TABLE_ROW_LIMIT + 1, 'r');
    const columns = tableText(TABLE_COLUMN_LIMIT + 1, 1, 'c');
    const { container } = render(<FormattedMessage text={`${rows}\n\n${columns}`} />);
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(TABLE_ROW_LIMIT + 2);
    expect(screen.queryByRole('button', { name: 'Expand table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy table Markdown' })).toBeNull();
    expect(
      screen.getByText(
        `Expand and copy are off for this table: it has ${(TABLE_ROW_LIMIT + 1).toLocaleString('en-US')} rows, and Chat offers them for tables up to ${TABLE_ROW_LIMIT.toLocaleString('en-US')} rows.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Expand and copy are off for this table: it has ${TABLE_COLUMN_LIMIT + 1} columns, and Chat offers them for tables up to ${TABLE_COLUMN_LIMIT} columns.`,
      ),
    ).toBeInTheDocument();
  });

  it('explains when the source is too large or cannot be matched exactly', () => {
    const big = `| h |\n|---|\n| ${'a'.repeat(TABLE_SOURCE_LIMIT)} |`;
    render(<FormattedMessage text={`${big}\n\n> | q |\n> |---|\n> | 1 |`} />);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Expand table' })).toBeNull();
    expect(
      screen.getByText(
        `Expand and copy are off for this table: its source is ${Math.ceil((TABLE_SOURCE_LIMIT + 16) / 1024).toLocaleString('en-US')} KB, and Chat offers them for tables up to ${TABLE_SOURCE_LIMIT / 1024} KB.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Expand and copy are off for this table: Chat can't match it to its exact source. Copy on the reply copies the whole reply, table included.",
      ),
    ).toBeInTheDocument();
  });
});
