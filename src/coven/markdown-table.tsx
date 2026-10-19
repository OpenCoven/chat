import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CopyButton } from './copy-button';
import { LinkReviewContext, LinkReviewScope } from './external-link-review';
import './markdown-table.css';
import { closeModal, openModal } from './modal';

/** The largest table source, in UTF-8 bytes, that Chat offers to expand or copy. */
export const TABLE_SOURCE_LIMIT = 256 * 1024;
/** The most body rows a table may have and still be offered. */
export const TABLE_ROW_LIMIT = 2000;
/** The most columns a table may have and still be offered. */
export const TABLE_COLUMN_LIMIT = 64;

/**
 * The shape of the syntax-tree node react-markdown hands the `table`
 * component, typed structurally so this file needs no `hast` dependency.
 */
export type TableNode = Readonly<{
  type: string;
  tagName?: string | undefined;
  position?:
    | Readonly<{
        start: Readonly<{ offset?: number | undefined }>;
        end: Readonly<{ offset?: number | undefined }>;
      }>
    | undefined;
  children?: readonly TableNode[] | undefined;
}>;

/** What Chat established about a table's source before offering to expand or copy it. */
export type TableSource =
  | Readonly<{ kind: 'ready'; source: string; rows: number; columns: number }>
  | Readonly<{ kind: 'too-large'; limit: 'rows'; rows: number }>
  | Readonly<{ kind: 'too-large'; limit: 'columns'; columns: number }>
  | Readonly<{ kind: 'too-large'; limit: 'bytes'; bytes: number }>
  | Readonly<{ kind: 'unavailable' }>;

/** Where a table sits in its prose segment and what it renders. */
export type TableShape = Readonly<{ start: number; end: number; rows: number; columns: number }>;

const utf8 = new TextEncoder();

function elements(node: TableNode | undefined, tagName: string): readonly TableNode[] {
  return (node?.children ?? []).filter(
    (child) => child.type === 'element' && child.tagName === tagName,
  );
}

/** Reads a table's position and size off the parser's node; a missing position reads as -1. */
export function tableShape(node: TableNode | undefined): TableShape {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  const [head] = elements(node, 'thead');
  return {
    start: typeof start === 'number' ? start : -1,
    end: typeof end === 'number' ? end : -1,
    columns: elements(elements(head, 'tr')[0], 'th').length,
    rows: elements(elements(node, 'tbody')[0], 'tr').length,
  };
}

/** One delimiter cell: optional alignment colons around at least one dash. */
const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/**
 * The cells a delimiter row declares. It can hold no escapes or code, so a
 * split on "|" is exact. Up to three spaces of indentation are still a table
 * when pasted; a quote marker or deeper indentation is not.
 */
function delimiterColumns(line: string): number | null {
  const trimmed = line.replace(/^ {0,3}/, '').replace(/\s+$/, '');
  if (!trimmed || trimmed.startsWith(' ')) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|');
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.length;
}

/**
 * Judges a slice of the prose segment as a table's exact source. It is
 * accepted only when it reads as the table alone: one line per row, with a
 * delimiter row declaring the columns the table renders. A table inside a
 * quote fails that (the range spans the quote markers), and so does any
 * range the positions misreport; then the controls are withheld rather than
 * copying something else.
 */
export function analyzeTableSlice(slice: string, shape: TableShape): TableSource {
  const { start, end, rows, columns } = shape;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    slice.length !== end - start
  )
    return { kind: 'unavailable' };
  const lines = slice.split('\n');
  if (!columns || lines.length !== rows + 2) return { kind: 'unavailable' };
  if (!lines[0]?.trim() || delimiterColumns(lines[1] ?? '') !== columns)
    return { kind: 'unavailable' };
  if (rows > TABLE_ROW_LIMIT) return { kind: 'too-large', limit: 'rows', rows };
  if (columns > TABLE_COLUMN_LIMIT) return { kind: 'too-large', limit: 'columns', columns };
  const bytes = utf8.encode(slice).length;
  if (bytes > TABLE_SOURCE_LIMIT) return { kind: 'too-large', limit: 'bytes', bytes };
  return { kind: 'ready', source: slice, rows, columns };
}

/** Finds the exact source of a table in the prose segment it was parsed from. */
export function tableSource(text: string, node: TableNode | undefined): TableSource {
  const shape = tableShape(node);
  return analyzeTableSlice(text.slice(Math.max(shape.start, 0), Math.max(shape.end, 0)), shape);
}

const count = (value: number) => value.toLocaleString('en-US');

/** Why the controls are withheld, in words the reader can act on. */
export function tableNote(source: Exclude<TableSource, { kind: 'ready' }>): string {
  const off = 'Expand and copy are off for this table:';
  if (source.kind === 'unavailable')
    return `${off} Chat can't match it to its exact source. Copy on the reply copies the whole reply, table included.`;
  switch (source.limit) {
    case 'rows':
      return `${off} it has ${count(source.rows)} rows, and Chat offers them for tables up to ${count(TABLE_ROW_LIMIT)} rows.`;
    case 'columns':
      return `${off} it has ${count(source.columns)} columns, and Chat offers them for tables up to ${count(TABLE_COLUMN_LIMIT)} columns.`;
    case 'bytes':
      return `${off} its source is ${count(Math.ceil(source.bytes / 1024))} KB, and Chat offers them for tables up to ${count(TABLE_SOURCE_LIMIT / 1024)} KB.`;
  }
}

/** The exact prose segment the surrounding Markdown was parsed from, so positions resolve against it. */
export const ProseSourceContext = createContext<string>('');

/** Which table holds the one expanded snapshot, across every message on screen. */
let expandedOwner: symbol | null = null;

type Snapshot = Readonly<{
  source: string;
  children: ReactNode;
  origin: HTMLElement;
  key: string;
  fallback: () => HTMLElement | null;
}>;

/**
 * A table in a message: the same scrolling table as before, with two controls
 * above it. Copy table Markdown copies the table's exact source. Expand table
 * opens a dialog holding a snapshot of that source, retained from the same
 * safe Markdown parse; links inside it go through the same review as in the message.
 */
export function MarkdownTable({
  node,
  children,
}: Readonly<{
  node?: TableNode | undefined;
  children?: ReactNode;
}>) {
  const text = useContext(ProseSourceContext);
  const context = useContext(LinkReviewContext);
  const owner = useRef<symbol>(Symbol('table'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const { start, end, rows, columns } = tableShape(node);
  const slice = text.slice(Math.max(start, 0), Math.max(end, 0));
  // Keyed on the slice and shape, not the message: prose streaming in after
  // the table, or a composer keystroke, never reads the table again.
  const source = useMemo(
    () => analyzeTableSlice(slice, { start, end, rows, columns }),
    [slice, start, end, rows, columns],
  );
  // Another conversation never inherits this one's snapshot.
  useEffect(() => {
    setSnapshot((current) => (current && current.key !== context.key ? null : current));
  }, [context.key]);
  const current = snapshot?.key === context.key ? snapshot : null;
  const expand = (origin: HTMLElement) => {
    if (source.kind !== 'ready' || expandedOwner) return;
    expandedOwner = owner.current;
    setSnapshot({
      source: source.source,
      children,
      origin,
      key: context.key,
      fallback: context.fallback,
    });
  };
  const release = () => {
    if (expandedOwner === owner.current) expandedOwner = null;
    setSnapshot(null);
  };
  return (
    <>
      <div className="coven-table-bar">
        {source.kind === 'ready' ? (
          <>
            <button
              type="button"
              className="coven-copy coven-table-expand"
              aria-label="Expand table"
              aria-haspopup="dialog"
              title="Expand table"
              onClick={(event) => expand(event.currentTarget)}
            >
              Expand
            </button>
            <CopyButton text={source.source} label="Copy table Markdown" />
          </>
        ) : (
          <span className="coven-table-note">{tableNote(source)}</span>
        )}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Overflowing tables need keyboard scrolling. */}
      <section className="coven-markdown-table" aria-label="Table" tabIndex={0}>
        <table>{children}</table>
      </section>
      {current ? <ExpandedTable owner={owner.current} snapshot={current} onDone={release} /> : null}
    </>
  );
}

function ExpandedTable({
  owner,
  snapshot,
  onDone,
}: Readonly<{
  owner: symbol;
  snapshot: Snapshot;
  onDone: () => void;
}>) {
  const { source, origin, fallback } = snapshot;
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // Strict mode runs this twice; the second run opens the dialog again.
    finished.current = false;
    expandedOwner = owner;
    openModal(node);
    first.current?.focus();
    return () => {
      if (finished.current) return;
      // The table's message or conversation went away while it was expanded.
      finished.current = true;
      const active = document.activeElement;
      const lost = !active || active === document.body || node.contains(active);
      closeModal(node);
      if (expandedOwner === owner) expandedOwner = null;
      if (lost) fallback()?.focus();
    };
  }, [owner, fallback]);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    // Close first: nothing behind an open modal can take focus.
    if (dialog.current) closeModal(dialog.current);
    (origin.isConnected ? origin : fallback())?.focus();
    onDone();
  };

  return (
    <dialog
      ref={dialog}
      className="coven-table-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        // React carries a nested dialog's cancel and close up the tree, though
        // the DOM does not: a link review closing above must not close this.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        finish();
      }}
      onClose={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Only the topmost flow closes: a link review above this stays its own.
          event.preventDefault();
          event.stopPropagation();
          finish();
          return;
        }
        if (event.key !== 'Tab') return;
        // The cycle covers this dialog's own controls, not a link review open above it.
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((control) => control.closest('dialog') === event.currentTarget);
        const head = controls[0];
        const tail = controls.at(-1);
        if (!head || !tail) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === head) {
          event.preventDefault();
          tail.focus();
        } else if (!event.shiftKey && document.activeElement === tail) {
          event.preventDefault();
          head.focus();
        }
      }}
    >
      <div className="coven-table-dialog-frame">
        <header className="coven-table-dialog-head">
          <div className="coven-table-dialog-titles">
            <h2 id={titleId}>Expanded table</h2>
            <p id={descriptionId}>
              The table as it read when you expanded it. If the reply has changed since, close this
              and expand it again.
            </p>
          </div>
          <div className="coven-table-dialog-actions">
            <button
              ref={first}
              type="button"
              className="fr-btn fr-btn--secondary fr-btn--sm"
              onClick={finish}
            >
              Close
            </button>
            <CopyButton text={source} label="Copy table Markdown" />
          </div>
        </header>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the snapshot scrolls both ways and needs keyboard scrolling. */}
        <section className="coven-table-dialog-body" aria-label="Table" tabIndex={0}>
          {/* Links in the snapshot review inside this dialog, so the review stacks above it. */}
          <div className="coven-formatted">
            <LinkReviewScope>
              <section className="coven-markdown-table">
                <table>{snapshot.children}</table>
              </section>
            </LinkReviewScope>
          </div>
        </section>
      </div>
    </dialog>
  );
}
