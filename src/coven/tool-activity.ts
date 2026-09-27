/**
 * Tool invocations can appear in the assistant's text stream as
 * `⚒ Name(arguments)` summaries (also legacy ✶/✳ markers). Left alone,
 * Markdown runs them together with the surrounding prose. This lifts them
 * out into their own segments so the transcript can render activity rows.
 */
export type MessageSegment =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'tool'; name: string; args: string }>;

const MARKER = /[⚒✶✳][\uFE0E\uFE0F]?\s*([A-Za-z][\w.-]*)\(/gu;
const FENCE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;

/**
 * Finds the `)` matching `openIndex`, or -1 when the summary was truncated.
 * Parentheses inside `"…"` or `'…'` are argument text (shell quoting), and a
 * backslash escapes the next character inside double quotes. A quote that
 * never closes on its line is a plain apostrophe, so the scan retries without
 * quoting rather than swallowing the rest of the line.
 */
function closingParen(text: string, openIndex: number): number {
  const quoted = scanClosingParen(text, openIndex, true);
  if (quoted !== 'unterminated-quote') return quoted;
  const plain = scanClosingParen(text, openIndex, false);
  return plain === 'unterminated-quote' ? -1 : plain;
}

function scanClosingParen(
  text: string,
  openIndex: number,
  quoting: boolean,
): number | 'unterminated-quote' {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' && (quote || text[index + 1] === '\n')) {
      // A summary never spans a paragraph break, so any later `)` is prose.
      return quote ? 'unterminated-quote' : -1;
    }
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (quoting && (char === '"' || char === "'")) quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return quote ? 'unterminated-quote' : -1;
}

function segmentProse(text: string, into: MessageSegment[]): void {
  let cursor = 0;
  const codeSpans = Array.from(text.matchAll(INLINE_CODE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  let codeIndex = 0;
  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(text); match; match = MARKER.exec(text)) {
    let code = codeSpans[codeIndex];
    while (code && code.end <= match.index) code = codeSpans[++codeIndex];
    if (code && match.index >= code.start && match.index < code.end) continue;
    const open = match.index + match[0].length - 1;
    const close = closingParen(text, open);
    let argsEnd: number;
    let resume: number;
    if (close === -1) {
      // A truncated summary never closes; end it at the next marker or line
      // and leave that terminator in place for the next pass.
      const stop = text.slice(open + 1).search(/[⚒✶✳]|\n/u);
      argsEnd = stop === -1 ? text.length : open + 1 + stop;
      resume = argsEnd;
    } else {
      argsEnd = close;
      resume = close + 1;
    }
    if (match.index > cursor) into.push({ kind: 'text', text: text.slice(cursor, match.index) });
    into.push({
      kind: 'tool',
      name: match[1] ?? '',
      args: text.slice(open + 1, argsEnd),
    });
    cursor = resume;
    MARKER.lastIndex = cursor;
  }
  if (cursor < text.length) into.push({ kind: 'text', text: text.slice(cursor) });
}

export function segmentToolCalls(text: string): readonly MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  FENCE.lastIndex = 0;
  for (let fence = FENCE.exec(text); fence; fence = FENCE.exec(text)) {
    segmentProse(text.slice(cursor, fence.index), segments);
    segments.push({ kind: 'text', text: fence[0] });
    cursor = fence.index + fence[0].length;
  }
  segmentProse(text.slice(cursor), segments);

  // Adjacent prose pieces (around a fence) belong to one Markdown document.
  const merged: MessageSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
  }
  return merged.filter((segment) => segment.kind === 'tool' || segment.text.trim() !== '');
}
