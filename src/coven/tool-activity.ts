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

/** What a tool call did, for the one-line summary of a group of calls. */
export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'other';

const KIND_NAMES: Readonly<Record<Exclude<ToolKind, 'other'>, readonly string[]>> = {
  command: [
    'bash',
    'shell',
    'exec',
    'execcommand',
    'localshell',
    'shellcommand',
    'powershell',
    'terminal',
    'run',
  ],
  read: ['read', 'readfile', 'view', 'cat', 'notebookread', 'open'],
  edit: [
    'edit',
    'multiedit',
    'write',
    'writefile',
    'applypatch',
    'patch',
    'strreplace',
    'create',
    'notebookedit',
  ],
  search: [
    'grep',
    'glob',
    'search',
    'find',
    'ls',
    'list',
    'listdir',
    'listfiles',
    'rg',
    'codebasesearch',
  ],
  web: ['webfetch', 'websearch', 'fetch', 'browse', 'browser'],
};

/** Names compare without case, separators or a namespace (`functions.exec_command`). */
export function toolKind(name: string): ToolKind {
  const key = (name.split('.').pop() ?? name).toLowerCase().replace(/[^a-z]/g, '');
  for (const [kind, names] of Object.entries(KIND_NAMES)) {
    if (names.includes(key)) return kind as ToolKind;
  }
  return 'other';
}

const KIND_PHRASE: Readonly<Record<ToolKind, (count: number) => string>> = {
  command: (n) => `ran ${n} ${n === 1 ? 'command' : 'commands'}`,
  read: (n) => `read ${n} ${n === 1 ? 'file' : 'files'}`,
  edit: (n) => `edited ${n} ${n === 1 ? 'file' : 'files'}`,
  search: (n) => `searched ${n} ${n === 1 ? 'time' : 'times'}`,
  web: (n) => `fetched ${n} ${n === 1 ? 'page' : 'pages'}`,
  other: (n) => `used ${n} other ${n === 1 ? 'tool' : 'tools'}`,
};

const KIND_ORDER: readonly ToolKind[] = ['command', 'read', 'edit', 'search', 'web', 'other'];

/**
 * A group of calls in one line, most frequent kind first:
 * "Ran 4 commands, read 2 files and edited 1 file". When every call is an
 * unrecognised tool, the names themselves say more than "used 3 other tools".
 */
export function toolGroupSummary(names: readonly string[]): string {
  const counts = new Map<ToolKind, number>();
  for (const name of names) counts.set(toolKind(name), (counts.get(toolKind(name)) ?? 0) + 1);
  if (counts.size === 1 && counts.has('other')) {
    const unique = [...new Set(names)];
    const listed = unique.slice(0, 3).join(', ');
    const more = unique.length > 3 ? ` and ${unique.length - 3} more` : '';
    return `Called ${listed}${more}`;
  }
  const phrases = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
    .map(([kind, count]) => KIND_PHRASE[kind](count));
  const last = phrases.pop() ?? '';
  const text = phrases.length ? `${phrases.join(', ')} and ${last}` : last;
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
