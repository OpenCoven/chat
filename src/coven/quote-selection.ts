/**
 * Quoting a passage of the conversation into the draft. A quote is ordinary
 * draft text: Markdown `> ` lines the reader can edit or delete before
 * sending, with no standing beyond the words themselves.
 */

/** The most a quote adds to a draft, its `> ` marks and the blank lines around it included. */
export const QUOTE_LIMIT_BYTES = 4096;

/**
 * Marks a message's own text in the transcript, valued with the message id. A
 * passage can be quoted only from inside one such element.
 */
export const QUOTE_SOURCE = 'data-quote-source';

/**
 * Message chrome that may sit inside a message's text, and is never part of a
 * quote: controls, folded or hidden content, a dialog opened from the message,
 * code bars and tool activity.
 */
const CHROME =
  'button, summary, details, dialog, [hidden], [aria-hidden="true"], .coven-code-bar, .coven-tool-group, .coven-tools';

const utf8 = new TextEncoder();

/** The passage as Markdown quote lines, or '' when there is nothing to quote. */
export function quoteLines(passage: string): string {
  const text = passage
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

export type QuoteResult =
  | Readonly<{ kind: 'ready'; draft: string }>
  | Readonly<{ kind: 'empty' }>
  /** The quote itself is over `QUOTE_LIMIT_BYTES`; `bytes` is what it would add. */
  | Readonly<{ kind: 'too-long'; bytes: number }>
  /** The draft would pass the prompt limit; `bytes` is the size it would reach. */
  | Readonly<{ kind: 'draft-too-long'; bytes: number }>;

/**
 * The draft with the passage quoted after it. The draft is kept exactly as
 * written; a blank line separates it from the quote, and another follows the
 * quote so the reader's next words start a paragraph of their own. Nothing is
 * ever shortened to fit: an over-limit quote or draft is refused whole.
 */
export function appendQuote(draft: string, passage: string, promptLimit: number): QuoteResult {
  const lines = quoteLines(passage);
  if (!lines) return { kind: 'empty' };
  const separator = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
  const insertion = `${separator}${lines}\n\n`;
  const bytes = utf8.encode(insertion).length;
  if (bytes > QUOTE_LIMIT_BYTES) return { kind: 'too-long', bytes };
  const total = utf8.encode(draft).length + bytes;
  if (total > promptLimit) return { kind: 'draft-too-long', bytes: total };
  return { kind: 'ready', draft: draft + insertion };
}

export type SelectedPassage = Readonly<{ source: HTMLElement; id: string; text: string }>;

/** Text nodes the range touches, in document order, starting where it starts. */
function* touchedText(range: Range): Generator<Text> {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  walker.currentNode = range.startContainer;
  let node: Node | null =
    range.startContainer instanceof Text ? range.startContainer : walker.nextNode();
  for (; node; node = walker.nextNode()) {
    if (range.comparePoint(node, 0) > 0) return;
    if (node instanceof Text && range.intersectsNode(node)) yield node;
  }
}

/**
 * The passage the reader has selected, when every character of it lies in one
 * message's text and none in its chrome (Copy controls, code bars, tool
 * activity, anything hidden). A selection that crosses into another message,
 * a name, a notice or an attachment card is no passage at all. Blank text at
 * the edges does not count, so a triple-click that ends where the next message
 * starts still selects one paragraph.
 */
export function selectedPassage(selection: Selection | null): SelectedPassage | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  let source: HTMLElement | null = null;
  for (const node of touchedText(range)) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (!node.data.slice(start, end).trim()) continue;
    const parent = node.parentElement;
    const region = parent?.closest<HTMLElement>(`[${QUOTE_SOURCE}]`) ?? null;
    if (!region || (source && region !== source)) return null;
    const chrome = parent?.closest(CHROME);
    if (chrome && region.contains(chrome)) return null;
    source = region;
  }
  const id = source?.getAttribute(QUOTE_SOURCE);
  const text = selection.toString();
  return source && id && text.trim() ? { source, id, text } : null;
}
