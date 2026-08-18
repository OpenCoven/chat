import { useEffect, useMemo, useRef, useState } from 'react';

import { outlineBaseLevel, readerBlocks, readerOutline, readingStats } from './reader-outline';

/**
 * Document reader for `/spec` and `/handoff` artifacts.
 *
 * Follows the structure of Cave's research reader: a contents rail on the left
 * with reading statistics in its footer, a scrolling document column, and a
 * text-size control. The rail tracks the section currently in view, indents
 * relative to the shallowest heading present, and is keyboard reachable.
 */

/** Text size steps, matching the reader's A / A control. */
const TEXT_SIZES = ['small', 'regular', 'large'] as const;
type TextSize = (typeof TEXT_SIZES)[number];

export type ReaderDocument = {
  kind: 'spec' | 'handoff';
  title: string;
  markdown: string;
};

export function DocumentReader({
  document: doc,
  onClose,
}: {
  document: ReaderDocument;
  onClose: () => void;
}) {
  const [textSize, setTextSize] = useState<TextSize>('regular');
  const [activeId, setActiveId] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // The reader renders the title itself, so a leading level-1 heading that
  // repeats it is dropped from both the body and the rail. Without this the
  // title appears twice and the rail's first entry points at nothing useful.
  const body = useMemo(() => {
    const lines = doc.markdown.split('\n');
    const first = lines.findIndex((line) => line.trim());
    const heading = /^#\s+(.*)$/.exec(lines[first]?.trim() ?? '');

    if (heading && heading[1]?.trim() === doc.title.trim()) {
      return lines.slice(first + 1).join('\n');
    }

    return doc.markdown;
  }, [doc.markdown, doc.title]);

  const outline = useMemo(() => readerOutline(body), [body]);
  const stats = useMemo(() => readingStats(body), [body]);
  const blocks = useMemo(() => readerBlocks(body), [body]);
  const baseLevel = useMemo(() => outlineBaseLevel(outline), [outline]);

  // Escape closes, as it does in the reader Cave ships.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Track the heading currently at the top of the viewport, so the rail says
  // where the reader is rather than only where they can go.
  useEffect(() => {
    const container = scrollRef.current;

    if (!container) {
      return;
    }

    function onScroll() {
      if (!container) {
        return;
      }

      const headings = Array.from(container.querySelectorAll<HTMLElement>('[data-heading-id]'));
      const top = container.getBoundingClientRect().top;
      let current = '';

      for (const heading of headings) {
        if (heading.getBoundingClientRect().top - top <= 12) {
          current = heading.dataset.headingId ?? '';
        }
      }

      setActiveId(current || (headings[0]?.dataset.headingId ?? ''));
    }

    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });

    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  function jumpTo(id: string) {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-heading-id="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const sizeIndex = TEXT_SIZES.indexOf(textSize);

  return (
    <div className="reader-backdrop" role="dialog" aria-modal="true" aria-label={doc.title}>
      <div className="reader">
        <nav className="reader-rail" aria-label="Contents">
          <p className="reader-rail-label">Contents</p>
          <div className="reader-rail-links">
            {outline.map((heading) => (
              <button
                key={heading.id}
                type="button"
                className={`reader-rail-link ${activeId === heading.id ? 'is-active' : ''}`}
                style={{ paddingLeft: `${(heading.level - baseLevel) * 14 + 12}px` }}
                onClick={() => jumpTo(heading.id)}
              >
                {heading.text}
              </button>
            ))}
          </div>
          <p className="reader-rail-meta">
            {stats.words.toLocaleString()} words · {stats.minutes} min read
          </p>
        </nav>

        <div className="reader-main">
          <div className="reader-toolbar">
            <div className="reader-textsize">
              <button
                type="button"
                className="reader-textsize-btn"
                aria-label="Smaller text"
                disabled={sizeIndex === 0}
                onClick={() => setTextSize(TEXT_SIZES[Math.max(0, sizeIndex - 1)] ?? 'regular')}
              >
                <span className="reader-glyph-small">A</span>
              </button>
              <button
                type="button"
                className="reader-textsize-btn"
                aria-label="Larger text"
                disabled={sizeIndex === TEXT_SIZES.length - 1}
                onClick={() =>
                  setTextSize(
                    TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, sizeIndex + 1)] ?? 'regular',
                  )
                }
              >
                <span className="reader-glyph-large">A</span>
              </button>
            </div>

            <button type="button" className="reader-close" onClick={onClose}>
              Close
            </button>
          </div>

          <div className={`reader-scroll reader-size-${textSize}`} ref={scrollRef}>
            <article className="reader-column">
              <p className="reader-kicker">{doc.kind}</p>
              <h1 className="reader-title">{doc.title}</h1>

              {blocks.map((block) => {
                if (block.kind === 'heading') {
                  const Tag = (block.level <= 2 ? 'h2' : 'h3') as 'h2' | 'h3';

                  return (
                    <Tag
                      key={block.key}
                      id={block.id}
                      data-heading-id={block.id}
                      className="reader-heading"
                    >
                      {block.text}
                    </Tag>
                  );
                }

                if (block.kind === 'list') {
                  return (
                    <ul key={block.key} className="reader-list">
                      {block.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  );
                }

                if (block.kind === 'code') {
                  return (
                    <pre key={block.key} className="reader-code">
                      <code>{block.source}</code>
                    </pre>
                  );
                }

                return (
                  <p key={block.key} className="reader-paragraph">
                    {block.text}
                  </p>
                );
              })}
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
