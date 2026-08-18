import { useEffect, useMemo, useRef, useState } from 'react';
import { DocumentReader, type ReaderDocument } from './document-reader';
import {
  MOCK_COMMANDS,
  MOCK_CONVERSATIONS,
  type MockConversation,
  type MockMessage,
  mockReply,
  nowLabel,
} from './mock-data';
import type { MockArtifact, MockLinkPreview } from './mock-rich-content';

/**
 * Proof-of-concept chat surface.
 *
 * This is a demo of what Phases 1 through 3 will present, driven entirely by
 * local mock data. It connects to nothing. The Phase 0 scaffold remains the
 * app's real entry point; this renders only at `?demo=chat`.
 */

/** A conversation's gradient avatar, seeded off its id so it stays stable. */
function Avatar({ seed, size }: { seed: string; size: number }) {
  const hue = useMemo(() => {
    let total = 0;
    for (const character of seed) {
      total += character.charCodeAt(0);
    }
    return total % 360;
  }, [seed]);

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg,
          hsl(${hue} 85% 62%),
          hsl(${(hue + 55) % 360} 78% 58%),
          hsl(${(hue + 110) % 360} 82% 66%))`,
      }}
    />
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
}: {
  message: MockMessage;
  onOpenArtifact: (artifact: MockArtifact) => void;
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
      </div>
      {mine ? null : stamp}
    </div>
  );
}

export function ChatDemo() {
  const [conversations, setConversations] = useState<MockConversation[]>(MOCK_CONVERSATIONS);
  const [activeId, setActiveId] = useState(MOCK_CONVERSATIONS[0]?.id ?? '');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [pendingReply, setPendingReply] = useState(false);
  const [reader, setReader] = useState<ReaderDocument | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const replyCount = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const active = conversations.find((conversation) => conversation.id === activeId);
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

  /** Complete the draft to a command, leaving a trailing space to type into. */
  function completeCommand(name: string) {
    setDraft(`${name} `);
    setCommandIndex(0);
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

    appendTo(active.id, { id: `sent-${Date.now()}`, role: 'user', sentAt: nowLabel(), text });
    setDraft('');
    setPendingReply(true);

    // A visible delay, because a reply that lands instantly reads as a canned
    // string rather than as a response. This is the demo's only pretence.
    window.setTimeout(() => {
      replyCount.current += 1;
      appendTo(active.id, mockReply(text, replyCount.current));
      setPendingReply(false);
    }, 700);
  }

  return (
    <div className="chat-demo">
      <aside className="sidebar">
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
                onClick={() => setActiveId(conversation.id)}
              >
                <Avatar seed={conversation.id} size={44} />
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
      </aside>

      <main className="thread">
        <header className="thread-header">
          <button type="button" className="icon-button" aria-label="New conversation">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M3 14.2V17h2.8l8.4-8.4-2.8-2.8L3 14.2zM16.8 6.2a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-1.3 1.3 2.8 2.8 1.5-1.1z"
                fill="currentColor"
              />
            </svg>
          </button>

          <div className="thread-title">
            <Avatar seed={active?.id ?? 'none'} size={22} />
            <span>{active?.title ?? 'No conversation'}</span>
          </div>

          <button type="button" className="icon-button" aria-label="Settings">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M10 6.6A3.4 3.4 0 1 0 10 13.4 3.4 3.4 0 0 0 10 6.6zm7 3.4c0-.5 0-1-.1-1.4l1.6-1.2-1.6-2.8-1.9.7c-.7-.6-1.5-1-2.3-1.3L12.4 2H9.6l-.3 2c-.9.3-1.6.7-2.3 1.3l-1.9-.7-1.6 2.8L5.1 8.6c-.1.4-.1.9-.1 1.4s0 1 .1 1.4l-1.6 1.2 1.6 2.8 1.9-.7c.7.6 1.4 1 2.3 1.3l.3 2h2.8l.3-2c.9-.3 1.6-.7 2.3-1.3l1.9.7 1.6-2.8-1.6-1.2c.1-.4.1-.9.1-1.4z"
                fill="currentColor"
              />
            </svg>
          </button>
        </header>

        <div className="transcript">
          {active ? (
            <>
              <p className="timestamp">{active.openedAt}</p>
              {active.messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
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
          </div>
        </div>
      </main>

      {reader ? <DocumentReader document={reader} onClose={() => setReader(null)} /> : null}
    </div>
  );
}
