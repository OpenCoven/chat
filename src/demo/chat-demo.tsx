import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatInspector } from './chat-inspector';
import { DocumentReader, type ReaderDocument } from './document-reader';
import {
  MOCK_COMMANDS,
  MOCK_CONVERSATIONS,
  type MockConversation,
  type MockMessage,
  mockReply,
  nowLabel,
} from './mock-data';
import { MOCK_FAMILIARS } from './mock-familiars';
import type { MockArtifact, MockLinkPreview } from './mock-rich-content';

/**
 * Proof-of-concept chat surface.
 *
 * This is a demo of what Phases 1 through 3 will present, driven entirely by
 * local mock data. It connects to nothing. The Phase 0 scaffold remains the
 * app's real entry point; this renders only at `?demo=chat`.
 */

/**
 * The first user-perceived character of a label.
 *
 * Not charAt(0), which indexes UTF-16 code units: a title beginning with an
 * emoji returns half a surrogate pair and renders as a replacement character.
 * Not a spread either, which fixes that but still splits a ZWJ sequence -- a
 * family emoji would show only its first person.
 *
 * Intl.Segmenter is the one that answers the question actually being asked,
 * with a spread as a fallback for anywhere it is unavailable.
 */
export function firstGrapheme(label: string): string {
  const trimmed = label.trim();

  if (trimmed === '') {
    return '';
  }

  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    return [...segmenter.segment(trimmed)][0]?.segment ?? '';
  }

  return [...trimmed][0] ?? '';
}

/**
 * A conversation's mark: its initial on a tint of a hue seeded from its id.
 *
 * This was a saturated disc and, before that, a three-stop gradient. The
 * gradient went because the brand does not allow them; the saturated disc went
 * because it was the loudest thing on a neutral surface while saying nothing --
 * an avatar that carries no letter, no image and no status is decoration
 * occupying the position of an identity.
 *
 * The hue is seeded off the id rather than the title, so renaming a
 * conversation does not change its colour.
 *
 * Still aria-hidden: the title sits directly beside it, and announcing "Q,
 * Quick Chat" reads the same thing twice.
 */
function Avatar({ label, seed, size }: { label: string; seed: string; size: number }) {
  const hue = useMemo(() => {
    let total = 0;
    for (const character of seed) {
      total += character.charCodeAt(0);
    }
    return total % 360;
  }, [seed]);

  const initial = firstGrapheme(label).toUpperCase();

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        // Flat, per the brand: a tint and a border of one hue, no gradient.
        borderColor: `hsl(${hue} 38% 52% / 0.5)`,
        background: `hsl(${hue} 34% 46% / 0.28)`,
        color: `hsl(${hue} 46% 82%)`,
      }}
    >
      {initial}
    </span>
  );
}

/**
 * Message text with a leading slash command emphasised.
 *
 * The command is styled, never executed. Rendering it as data is the same
 * discipline the rich-content design applies to markers.
 */
function MessageText({ text }: { text: string }) {
  const match = /^(\/[a-z-]+)(\s.*)?$/is.exec(text.trim());

  if (!match) {
    return <>{text}</>;
  }

  return (
    <>
      <span className="command">{match[1]}</span>
      {match[2] ?? ''}
    </>
  );
}

/**
 * Stand-in for a generated image.
 *
 * Inline JSX SVG rather than a file or a data URI: it needs no `xmlns`, so no
 * URL literal reaches runtime source, and the repository gains no binary asset
 * that would have to be licensed and reviewed. It reads as "an image was
 * generated here" without pretending to be a real model output.
 */
function GeneratedImage({ alt, prompt }: { alt: string; prompt: string }) {
  // Hue derived from the prompt, so `/image cat purple` and `/image dog blue`
  // are visibly different generations rather than the same tile twice.
  let seed = 0;
  for (const character of prompt) {
    seed += character.charCodeAt(0);
  }
  const hue = seed % 360;
  const gradientId = `demo-bg-${hue}`;
  const glowId = `demo-glow-${hue}`;

  return (
    <svg className="generated" viewBox="0 0 600 400" role="img" aria-label={alt}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 45% 17%)`} />
          <stop offset="45%" stopColor={`hsl(${hue} 48% 37%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 50% 12%)`} />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="42%" r="55%">
          <stop offset="0%" stopColor={`hsl(${hue} 90% 82%)`} stopOpacity="0.55" />
          <stop offset="100%" stopColor={`hsl(${hue} 90% 82%)`} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="600" height="400" fill={`url(#${gradientId})`} />
      <rect width="600" height="400" fill={`url(#${glowId})`} />
      <g fill={`hsl(${hue} 80% 80%)`} opacity="0.92">
        <ellipse cx="300" cy="252" rx="54" ry="64" />
        <circle cx="300" cy="176" r="43" />
        <path d="M265 146 l-7 -36 l32 21 z" />
        <path d="M335 146 l7 -36 l-32 21 z" />
        <path d="M354 268 q36 26 25 54 q-15 -19 -32 -31 z" />
      </g>
      <g fill="#0b0b0f">
        <circle cx="286" cy="174" r="5" />
        <circle cx="314" cy="174" r="5" />
      </g>
      <g fill={`hsl(${hue} 95% 90%)`} opacity="0.85">
        <circle cx="120" cy="96" r="3" />
        <circle cx="470" cy="120" r="4" />
        <circle cx="196" cy="60" r="2.5" />
        <circle cx="520" cy="230" r="3" />
        <circle cx="86" cy="220" r="2.5" />
        <circle cx="418" cy="326" r="3" />
      </g>
    </svg>
  );
}

/** Abstract hero illustration for a link unfurl. */
function LinkHero({ kind }: { kind: MockLinkPreview['hero'] }) {
  if (kind === 'repository') {
    return (
      <svg className="link-hero" viewBox="0 0 600 300" role="presentation">
        <rect width="600" height="300" fill="#1b2431" />
        <g fill="none" stroke="#3d5170" strokeWidth="2">
          <rect x="60" y="60" width="220" height="26" rx="6" />
          <rect x="60" y="104" width="300" height="14" rx="5" />
          <rect x="60" y="132" width="250" height="14" rx="5" />
          <rect x="60" y="160" width="280" height="14" rx="5" />
        </g>
        <g fill="#64d2a3" opacity="0.85">
          <circle cx="420" cy="120" r="26" />
          <rect x="470" y="106" width="70" height="28" rx="14" />
        </g>
      </svg>
    );
  }

  if (kind === 'plain') {
    return (
      <svg className="link-hero" viewBox="0 0 600 300" role="presentation">
        <rect width="600" height="300" fill="#20242c" />
        <g fill="#3a414d">
          <rect x="70" y="90" width="300" height="18" rx="6" />
          <rect x="70" y="126" width="220" height="14" rx="5" />
          <rect x="70" y="156" width="260" height="14" rx="5" />
        </g>
      </svg>
    );
  }

  // A sketched diagram, evoking a shared infographic.
  return (
    <svg className="link-hero" viewBox="0 0 600 300" role="presentation">
      <rect width="600" height="300" fill="#eceae4" />
      <g fill="#3b3f8f">
        <rect x="196" y="26" width="208" height="26" rx="5" />
        <rect x="228" y="62" width="144" height="11" rx="4" />
      </g>
      <g fill="none" stroke="#6b7280" strokeWidth="2">
        <rect x="24" y="96" width="150" height="52" rx="8" />
        <rect x="24" y="164" width="150" height="52" rx="8" />
        <rect x="426" y="96" width="150" height="52" rx="8" />
        <rect x="426" y="164" width="150" height="52" rx="8" />
      </g>
      <g fill="none" stroke="#3b3f8f" strokeWidth="2">
        <rect x="200" y="118" width="72" height="46" rx="8" />
        <rect x="292" y="118" width="72" height="46" rx="8" />
        <path d="M272 141h20M364 141h20" />
      </g>
      <g fill="#9ca3af">
        <rect x="40" y="112" width="86" height="7" rx="3" />
        <rect x="40" y="128" width="110" height="6" rx="3" />
        <rect x="442" y="112" width="96" height="7" rx="3" />
        <rect x="442" y="180" width="80" height="7" rx="3" />
        <rect x="40" y="180" width="96" height="7" rx="3" />
      </g>
      <g fill="none" stroke="#c2410c" strokeWidth="2">
        <path d="M212 240h176" />
        <path d="M380 234l10 6-10 6" />
      </g>
    </svg>
  );
}

/** An Open Graph style link unfurl. */
function LinkPreviewCard({ preview }: { preview: MockLinkPreview }) {
  return (
    <article className="link-card">
      <LinkHero kind={preview.hero} />
      <div className="link-body">
        <h3 className="link-title">{preview.title}</h3>
        <div className="link-author">
          <span className="link-avatar" aria-hidden="true" />
          <span className="link-author-text">
            <span className="link-author-name">
              {preview.authorName} <span className="link-handle">({preview.authorHandle})</span>
            </span>
            {preview.stats ? <span className="link-stats">{preview.stats}</span> : null}
            {/* Domain only. The card never shows or opens a full URL, and it
                never fetched the page it describes. */}
            <span className="link-domain">{preview.domain}</span>
          </span>
        </div>
      </div>
    </article>
  );
}

/** A generated `/spec` or `/handoff` document, as a compact card. */
function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: MockArtifact;
  onOpen: (artifact: MockArtifact) => void;
}) {
  return (
    <article className={`artifact artifact-${artifact.kind}`}>
      <header className="artifact-head">
        <span className="artifact-kind">{artifact.kind}</span>
        <span className="artifact-meta">{artifact.meta}</span>
      </header>
      <h3 className="artifact-title">{artifact.title}</h3>
      <ul className="artifact-lines">
        {artifact.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <footer className="artifact-foot">
        <button type="button" className="artifact-open" onClick={() => onOpen(artifact)}>
          Open in reader
        </button>
      </footer>
    </article>
  );
}

function MessageRow({
  message,
  onOpenArtifact,
  isStreaming = false,
}: {
  message: MockMessage;
  onOpenArtifact: (artifact: MockArtifact) => void;
  isStreaming?: boolean;
}) {
  const mine = message.role === 'user';
  // Hidden by opacity rather than removed, so it stays in the accessibility
  // tree and is announced with the message. Hover is a visual reveal only, not
  // the sole route to the information.
  const stamp = <span className="stamp">{message.sentAt}</span>;

  if (message.image) {
    return (
      <div className={`row ${mine ? 'row-mine' : 'row-theirs'}`}>
        {mine ? stamp : null}
        <GeneratedImage alt={message.image.alt} prompt={message.image.prompt} />
        {mine ? null : stamp}
      </div>
    );
  }

  if (message.link) {
    return (
      <div className={`row ${mine ? 'row-mine' : 'row-theirs'}`}>
        {mine ? stamp : null}
        <LinkPreviewCard preview={message.link} />
        {mine ? null : stamp}
      </div>
    );
  }

  if (message.artifact) {
    return (
      <div className={`row ${mine ? 'row-mine' : 'row-theirs'}`}>
        {mine ? stamp : null}
        <ArtifactCard artifact={message.artifact} onOpen={onOpenArtifact} />
        {mine ? null : stamp}
      </div>
    );
  }

  return (
    <div className={`row ${mine ? 'row-mine' : 'row-theirs'}`}>
      {mine ? stamp : null}
      <div className={`bubble ${mine ? 'bubble-mine' : 'bubble-theirs'}`}>
        <MessageText text={message.text ?? ''} />
        {isStreaming ? <span className="caret" aria-hidden="true" /> : null}
      </div>
      {mine ? null : stamp}
    </div>
  );
}

export function DemoShell() {
  return <ChatDemo />;
}

function isNarrowWindow(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 820px)').matches === true
  );
}

function useNarrowWindow(): boolean {
  const [isNarrow, setIsNarrow] = useState(isNarrowWindow);

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 820px)');
    const onChange = () => setIsNarrow(mediaQuery.matches);

    onChange();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', onChange);
    } else {
      mediaQuery.addListener?.(onChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', onChange);
      } else {
        mediaQuery.removeListener?.(onChange);
      }
    };
  }, []);

  return isNarrow;
}

export function ChatDemo() {
  const [conversations, setConversations] = useState<MockConversation[]>(MOCK_CONVERSATIONS);
  const [activeId, setActiveId] = useState(MOCK_CONVERSATIONS[0]?.id ?? '');
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(() => !isNarrowWindow());
  const isNarrow = useNarrowWindow();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [pendingReply, setPendingReply] = useState(false);
  const [reader, setReader] = useState<ReaderDocument | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  /** Id of the message currently streaming, so the composer can offer stop. */
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const replyCount = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const active = conversations.find((conversation) => conversation.id === activeId);
  const activeFamiliar = MOCK_FAMILIARS.find((familiar) => familiar.id === active?.familiarId);
  const messageCount = active?.messages.length ?? 0;

  const visible = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const showingCommands = draft.trim().startsWith('/') && !draft.trim().includes(' ');
  const commandMatches = showingCommands
    ? MOCK_COMMANDS.filter((command) => command.name.startsWith(draft.trim()))
    : [];

  useEffect(() => {
    // Nothing to scroll to in an empty conversation, and reading both values
    // here is also what makes them genuine dependencies rather than triggers
    // the linter cannot see.
    if (messageCount === 0 && !pendingReply) {
      return;
    }

    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageCount, pendingReply]);

  // Keep the highlight in range as the list narrows; an index left pointing
  // past the end would complete to nothing.
  const matchCount = commandMatches.length;

  useEffect(() => {
    setCommandIndex((current) => (current < matchCount ? current : 0));
  }, [matchCount]);

  // Unmount clears anything still pending. Reads only the ref, so it needs no
  // dependencies and cannot go stale.
  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const id of pending) {
        window.clearTimeout(id);
      }
    };
  }, []);

  useEffect(() => {
    if (isNarrow && conversationsOpen && inspectorOpen) {
      setInspectorOpen(false);
    }
  }, [conversationsOpen, inspectorOpen, isNarrow]);

  useEffect(() => {
    if (!isNarrow || (!conversationsOpen && !inspectorOpen)) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }

      setConversationsOpen(false);
      setInspectorOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conversationsOpen, inspectorOpen, isNarrow]);

  /** Complete the draft to a command, leaving a trailing space to type into. */
  function completeCommand(name: string) {
    setDraft(`${name} `);
    setCommandIndex(0);
  }

  /** Track a timer so every pending callback can be cancelled together. */
  function track(id: number): number {
    timers.current.push(id);

    return id;
  }

  /**
   * Cancel everything in flight.
   *
   * Called on stop, on conversation switch, and on unmount. Without this a
   * stream keeps writing into a conversation the user has already left, which
   * looks like the demo hallucinating text into the wrong thread.
   */
  function cancelPending() {
    for (const id of timers.current) {
      window.clearTimeout(id);
    }

    timers.current = [];
    setPendingReply(false);
    setStreamingId(null);
  }

  function updateMessage(
    conversationId: string,
    messageId: string,
    change: (message: MockMessage) => MockMessage,
  ) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === messageId ? change(message) : message,
              ),
            }
          : conversation,
      ),
    );
  }

  function appendTo(conversationId: string, message: MockMessage) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, messages: [...conversation.messages, message] }
          : conversation,
      ),
    );
  }

  function send() {
    const text = draft.trim();

    if (!text || !active) {
      return;
    }

    const conversationId = active.id;

    appendTo(conversationId, { id: `sent-${Date.now()}`, role: 'user', sentAt: nowLabel(), text });
    setDraft('');
    setPendingReply(true);

    // A pause before the first token, because a reply that begins instantly
    // reads as a lookup rather than as a response.
    track(
      window.setTimeout(() => {
        replyCount.current += 1;
        const reply = mockReply(text, replyCount.current);
        setPendingReply(false);

        // Only prose streams. An image, an unfurl, or a document arrives whole
        // because that is how it would actually arrive -- pretending to type
        // out a picture would be a lie about the medium.
        if (!reply.text) {
          appendTo(conversationId, reply);
          return;
        }

        streamInto(conversationId, reply, reply.text);
      }, 650),
    );
  }

  /**
   * Reveal a reply a few words at a time.
   *
   * Word-sized chunks rather than characters: a character-by-character reveal
   * looks like a typewriter effect, and a real token stream arrives in pieces
   * closer to words. Reduced motion delivers the whole thing at once, since
   * the animation carries no information the final text does not.
   */
  function streamInto(conversationId: string, reply: MockMessage, full: string) {
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (instant) {
      appendTo(conversationId, reply);
      return;
    }

    appendTo(conversationId, { ...reply, text: '' });
    setStreamingId(reply.id);

    const chunks = full.split(/(\s+)/).filter(Boolean);
    let shown = '';

    chunks.forEach((chunk, index) => {
      track(
        window.setTimeout(
          () => {
            shown += chunk;
            updateMessage(conversationId, reply.id, (message) => ({ ...message, text: shown }));

            if (index === chunks.length - 1) {
              setStreamingId(null);
            }
          },
          // Slightly uneven pacing; a fixed interval reads as mechanical.
          index * 45 + Math.min(index, 6) * 12,
        ),
      );
    });
  }

  function changeActiveFamiliar(familiarId: string) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeId ? { ...conversation, familiarId } : conversation,
      ),
    );
  }

  function showConversations() {
    if (isNarrow) {
      setInspectorOpen(false);
    }
    setConversationsOpen(true);
  }

  function showInspector() {
    if (isNarrow) {
      setConversationsOpen(false);
    }
    setInspectorOpen(true);
  }

  return (
    <div
      className={`chat-demo ${conversationsOpen ? '' : 'is-conversations-closed'} ${
        inspectorOpen ? '' : 'is-inspector-closed'
      }`}
    >
      <aside
        id="conversation-panel"
        className="sidebar glass-panel"
        aria-label="Conversations"
        hidden={!conversationsOpen}
      >
        <header className="sidebar-header">
          <h1>Chats</h1>
          <button
            type="button"
            className="glass-control"
            aria-label="Hide conversations"
            aria-controls="conversation-panel"
            aria-expanded="true"
            onClick={() => setConversationsOpen(false)}
          >
            ‹
          </button>
        </header>
        <div className="search-wrap">
          <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="10.6" y1="10.6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <input
            className="search"
            type="search"
            placeholder="Search"
            aria-label="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <ul className="conversations">
          {visible.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className={`conversation ${conversation.id === activeId ? 'is-active' : ''}`}
                aria-label={conversation.title}
                onClick={() => {
                  // Switching away cancels the stream rather than letting it
                  // keep writing into a thread the user has left.
                  cancelPending();
                  setActiveId(conversation.id);
                }}
              >
                <Avatar label={conversation.title} seed={conversation.id} size={44} />
                <span className="conversation-body">
                  <span className="conversation-top">
                    <span className="conversation-title">{conversation.title}</span>
                    <span className="conversation-time">{conversation.timestamp}</span>
                  </span>
                  <span className="conversation-preview">
                    {conversation.previewGlyph ? (
                      <span className="preview-glyph" aria-hidden="true">
                        {conversation.previewGlyph}
                      </span>
                    ) : null}
                    {conversation.preview}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <button type="button" className="new-conversation">
          <span aria-hidden="true">＋</span>
          <span>New conversation</span>
        </button>
      </aside>

      <main className="thread">
        <header className="thread-header">
          {conversationsOpen ? (
            <span />
          ) : (
            <button
              type="button"
              className="glass-control"
              aria-label="Show conversations"
              aria-controls="conversation-panel"
              aria-expanded="false"
              onClick={showConversations}
            >
              ›
            </button>
          )}

          <div className="thread-title">
            <Avatar
              label={activeFamiliar?.name ?? active?.title ?? ''}
              seed={activeFamiliar?.id ?? active?.id ?? 'none'}
              size={24}
            />
            <span>{activeFamiliar?.name ?? 'No agent'}</span>
          </div>

          {inspectorOpen ? (
            <span />
          ) : (
            <button
              type="button"
              className="glass-control"
              aria-label="Show agent inspector"
              aria-controls="agent-inspector"
              aria-expanded="false"
              onClick={showInspector}
            >
              ‹
            </button>
          )}
        </header>

        <div className="transcript">
          {active ? (
            <>
              <p className="timestamp">{active.openedAt}</p>
              {active.messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  isStreaming={message.id === streamingId}
                  onOpenArtifact={(artifact) =>
                    setReader({
                      kind: artifact.kind,
                      title: artifact.title,
                      markdown: artifact.markdown,
                    })
                  }
                />
              ))}
              {pendingReply ? (
                <div className="row row-theirs">
                  <output className="bubble bubble-theirs typing" aria-label="Replying">
                    <span />
                    <span />
                    <span />
                  </output>
                </div>
              ) : null}
              <div ref={transcriptEnd} />
            </>
          ) : null}
        </div>

        <div className="composer-wrap">
          {showingCommands ? (
            <ul className="command-menu">
              {commandMatches.map((command, index) => (
                <li key={command.name}>
                  <button
                    type="button"
                    className={`command-option ${index === commandIndex ? 'is-highlighted' : ''}`}
                    onMouseEnter={() => setCommandIndex(index)}
                    onClick={() => completeCommand(command.name)}
                  >
                    <span className="command">{command.name}</span>
                    <span className="command-hint">{command.hint}</span>
                  </button>
                </li>
              ))}
              <li className="command-help">
                <kbd>up</kbd> <kbd>down</kbd> to move · <kbd>tab</kbd> or <kbd>right</kbd> to
                complete
              </li>
            </ul>
          ) : null}

          <div className="composer">
            <button type="button" className="round-button" aria-label="Add attachment">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M9.1 4h1.8v5.1H16v1.8h-5.1V16H9.1v-5.1H4V9.1h5.1z" fill="currentColor" />
              </svg>
            </button>

            <input
              className="composer-input"
              placeholder="Message, or type / for commands"
              aria-label="Message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                const open = commandMatches.length > 0;
                const selected = commandMatches[commandIndex];

                if (open) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCommandIndex((current) => (current + 1) % commandMatches.length);
                    return;
                  }

                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setCommandIndex(
                      (current) => (current - 1 + commandMatches.length) % commandMatches.length,
                    );
                    return;
                  }

                  // Tab and Right both complete. Right only when the caret is
                  // at the end, so it still moves the caret mid-word.
                  const atEnd =
                    event.currentTarget.selectionStart === event.currentTarget.value.length;

                  if (selected && (event.key === 'Tab' || (event.key === 'ArrowRight' && atEnd))) {
                    event.preventDefault();
                    completeCommand(selected.name);
                    return;
                  }

                  // Enter accepts the highlighted command rather than sending a
                  // half-typed one.
                  if (selected && event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    completeCommand(selected.name);
                    return;
                  }

                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setDraft('');
                    return;
                  }
                }

                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />

            {streamingId || pendingReply ? (
              <button
                type="button"
                className="round-button stop"
                aria-label="Stop generating"
                onClick={cancelPending}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="round-button send"
                aria-label="Send"
                onClick={send}
                disabled={draft.trim().length === 0}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M3 17l14-7L3 3v5.4l9 1.6-9 1.6z" fill="currentColor" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </main>

      <aside id="agent-inspector" aria-label="Agent inspector" hidden={!inspectorOpen}>
        <ChatInspector
          familiar={activeFamiliar}
          onClose={() => setInspectorOpen(false)}
          onFamiliarChange={changeActiveFamiliar}
        />
      </aside>

      {reader ? <DocumentReader document={reader} onClose={() => setReader(null)} /> : null}
    </div>
  );
}
