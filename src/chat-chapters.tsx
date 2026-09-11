import type { CaveConversationMessage } from '@opencoven/cave-client/managed';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type ConversationChapterPage,
  chapterTurnElementId,
  hasValidChapterHeaders,
  loadedConversationChapters,
} from './lib/chat-chapters';
import { createManualPageWalk } from './lib/sdk/manual-page-walk';
import type { QueryAdapter, QueryResult } from './lib/sdk/query-adapter';

type Props = Readonly<{
  conversationId: string;
  messages: readonly CaveConversationMessage[];
  hasMoreMessages: boolean;
  queryAdapter: QueryAdapter;
  localOnly?: boolean;
}>;

export function ChatChapters({
  conversationId,
  messages,
  hasMoreMessages,
  queryAdapter,
  localOnly = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<QueryResult<ConversationChapterPage>>({ status: 'loading' });
  const [paging, setPaging] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const toggle = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const walk = useMemo(() => createManualPageWalk(), []);
  const loaded = useMemo(
    () => loadedConversationChapters(conversationId, messages),
    [conversationId, messages],
  );

  useEffect(() => {
    const request = ++generation.current;
    walk.reset();
    setNotice('');
    setPaging(false);
    setResult({ status: 'loading' });
    if (!expanded) return;
    const read = queryAdapter.listChapters?.bind(queryAdapter);
    if (!read || localOnly) {
      setResult({ status: 'error', code: 'unsupported_operation' });
      return;
    }
    void read(conversationId).then((next) => {
      if (request !== generation.current) return;
      setResult(
        next.status === 'ok' &&
          (!hasValidChapterHeaders(next.data, conversationId) || !walk.acceptRootPage(next.data))
          ? { status: 'error', code: 'invalid_response' }
          : next,
      );
    });
    return () => {
      generation.current += 1;
    };
  }, [conversationId, expanded, queryAdapter, walk, localOnly]);

  function loadMore() {
    if (result.status !== 'ok' || paging) return;
    const previous = result.data;
    const cursor = previous.cursor?.next;
    const read = queryAdapter.listChapters?.bind(queryAdapter);
    if (!cursor || !read) return;
    if (!walk.canFetchNextPage()) {
      setNotice('Chapter page limit reached. Reopen Ongoing to refresh.');
      return;
    }
    const request = generation.current;
    setPaging(true);
    void read(conversationId, { cursor }).then((next) => {
      if (request !== generation.current) return;
      setPaging(false);
      if (next.status !== 'ok') {
        setResult(next);
        return;
      }
      if (
        next.data.sourceRevision !== previous.sourceRevision ||
        !hasValidChapterHeaders(next.data, conversationId, previous.data) ||
        !walk.acceptNextPage(cursor, next.data)
      ) {
        setResult({ status: 'reconcile_required' });
        return;
      }
      setResult({
        status: 'ok',
        data: { ...next.data, data: [...previous.data, ...next.data.data] },
      });
    });
  }

  const unsupported = result.status === 'error' && result.code === 'unsupported_operation';
  const chapters = result.status === 'ok' ? result.data.data : unsupported ? loaded : null;
  const unavailable = result.status === 'ok' && result.data.status === 'unavailable';
  const stale = result.status === 'reconcile_required' || result.status === 'stale';
  function close() {
    if (stale) queryAdapter.invalidate();
    setExpanded(false);
  }
  return (
    <section
      className="chat-chapters"
      aria-label="Conversation chapters"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          close();
          toggle.current?.focus();
        }
      }}
    >
      <button
        className="chat-chapters__toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        ref={toggle}
        onClick={() => {
          if (expanded) close();
          else setExpanded(true);
        }}
      >
        <span>Ongoing</span>
        <span>{expanded ? 'Hide chapters' : 'Browse chapters'}</span>
      </button>
      {expanded ? (
        <div className="chat-chapters__body" id={bodyId}>
          <p className="chat-chapters__context">
            This conversation only · UTC chapters ·{' '}
            {localOnly ? 'Local notes, no model context' : 'Context unverified'}
          </p>
          {unsupported ? (
            <p className="chat-chapters__notice">
              {localOnly
                ? 'Local note chapters. Showing only loaded messages'
                : 'Full chapter index unsupported by this SDK or Cave. Showing only loaded messages'}
              {hasMoreMessages ? ' (partial)' : ''}.
            </p>
          ) : null}
          {result.status === 'loading' ? <output>Loading chapter headers…</output> : null}
          {result.status === 'ok' && result.data.status === 'partial' ? (
            <output>Partial chapter index. Only these anchors are verified.</output>
          ) : null}
          {stale ? (
            <p role="alert">The chapter index changed. Close and reopen Ongoing to refresh.</p>
          ) : null}
          {unavailable || (unsupported && !loaded) ? (
            <output>Chapter index unavailable. Your transcript is unchanged.</output>
          ) : null}
          {result.status === 'not_ready' || (result.status === 'error' && !unsupported) ? (
            <p role="alert">Chapter index unavailable. Your transcript is unchanged.</p>
          ) : null}
          {chapters && !unavailable ? (
            <nav className="chat-chapters__list" aria-label="UTC chapters">
              {chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  className="chat-chapters__chapter"
                  type="button"
                  aria-label={`${chapter.day} ${chapter.turnCount} ${unsupported ? 'loaded ' : ''}turn${chapter.turnCount === 1 ? '' : 's'}`}
                  onClick={() => {
                    const anchor = document.getElementById(
                      chapterTurnElementId(conversationId, chapter.firstTurnId),
                    );
                    if (!anchor) {
                      setNotice(
                        hasMoreMessages
                          ? 'This chapter is not loaded. Use Load more messages to reach it.'
                          : 'This chapter anchor is no longer available. Refresh the conversation.',
                      );
                      return;
                    }
                    setNotice('');
                    anchor.focus({ preventScroll: true });
                    anchor.scrollIntoView?.({ block: 'nearest' });
                    if (globalThis.matchMedia?.('(max-width: 640px)').matches) setExpanded(false);
                  }}
                >
                  <time>{chapter.day}</time>
                  <span>
                    {chapter.turnCount} {unsupported ? 'loaded ' : ''}turn
                    {chapter.turnCount === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </nav>
          ) : null}
          {result.status === 'ok' && result.data.cursor?.hasMore ? (
            <button
              className="chat-shell__load-more"
              type="button"
              onClick={loadMore}
              disabled={paging}
            >
              {paging ? 'Loading…' : 'Load more chapters'}
            </button>
          ) : null}
          {notice ? <output>{notice}</output> : null}
        </div>
      ) : null}
    </section>
  );
}
