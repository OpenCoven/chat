/**
 * Outline and reading statistics for the demo's document reader.
 *
 * Ported from Cave's `src/lib/reader-outline.ts` so the demo's reader behaves
 * like the research reader rather than merely resembling it. The three
 * decisions worth carrying over verbatim:
 *
 * - Fenced blocks are stripped before scanning for headings, so a `#` that is
 *   a shell comment does not become a rail entry.
 * - Reading time counts prose only, at a deliberately conservative 200 words
 *   per minute, floored at one minute — "0 min read" tells a reader nothing.
 * - The rail indents relative to the shallowest heading present, so a document
 *   written entirely in `##` is not uniformly indented.
 *
 * When the real reader arrives this file goes away and Cave's own module is
 * used through the SDK.
 */

export type ReaderHeading = {
  /** Stable DOM id linking a rail button to its heading. */
  id: string;
  text: string;
  /** 1-6 as written. */
  level: number;
};

/** Words per minute for the read estimate. Conservative for technical prose. */
export const READER_WPM = 200;

export type ReadingStats = {
  words: number;
  /** Whole minutes, floored at 1. */
  minutes: number;
};

/** Drop fenced blocks so their contents cannot be mistaken for structure. */
function withoutFencedBlocks(text: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence) {
      out.push(line);
    }
  }

  return out.join('\n');
}

/** Collapse inline markdown to its visible text. */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

/** A DOM-safe id, de-duplicated against ids already taken. */
function slugify(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';

  let candidate = base;
  let suffix = 2;

  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  taken.add(candidate);

  return candidate;
}

/** Headings in document order. */
export function readerOutline(text: string): ReaderHeading[] {
  const taken = new Set<string>();
  const headings: ReaderHeading[] = [];

  for (const line of withoutFencedBlocks(text).split('\n')) {
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);

    if (!match) {
      continue;
    }

    const label = stripInline(match[2] ?? '');

    if (!label) {
      continue;
    }

    headings.push({ id: slugify(label, taken), text: label, level: (match[1] ?? '#').length });
  }

  return headings;
}

/** Words and read time. Fenced code is excluded so scripts do not read as prose. */
export function readingStats(text: string): ReadingStats {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const words = prose.split(/\s+/).filter(Boolean).length;

  return { words, minutes: Math.max(1, Math.round(words / READER_WPM)) };
}

/** The shallowest heading level present, used as the indent origin. */
export function outlineBaseLevel(headings: readonly ReaderHeading[]): number {
  return headings.reduce((shallowest, heading) => Math.min(shallowest, heading.level), 6);
}

/**
 * One rendered block of a document body.
 *
 * Every block carries a `key` derived from its position and kind, so the
 * renderer never has to fall back to an array index. Index keys are wrong here
 * for the ordinary reason: a document re-parsed after an edit would reuse the
 * wrong node.
 */
export type ReaderBlock = { key: string } & (
  | { kind: 'heading'; id: string; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; language: string | undefined; source: string }
);

/**
 * Split a markdown body into blocks the reader can render.
 *
 * Deliberately small: headings, paragraphs, bullet lists, and fenced code.
 * Anything else renders as a paragraph rather than as raw markup.
 */
export function readerBlocks(text: string): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  const taken = new Set<string>();
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = /^\s{0,3}(`{3,})(.*)$/.exec(line);

    if (fence) {
      const body: string[] = [];
      index += 1;

      while (index < lines.length && !/^\s{0,3}`{3,}\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }

      index += 1;
      blocks.push({
        key: `code-${blocks.length}`,
        kind: 'code',
        language: (fence[2] ?? '').trim() || undefined,
        source: body.join('\n'),
      });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);

    if (heading) {
      const label = stripInline(heading[2] ?? '');
      blocks.push({
        key: `heading-${blocks.length}`,
        kind: 'heading',
        id: slugify(label, taken),
        level: (heading[1] ?? '#').length,
        text: label,
      });
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length) {
        const current = lines[index] ?? '';

        if (/^\s*[-*]\s+/.test(current)) {
          items.push(current.replace(/^\s*[-*]\s+/, '').trim());
          index += 1;
          continue;
        }

        // A wrapped item continues on an indented line. Without this the
        // continuation escapes the list and swallows the item after it.
        if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
          index += 1;
          continue;
        }

        break;
      }

      blocks.push({ key: `list-${blocks.length}`, kind: 'list', items });
      continue;
    }

    if (line.trim()) {
      const paragraph: string[] = [];

      while (
        index < lines.length &&
        (lines[index] ?? '').trim() &&
        !/^\s{0,3}#/.test(lines[index] ?? '')
      ) {
        paragraph.push((lines[index] ?? '').trim());
        index += 1;
      }

      blocks.push({ key: `para-${blocks.length}`, kind: 'paragraph', text: paragraph.join(' ') });
      continue;
    }

    index += 1;
  }

  return blocks;
}
