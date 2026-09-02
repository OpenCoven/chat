import { Menu } from '@base-ui/react/menu';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChatInspector } from './chat-inspector';
import { DocumentReader, type ReaderDocument } from './document-reader';
import { Icon } from './minimal-icons';
import {
  MOCK_COMMANDS,
  MOCK_CONVERSATIONS,
  type MockConversation,
  type MockMessage,
  mockReply,
  nowLabel,
} from './mock-data';
import { MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';
import type { MockArtifact, MockLinkPreview } from './mock-rich-content';

type RailSide = 'conversations' | 'inspector';

const RAIL_LIMITS = {
  conversations: { min: 240, max: 440 },
  inspector: { min: 300, max: 480 },
} as const;
const MIN_THREAD_WIDTH = 360;
const RAIL_KEYBOARD_STEP = 12;

/**
 * Proof-of-concept chat surface.
 *
 * This is a demo of what later phases will present, driven entirely by local
 * mock data. It connects to nothing. The Phase 1 read-only production app
 * remains the real entry point; this renders only at `?demo=chat`.
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

function FamiliarSelector({
  activeFamiliar,
  onValueChange,
}: {
  activeFamiliar: MockFamiliar | undefined;
  onValueChange: (familiarId: string) => void;
}) {
  const activeName = activeFamiliar?.name ?? 'Choose familiar';

  return (
    <Menu.Root>
      <Menu.Trigger className="familiar-switcher" aria-label={`Sidebar familiar: ${activeName}`}>
        <Avatar
          label={activeFamiliar?.name ?? 'No familiar'}
          seed={activeFamiliar?.id ?? 'none'}
          size={30}
        />
        <span className="familiar-switcher-copy">
          <span className="familiar-switcher-name">{activeName}</span>
          <span className="familiar-switcher-role">
            <span className="familiar-switcher-status" aria-hidden="true" />
            {activeFamiliar?.role ?? 'No familiar selected'}
          </span>
        </span>
        <Icon name="caret-up-down" size={16} />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner className="familiar-menu-positioner" align="start" sideOffset={6}>
          <Menu.Popup className="familiar-menu" aria-label="Choose active familiar">
            <Menu.Group>
              <Menu.GroupLabel className="familiar-menu-label">Familiars</Menu.GroupLabel>
              <Menu.RadioGroup
                value={activeFamiliar?.id ?? ''}
                onValueChange={(value) => {
                  if (typeof value === 'string') {
                    onValueChange(value);
                  }
                }}
              >
                {MOCK_FAMILIARS.map((familiar) => (
                  <Menu.RadioItem
                    key={familiar.id}
                    className="familiar-menu-item"
                    value={familiar.id}
                    label={`${familiar.name}, ${familiar.role}`}
                    aria-label={`${familiar.name}, ${familiar.role}`}
                    closeOnClick
                  >
                    <Avatar label={familiar.name} seed={familiar.id} size={28} />
                    <span className="familiar-menu-copy">
                      <span className="familiar-menu-name">{familiar.name}</span>
                      <span className="familiar-menu-role">{familiar.role}</span>
                    </span>
                    <Menu.RadioItemIndicator className="familiar-menu-current">
                      Current
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ConversationSearchDialog({
  conversations,
  activeId,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: {
  conversations: MockConversation[];
  activeId: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (conversationId: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const results = conversations.filter((conversation) => {
    const familiar = MOCK_FAMILIARS.find((item) => item.id === conversation.familiarId);
    return [conversation.title, conversation.preview, familiar?.name ?? '']
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    input.current?.focus();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  function keepFocusInside(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') {
      return;
    }

    const focusable = panel.current?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled])',
    );
    if (!focusable || focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="conversation-search-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
      onKeyDown={keepFocusInside}
    >
      <button
        type="button"
        className="conversation-search-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div ref={panel} className="conversation-search-panel">
        <div className="conversation-search-field">
          <Icon name="magnifying-glass" size={17} />
          <input
            ref={input}
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversations"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </div>
        <div className="conversation-search-results">
          <p className="conversation-search-heading">
            <span>Conversations</span>
            <span>{results.length}</span>
          </p>
          {results.length > 0 ? (
            results.map((conversation) => {
              const familiar = MOCK_FAMILIARS.find((item) => item.id === conversation.familiarId);

              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={`conversation-search-result ${
                    conversation.id === activeId ? 'is-active' : ''
                  }`}
                  aria-label={`${conversation.title}, ${familiar?.name ?? 'No familiar'}`}
                  onClick={() => onSelect(conversation.id)}
                >
                  <Avatar
                    label={familiar?.name ?? conversation.title}
                    seed={familiar?.id ?? conversation.id}
                    size={28}
                  />
                  <span className="conversation-search-copy">
                    <strong>{conversation.title}</strong>
                    <span>
                      {familiar?.name ?? 'No familiar'} · {conversation.preview}
                    </span>
                  </span>
                  {conversation.id === activeId ? (
                    <Icon name="check-circle-fill" size={15} />
                  ) : (
                    <span className="conversation-search-time">{conversation.timestamp}</span>
                  )}
                </button>
              );
            })
          ) : (
            <p className="conversation-search-empty">No conversations match “{query.trim()}”.</p>
          )}
        </div>
      </div>
    </div>
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
function GeneratedImage({
  alt,
  prompt,
  onOpen,
}: {
  alt: string;
  prompt: string;
  onOpen?: () => void;
}) {
  // Hue derived from the prompt, so `/image cat purple` and `/image dog blue`
  // are visibly different generations rather than the same tile twice.
  let seed = 0;
  for (const character of prompt) {
    seed += character.charCodeAt(0);
  }
  const hue = seed % 360;
  const instanceId = useId().replaceAll(':', '');
  const gradientId = `demo-bg-${instanceId}-${hue}`;
  const glowId = `demo-glow-${instanceId}-${hue}`;

  const artwork = (
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

  if (!onOpen) {
    return artwork;
  }

  return (
    <button
      type="button"
      className="generated-trigger"
      aria-label={`Expand image: ${alt}`}
      onClick={onOpen}
    >
      {artwork}
    </button>
  );
}

function ImageLightbox({
  image,
  onClose,
}: {
  image: NonNullable<MockMessage['image']>;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.current?.focus();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    closeButton.current?.focus();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded image: ${image.alt}`}
    >
      <button
        type="button"
        className="image-lightbox-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="image-lightbox-artwork">
        <GeneratedImage alt={image.alt} prompt={image.prompt} />
      </div>
      <button
        ref={closeButton}
        type="button"
        className="image-lightbox-close"
        aria-label="Close image preview"
        onClick={onClose}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
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

function ReasoningBlock({ reasoning }: { reasoning: NonNullable<MockMessage['reasoning']> }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const stepIcons = {
    analysis: 'magnifying-glass',
    design: 'paint-brush',
    safety: 'check-circle-fill',
  } as const;
  const failedSteps = reasoning.steps.filter((step) => step.status === 'failed').length;

  return (
    <section className="reasoning-block" aria-label="Reasoning">
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-mark" aria-hidden="true">
          <Icon name="brain" size={15} />
        </span>
        <span className="reasoning-heading">
          <span className="reasoning-label">Reasoning</span>
          <span className="reasoning-description">{reasoning.summary}</span>
        </span>
        <span className="reasoning-meta">
          {failedSteps > 0 ? (
            <span className="reasoning-failure">
              <Icon name="warning-circle-fill" size={11} />
              {failedSteps === 1 ? '1 failed' : `${failedSteps} failed`}
            </span>
          ) : null}
          <span>
            {reasoning.steps.length} {reasoning.steps.length === 1 ? 'step' : 'steps'}
          </span>
          <span>{reasoning.duration}</span>
        </span>
        <span className="reasoning-caret" aria-hidden="true">
          <Icon name="caret-down" size={14} />
        </span>
      </button>
      <div id={bodyId} className={`reasoning-body ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="reasoning-body-clip">
          <div className="reasoning-content">
            <ol>
              {reasoning.steps.map((step, index) => (
                <li
                  key={step.label}
                  className="reasoning-step"
                  data-kind={step.kind}
                  data-status={step.status ?? 'ok'}
                  style={{ animationDelay: `${80 + index * 60}ms` }}
                >
                  <span className="reasoning-step-rail" aria-hidden="true">
                    <span className="reasoning-step-icon">
                      <Icon name={stepIcons[step.kind]} size={16} />
                    </span>
                    <span
                      className="reasoning-step-line"
                      style={{ animationDelay: `${200 + index * 60}ms` }}
                    />
                  </span>
                  <span className="reasoning-step-copy">
                    <span className="reasoning-step-heading">
                      <strong>{step.label}</strong>
                      <code>{step.tool}</code>
                      <span>{step.duration}</span>
                    </span>
                    <span>
                      {step.status === 'failed' ? (
                        <strong className="reasoning-state">Failed — </strong>
                      ) : null}
                      {step.status === 'retry' ? (
                        <strong className="reasoning-state">Retried — </strong>
                      ) : null}
                      {step.text}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <footer className="reasoning-footer">
              <span>{reasoning.footer}</span>
              <span>
                {reasoning.toolCalls} {reasoning.toolCalls === 1 ? 'tool call' : 'tool calls'}
              </span>
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}

function MessageRow({
  message,
  onOpenImage,
  onOpenArtifact,
  isStreaming = false,
}: {
  message: MockMessage;
  onOpenImage: (image: NonNullable<MockMessage['image']>) => void;
  onOpenArtifact: (artifact: MockArtifact) => void;
  isStreaming?: boolean;
}) {
  const mine = message.role === 'user';
  // Hidden by opacity rather than removed, so it stays in the accessibility
  // tree and is announced with the message. Hover is a visual reveal only, not
  // the sole route to the information.
  const stamp = <span className="stamp">{message.sentAt}</span>;

  if (message.image) {
    const image = message.image;

    return (
      <div className={`row ${mine ? 'row-mine' : 'row-theirs'}`}>
        {mine ? stamp : null}
        <div className="message-stack">
          {message.reasoning ? <ReasoningBlock reasoning={message.reasoning} /> : null}
          <GeneratedImage alt={image.alt} prompt={image.prompt} onOpen={() => onOpenImage(image)} />
        </div>
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
  const [conversationsWidth, setConversationsWidth] = useState(320);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [resizingRail, setResizingRail] = useState<RailSide | null>(null);
  const isNarrow = useNarrowWindow();
  const [draft, setDraft] = useState('');
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState('');
  const [pendingReply, setPendingReply] = useState(false);
  const [reader, setReader] = useState<ReaderDocument | null>(null);
  const [focusedImage, setFocusedImage] = useState<NonNullable<MockMessage['image']> | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  /** Id of the message currently streaming, so the composer can offer stop. */
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const replyCount = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const active = conversations.find((conversation) => conversation.id === activeId);
  const activeFamiliar = MOCK_FAMILIARS.find((familiar) => familiar.id === active?.familiarId);
  const messageCount = active?.messages.length ?? 0;

  const visible = conversations;

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
      resizeCleanup.current?.();
    };
  }, []);

  useEffect(() => {
    if (isNarrow && conversationsOpen && inspectorOpen) {
      setInspectorOpen(false);
    }
  }, [conversationsOpen, inspectorOpen, isNarrow]);

  useEffect(() => {
    if (
      !isNarrow ||
      conversationSearchOpen ||
      focusedImage ||
      reader ||
      (!conversationsOpen && !inspectorOpen)
    ) {
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
  }, [conversationSearchOpen, conversationsOpen, focusedImage, inspectorOpen, isNarrow, reader]);

  const closeConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
  }, []);

  const openConversationSearch = useCallback(() => {
    setConversationSearchQuery('');
    setConversationSearchOpen(true);
  }, []);

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') {
        return;
      }

      event.preventDefault();
      if (conversationSearchOpen) {
        closeConversationSearch();
      } else {
        openConversationSearch();
      }
    }

    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [closeConversationSearch, conversationSearchOpen, openConversationSearch]);

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

  function selectConversationFromSearch(conversationId: string) {
    cancelPending();
    setActiveId(conversationId);
    closeConversationSearch();
    if (isNarrow) {
      setConversationsOpen(false);
    }
  }

  function maximumRailWidth(side: RailSide): number {
    const otherWidth =
      side === 'conversations'
        ? inspectorOpen
          ? inspectorWidth
          : 0
        : conversationsOpen
          ? conversationsWidth
          : 0;
    const limit = RAIL_LIMITS[side];

    const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;

    return Math.max(limit.min, Math.min(limit.max, viewportWidth - otherWidth - MIN_THREAD_WIDTH));
  }

  function setRailWidth(side: RailSide, width: number) {
    const limit = RAIL_LIMITS[side];
    const nextWidth = Math.min(maximumRailWidth(side), Math.max(limit.min, Math.round(width)));

    if (side === 'conversations') {
      setConversationsWidth(nextWidth);
    } else {
      setInspectorWidth(nextWidth);
    }
  }

  function beginRailResize(side: RailSide, event: ReactPointerEvent<HTMLDivElement>) {
    if (isNarrow || event.button !== 0) {
      return;
    }

    event.preventDefault();
    resizeCleanup.current?.();

    const startX = event.clientX;
    const startWidth = side === 'conversations' ? conversationsWidth : inspectorWidth;

    function handlePointerMove(pointerEvent: PointerEvent) {
      const delta =
        side === 'conversations' ? pointerEvent.clientX - startX : startX - pointerEvent.clientX;
      setRailWidth(side, startWidth + delta);
    }

    function finishResize() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      resizeCleanup.current = null;
      setResizingRail(null);
    }

    setResizingRail(side);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    resizeCleanup.current = finishResize;
  }

  function resizeRailWithKeyboard(side: RailSide, event: ReactKeyboardEvent<HTMLDivElement>) {
    const currentWidth = side === 'conversations' ? conversationsWidth : inspectorWidth;
    const outwardKey = side === 'conversations' ? 'ArrowRight' : 'ArrowLeft';
    const inwardKey = side === 'conversations' ? 'ArrowLeft' : 'ArrowRight';
    let nextWidth: number | undefined;

    if (event.key === outwardKey) {
      nextWidth = currentWidth + (event.shiftKey ? RAIL_KEYBOARD_STEP * 4 : RAIL_KEYBOARD_STEP);
    } else if (event.key === inwardKey) {
      nextWidth = currentWidth - (event.shiftKey ? RAIL_KEYBOARD_STEP * 4 : RAIL_KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      nextWidth = RAIL_LIMITS[side].min;
    } else if (event.key === 'End') {
      nextWidth = maximumRailWidth(side);
    }

    if (nextWidth !== undefined) {
      event.preventDefault();
      setRailWidth(side, nextWidth);
    }
  }

  const closeFocusedImage = useCallback(() => {
    setFocusedImage(null);
  }, []);

  const layoutStyle: CSSProperties & {
    '--demo-conversations-open-width': string;
    '--demo-inspector-open-width': string;
  } = {
    '--demo-conversations-open-width': `${conversationsWidth}px`,
    '--demo-inspector-open-width': `${inspectorWidth}px`,
  };

  return (
    <div
      className={`chat-demo ${conversationsOpen ? '' : 'is-conversations-closed'} ${
        inspectorOpen ? '' : 'is-inspector-closed'
      } ${resizingRail ? 'is-resizing' : ''}`}
      style={layoutStyle}
    >
      <aside
        id="conversation-panel"
        className="sidebar glass-panel"
        aria-label="Conversations"
        hidden={!conversationsOpen}
      >
        <header className="sidebar-header">
          <h2 className="sidebar-title">
            <button
              type="button"
              className="sidebar-header-toggle"
              aria-label="Hide conversations"
              aria-controls="conversation-panel"
              aria-expanded="true"
              onClick={() => setConversationsOpen(false)}
            >
              <span className="sidebar-title-label">Conversations</span>
              <Icon name="sidebar-simple" size={15} />
            </button>
          </h2>
        </header>

        <div className="sidebar-controls">
          <FamiliarSelector activeFamiliar={activeFamiliar} onValueChange={changeActiveFamiliar} />

          <div className="sidebar-primary-actions">
            <button type="button" className="new-conversation" aria-label="Start a new chat">
              <Icon name="plus" size={14} />
              <span>New Chat</span>
            </button>
            <button
              type="button"
              className="conversation-search-trigger"
              aria-label="Search conversations"
              aria-keyshortcuts="Meta+K Control+K"
              title="Search conversations (⌘K)"
              onClick={openConversationSearch}
            >
              <Icon name="magnifying-glass" size={15} />
            </button>
          </div>
        </div>

        <div className={`conversation-scroll ${visible.length < 5 ? 'is-sparse' : ''}`}>
          {visible.length > 0 ? (
            <h3 className="conversation-section-label">
              <span>Recent</span>
              <span className="conversation-section-count">{visible.length}</span>
              <span className="conversation-section-rule" aria-hidden="true" />
            </h3>
          ) : null}

          <ul className="conversations">
            {visible.map((conversation) => {
              const conversationFamiliar = MOCK_FAMILIARS.find(
                (familiar) => familiar.id === conversation.familiarId,
              );
              const conversationStatus = conversationFamiliar?.status ?? 'offline';

              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={`conversation ${conversation.id === activeId ? 'is-active' : ''}`}
                    aria-label={conversation.title}
                    data-status={conversationStatus}
                    onClick={() => {
                      // Switching away cancels the stream rather than letting it
                      // keep writing into a thread the user has left.
                      cancelPending();
                      setActiveId(conversation.id);
                    }}
                  >
                    <span className="conversation-status-rail" aria-hidden="true" />
                    <Avatar
                      label={conversationFamiliar?.name ?? conversation.title}
                      seed={conversationFamiliar?.id ?? conversation.id}
                      size={24}
                    />
                    <span className="conversation-body">
                      <span className="conversation-top">
                        <span className="conversation-title">{conversation.title}</span>
                        <span className="conversation-time">{conversation.timestamp}</span>
                      </span>
                      <span className="conversation-preview">
                        <span className="conversation-status-dot" aria-hidden="true" />
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
              );
            })}
          </ul>
        </div>
        <hr
          className="rail-resizer rail-resizer-conversations"
          aria-label="Resize conversations sidebar"
          aria-orientation="vertical"
          aria-valuemin={RAIL_LIMITS.conversations.min}
          aria-valuemax={maximumRailWidth('conversations')}
          aria-valuenow={conversationsWidth}
          tabIndex={0}
          onPointerDown={(event) => beginRailResize('conversations', event)}
          onKeyDown={(event) => resizeRailWithKeyboard('conversations', event)}
        />
      </aside>

      <main className="thread">
        {!conversationsOpen ? (
          <button
            type="button"
            className="glass-control thread-edge-control thread-edge-control-left"
            aria-label="Show conversations"
            aria-controls="conversation-panel"
            aria-expanded="false"
            onClick={showConversations}
          >
            <Icon name="sidebar-simple" size={16} />
          </button>
        ) : null}

        {!inspectorOpen ? (
          <button
            type="button"
            className="glass-control thread-edge-control thread-edge-control-right"
            aria-label="Show agent inspector"
            aria-controls="agent-inspector"
            aria-expanded="false"
            onClick={showInspector}
          >
            ‹
          </button>
        ) : null}

        <div className="transcript">
          {active ? (
            <>
              <p className="timestamp">{active.openedAt}</p>
              {active.messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  isStreaming={message.id === streamingId}
                  onOpenImage={setFocusedImage}
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
        <hr
          className="rail-resizer rail-resizer-inspector"
          aria-label="Resize agent inspector"
          aria-orientation="vertical"
          aria-valuemin={RAIL_LIMITS.inspector.min}
          aria-valuemax={maximumRailWidth('inspector')}
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          onPointerDown={(event) => beginRailResize('inspector', event)}
          onKeyDown={(event) => resizeRailWithKeyboard('inspector', event)}
        />
        <ChatInspector familiar={activeFamiliar} onClose={() => setInspectorOpen(false)} />
      </aside>

      {reader ? <DocumentReader document={reader} onClose={() => setReader(null)} /> : null}
      {focusedImage ? <ImageLightbox image={focusedImage} onClose={closeFocusedImage} /> : null}
      {conversationSearchOpen ? (
        <ConversationSearchDialog
          conversations={conversations}
          activeId={activeId}
          query={conversationSearchQuery}
          onQueryChange={setConversationSearchQuery}
          onSelect={selectConversationFromSearch}
          onClose={closeConversationSearch}
        />
      ) : null}
    </div>
  );
}
