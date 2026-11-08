import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../design/minimal-icons';
import type { ChatMessage } from './events';
import {
  appendQuote,
  QUOTE_LIMIT_BYTES,
  QUOTE_SOURCE,
  type QuoteResult,
  selectedPassage,
} from './quote-selection';

/** The chat a draft belongs to, as the layout last showed it. */
export type DraftChat = Readonly<{ familiarId: string; sessionId: string }>;

/**
 * Rewrites the draft of `chat` from the draft as it stands now, not as last
 * rendered. Returns false, changing nothing, when `chat` is no longer the one
 * shown or `edit` declines by returning null.
 */
export type EditDraft = (chat: DraftChat, edit: (draft: string) => string | null) => boolean;

/** What a selection pinned down: the passage, and where it came from. */
type Captured = Readonly<{
  familiarId: string;
  sessionId: string;
  id: string;
  role: string;
  /** The message text the passage was selected from, to tell if it changed. */
  source: string;
  region: HTMLElement;
  passage: string;
}>;

type QuoteState =
  | Readonly<{ kind: 'ready'; chat: string; captured: Captured }>
  | Readonly<{ kind: 'note'; chat: string; text: string }>;

const SELECT_AGAIN =
  "That passage changed or isn't in this chat any more. Select it again to quote it.";

function refusal(result: QuoteResult, promptLimit: number): string {
  if (result.kind === 'too-long')
    return `That passage is ${result.bytes.toLocaleString('en-US')} bytes as a quote, and a quote can be up to ${QUOTE_LIMIT_BYTES.toLocaleString('en-US')}. Select less of it.`;
  if (result.kind === 'draft-too-long')
    return `Quoting it would make your message ${result.bytes.toLocaleString('en-US')} bytes, and Coven accepts up to ${promptLimit.toLocaleString('en-US')}. Shorten the message, then select the passage again.`;
  return SELECT_AGAIN;
}

/**
 * Quote selection: select a passage inside one message and the action appears
 * above the composer, ready to append the passage to the draft as a Markdown
 * quote. It never sends. What a selection captured is checked again when the
 * action runs, and a passage that changed, left the chat, or belongs to a chat
 * no longer shown quotes nothing. The capture lives in this component only and
 * is dropped once used, dismissed, deselected, or the chat changes.
 *
 * WebKit clears the selection whenever focus moves, so Tab from a passage to a
 * link inside it would deselect it. A selection that goes because a key moved
 * focus within the conversation or the composer area keeps what it captured,
 * and Tab can carry on to the action. A pointer press elsewhere, Escape in the
 * conversation, a new selection, or focus leaving those areas still drops it.
 */
export function useQuoteSelection({
  transcriptRef,
  composerRef,
  composerAreaRef,
  messages,
  familiarId,
  sessionId,
  familiarName,
  disabled,
  promptLimit,
  onEditDraft,
}: Readonly<{
  transcriptRef: RefObject<HTMLElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Where the action and the composer sit; focus may pass through it. */
  composerAreaRef?: RefObject<HTMLElement | null> | undefined;
  messages: readonly ChatMessage[];
  familiarId: string;
  sessionId: string;
  familiarName: string;
  /** The composer can't take text right now; the action waits with it. */
  disabled: boolean;
  promptLimit: number;
  onEditDraft?: EditDraft | undefined;
}>): {
  /** A passage is waiting to be quoted, so the transcript holds still under it. */
  holding: boolean;
  action: ReactNode;
  /** Runs first on the composer's keys. */
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
} {
  const [state, setState] = useState<QuoteState | null>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const chat = JSON.stringify([familiarId, sessionId]);
  const shown = useLatest({ messages, familiarId, sessionId, chat, promptLimit });

  // What last moved focus or the selection: a key press, or a pointer press
  // outside the action. Only the first may carry a passage past a link.
  const lastInput = useRef<'key' | 'pointer'>('pointer');
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !actionRef.current?.contains(event.target))
        lastInput.current = 'pointer';
    };
    const onKeyDown = (event: KeyboardEvent) => {
      lastInput.current = 'key';
      // The action takes its own Escape, and a dialog such as a link review
      // closes on its own; in the conversation itself, Escape lets go.
      if (
        event.key === 'Escape' &&
        !document.querySelector('dialog[open]') &&
        transcriptRef.current?.contains(document.activeElement)
      )
        setState(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [transcriptRef]);

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const passage = selectedPassage(selection);
      if (!passage || !transcriptRef.current?.contains(passage.source)) {
        const focus = document.activeElement;
        // Focus moving into the action can collapse the selection; what it captured stands.
        const intoAction = actionRef.current?.contains(focus);
        // So can a key that moved focus to a link in the passage, or on toward the action.
        const cleared = !selection || selection.rangeCount === 0 || selection.isCollapsed;
        const passing =
          cleared &&
          lastInput.current === 'key' &&
          Boolean(
            transcriptRef.current?.contains(focus) || composerAreaRef?.current?.contains(focus),
          );
        if (!intoAction && !passing) setState(null);
        return;
      }
      const now = shown.current;
      const message = now.messages.find((item) => item.id === passage.id);
      const fits = appendQuote('', passage.text, Number.POSITIVE_INFINITY);
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) setState(null);
      else if (fits.kind === 'empty') setState(null);
      else if (fits.kind !== 'ready')
        setState({ kind: 'note', chat: now.chat, text: refusal(fits, now.promptLimit) });
      else
        setState({
          kind: 'ready',
          chat: now.chat,
          captured: {
            familiarId: now.familiarId,
            sessionId: now.sessionId,
            id: message.id,
            role: message.role,
            source: message.text,
            region: passage.source,
            passage: passage.text,
          },
        });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [transcriptRef, composerAreaRef, shown]);

  // A passage belongs to the chat it was selected in; another chat, or this one
  // again later, starts without it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chat is the trigger.
  useEffect(() => {
    setState(null);
  }, [chat]);

  // After a quote the reader carries on typing at the end of the draft, which
  // has its new value only once this render commits.
  const caret = useRef(false);
  const focusDismiss = useRef(false);
  useLayoutEffect(() => {
    const field = composerRef.current;
    if (caret.current && field) {
      caret.current = false;
      const end = field.value.length;
      field.focus();
      field.setSelectionRange(end, end);
      field.scrollTop = field.scrollHeight;
    }
    if (focusDismiss.current) {
      focusDismiss.current = false;
      dismissRef.current?.focus();
    }
  });

  // An Enter that pressed Quote selection and is still held repeats into the
  // field the quote focused; that repeat is never a send.
  const enterHeld = useRef(false);
  useEffect(() => {
    const release = (event: KeyboardEvent) => {
      if (event.key === 'Enter') enterHeld.current = false;
    };
    window.addEventListener('keyup', release, true);
    return () => window.removeEventListener('keyup', release, true);
  }, []);
  const onComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (enterHeld.current && event.key === 'Enter' && event.repeat) event.preventDefault();
  }, []);

  const visible = state && state.chat === chat && !disabled ? state : null;

  function quote() {
    if (visible?.kind !== 'ready') return;
    const { captured } = visible;
    const message = messages.find((item) => item.id === captured.id);
    const intact =
      captured.familiarId === familiarId &&
      captured.sessionId === sessionId &&
      message?.role === captured.role &&
      message.text === captured.source &&
      captured.region.isConnected &&
      captured.region.getAttribute(QUOTE_SOURCE) === captured.id;
    let declined = null as QuoteResult | null;
    const quoted =
      intact &&
      (onEditDraft?.({ familiarId, sessionId }, (draft) => {
        const result = appendQuote(draft, captured.passage, promptLimit);
        if (result.kind === 'ready') return result.draft;
        declined = result;
        return null;
      }) ??
        false);
    if (quoted) {
      setState(null);
      caret.current = true;
      composerRef.current?.focus();
      return;
    }
    focusDismiss.current = Boolean(actionRef.current?.contains(document.activeElement));
    setState({
      kind: 'note',
      chat,
      text: declined ? refusal(declined, promptLimit) : SELECT_AGAIN,
    });
  }

  function dismiss() {
    const inside = actionRef.current?.contains(document.activeElement);
    setState(null);
    if (inside) transcriptRef.current?.focus();
  }

  function onActionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }

  const action = visible ? (
    <div ref={actionRef} className="coven-quote">
      {visible.kind === 'ready' ? (
        <>
          <button
            type="button"
            className="coven-quote-button"
            // Pressing the action leaves the selection and focus where they are.
            onMouseDown={(event) => event.preventDefault()}
            onClick={quote}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                enterHeld.current = true;
                quote();
                return;
              }
              onActionKeyDown(event);
            }}
          >
            Quote selection
          </button>
          <span className="coven-quote-source">
            {visible.captured.role === 'user'
              ? 'from your message'
              : `from ${familiarName}'s reply`}
          </span>
        </>
      ) : (
        <output className="coven-quote-note">{visible.text}</output>
      )}
      <button
        ref={dismissRef}
        type="button"
        className="coven-quote-dismiss"
        aria-label="Dismiss quote"
        title="Dismiss"
        onMouseDown={(event) => event.preventDefault()}
        onClick={dismiss}
        onKeyDown={onActionKeyDown}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  ) : null;

  return { holding: Boolean(visible), action, onComposerKeyDown };
}

/** A stable handle on this render's values, for listeners registered once. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
