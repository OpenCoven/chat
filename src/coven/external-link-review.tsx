import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { copyText } from './copy-text';
import './external-link-review.css';
import { closeModal, openModal } from './modal';

/** The longest address, in UTF-8 bytes, that Chat shows for review and will open or copy. */
export const REVIEW_ADDRESS_LIMIT = 8192;

/** What a reader is shown before an external link opens. */
export type AddressReview =
  | Readonly<{
      kind: 'ready';
      /** The parsed address: exactly what Open hands on and Copy address copies. */
      address: string;
      /** The site the address reaches, with its port when it names one. */
      host: string;
      /** Text before an "@" is a sign-in name, not the site. */
      signIn: boolean;
      /** The site's name has international characters, shown in their encoded form. */
      international: boolean;
    }>
  | Readonly<{ kind: 'too-long'; bytes: number }>
  | Readonly<{ kind: 'unreadable' }>;

const utf8 = new TextEncoder();

/**
 * Markdown percent-encodes the brackets around an IPv6 host, so a host written
 * `[::1]` arrives as `%5B::1%5D` and no longer parses. Only brackets in the
 * host position around IPv6 characters are put back; the parser still decides.
 */
const ENCODED_IPV6_HOST = /^(https?:\/\/(?:[^/?#@]*@)?)%5B([0-9a-f:.]+)%5D(?=[:/?#]|$)/i;

/**
 * Parses a destination that Markdown policy already limited to http(s) and
 * says what the reader will review. The address is never shortened: one past
 * the limit is refused whole.
 */
export function reviewAddress(destination: string): AddressReview {
  let url: URL;
  try {
    url = new URL(destination.replace(ENCODED_IPV6_HOST, '$1[$2]'));
  } catch {
    return { kind: 'unreadable' };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname)
    return { kind: 'unreadable' };
  const address = url.href;
  const bytes = utf8.encode(address).length;
  if (bytes > REVIEW_ADDRESS_LIMIT) return { kind: 'too-long', bytes };
  return {
    kind: 'ready',
    address,
    host: url.host,
    signIn: Boolean(url.username || url.password),
    international: url.hostname.split('.').some((label) => label.startsWith('xn--')),
  };
}

export type LinkReviewContextValue = Readonly<{
  /** Names the conversation the links belong to; a change closes any open review. */
  key: string;
  /** Takes focus when the link that opened a review is gone: a control that outlives messages. */
  fallback: () => HTMLElement | null;
}>;

/** Supplied by the layout around the transcript. */
export const LinkReviewContext = createContext<LinkReviewContextValue>({
  key: '',
  fallback: () => null,
});

type ReviewRequest = (destination: string, label: string, origin: HTMLElement) => void;
const RequestContext = createContext<ReviewRequest | null>(null);

type Pending = Readonly<{
  review: AddressReview;
  destination: string;
  label: string;
  origin: HTMLElement;
  key: string;
  fallback: () => HTMLElement | null;
}>;

/**
 * Owns the review for the links rendered inside it, and the dialog that shows
 * it. A review lives no longer than its scope: when the message holding the
 * link goes away, so does the review.
 */
export function LinkReviewScope({ children }: Readonly<{ children: ReactNode }>) {
  const context = useContext(LinkReviewContext);
  const [pending, setPending] = useState<Pending | null>(null);
  const request = useCallback<ReviewRequest>(
    (destination, label, origin) =>
      // An open review keeps its address: nothing replaces it under the reader.
      setPending(
        (current) =>
          current ?? {
            review: reviewAddress(destination),
            destination,
            label,
            origin,
            key: context.key,
            fallback: context.fallback,
          },
      ),
    [context],
  );
  // Another conversation never inherits this one's review.
  useEffect(() => {
    setPending((current) => (current && current.key !== context.key ? null : current));
  }, [context.key]);
  const current = pending?.key === context.key ? pending : null;
  return (
    <RequestContext.Provider value={request}>
      {children}
      {current ? <LinkReviewDialog pending={current} onDone={() => setPending(null)} /> : null}
    </RequestContext.Provider>
  );
}

type CopyOutcome = 'idle' | 'copied' | 'failed';

function LinkReviewDialog({ pending, onDone }: Readonly<{ pending: Pending; onDone: () => void }>) {
  const { review, origin, fallback } = pending;
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const opened = useRef(false);
  const [requested, setRequested] = useState(false);
  const [copy, setCopy] = useState<CopyOutcome>('idle');
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // Strict mode runs this twice; the second run opens the review again.
    finished.current = false;
    openModal(node);
    first.current?.focus();
    return () => {
      if (finished.current) return;
      // The link's message or conversation went away while the review was open.
      finished.current = true;
      const active = document.activeElement;
      const lost = !active || active === document.body || node.contains(active);
      closeModal(node);
      if (lost) fallback()?.focus();
    };
  }, [fallback]);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    // Close first: nothing behind an open modal can take focus.
    if (dialog.current) closeModal(dialog.current);
    (origin.isConnected ? origin : fallback())?.focus();
    onDone();
  };

  const open = (event: SyntheticEvent<HTMLAnchorElement>) => {
    if (opened.current) {
      event.preventDefault();
      return;
    }
    opened.current = true;
    setRequested(true);
  };

  const label = pending.label.trim();
  const showLabel =
    review.kind === 'ready' && label && label !== pending.destination && label !== review.address;

  return (
    <dialog
      ref={dialog}
      className="coven-link-review"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        finish();
      }}
      onClose={finish}
      onClick={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Only the topmost flow closes: a dialog behind this one stays open.
          event.preventDefault();
          event.stopPropagation();
          finish();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'),
        );
        const head = controls[0];
        const tail = controls.at(-1);
        if (!head || !tail) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === head) {
          event.preventDefault();
          tail.focus();
        } else if (!event.shiftKey && document.activeElement === tail) {
          event.preventDefault();
          head.focus();
        }
      }}
    >
      <div className="coven-link-review-frame">
        {review.kind === 'ready' ? (
          <>
            <h2 id={titleId}>Open this link?</h2>
            <p id={descriptionId} className="coven-link-review-lede">
              Check where it goes first.
            </p>
            <dl className="coven-link-review-facts">
              <dt>Site</dt>
              <dd className="coven-link-review-host">{review.host}</dd>
              <dt>Full address</dt>
              <dd>
                <code className="coven-link-review-address">{review.address}</code>
              </dd>
              {showLabel ? (
                <>
                  <dt>Link text</dt>
                  <dd className="coven-link-review-label">{label}</dd>
                </>
              ) : null}
            </dl>
            {review.signIn ? (
              <p className="coven-link-review-note">
                {`The text before “@” is a sign-in name, not the site. This link goes to ${review.host}.`}
              </p>
            ) : null}
            {review.international ? (
              <p className="coven-link-review-note">
                The site's name has international characters, shown here in their encoded form.
              </p>
            ) : null}
            <output className="coven-link-review-status">
              {requested ? (
                <span>
                  Chat asked to open this address but can't confirm that a page opened. If none did,
                  use Copy address.
                </span>
              ) : null}
              {copy === 'copied' ? <span>Copied the address.</span> : null}
              {copy === 'failed' ? (
                <span className="coven-link-review-failed">
                  Couldn't copy the address. Try again, or select it above and copy it.
                </span>
              ) : null}
            </output>
            <div className="coven-link-review-actions">
              <button
                ref={first}
                type="button"
                className="fr-btn fr-btn--secondary"
                onClick={finish}
              >
                {requested ? 'Close' : 'Cancel'}
              </button>
              <button
                type="button"
                className="fr-btn fr-btn--secondary"
                onClick={() => {
                  setCopy('idle');
                  void copyText(review.address).then((ok) => {
                    if (!finished.current) setCopy(ok ? 'copied' : 'failed');
                  });
                }}
              >
                Copy address
              </button>
              {/* The same hand-off a Markdown link made before review: an anchor the
                  webview opens outside the window. Nothing else can open it. */}
              <a
                className="fr-btn fr-btn--primary coven-link-review-open"
                href={review.address}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                aria-disabled={requested || undefined}
                onClick={open}
                onAuxClick={(event) => {
                  if (event.button === 1) open(event);
                }}
              >
                Open
              </a>
            </div>
          </>
        ) : (
          <>
            <h2 id={titleId}>
              {review.kind === 'too-long'
                ? 'This link is too long to review'
                : "Chat can't read this link"}
            </h2>
            <p id={descriptionId}>
              {review.kind === 'too-long'
                ? `Its address is ${review.bytes.toLocaleString('en-US')} bytes. Chat reviews addresses up to ${REVIEW_ADDRESS_LIMIT.toLocaleString('en-US')} bytes, so it won't open or copy this one.`
                : "Its address isn't a complete web address, so Chat won't open or copy it."}{' '}
              Copy on the reply copies its full text, link included.
            </p>
            <div className="coven-link-review-actions">
              <button
                ref={first}
                type="button"
                className="fr-btn fr-btn--secondary"
                onClick={finish}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

/** Whether the reader has text selected that reaches into `node`. */
function selectionTouches(node: Node): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  // `containsNode` is false for a selection that lies wholly inside the node.
  for (let index = 0; index < selection.rangeCount; index += 1)
    if (selection.getRangeAt(index).intersectsNode(node)) return true;
  return false;
}

/**
 * An external link in a message. It carries no address of its own, so the
 * webview has no way to open it directly (no context-menu open, drag, or middle
 * click); every activation Chat handles goes through the review instead.
 */
export function ReviewLink({
  destination,
  children,
}: Readonly<{ destination: string; children: ReactNode }>) {
  const request = useContext(RequestContext);
  if (!request) return <span>{children}</span>;
  const activate = (event: SyntheticEvent<HTMLElement>) => {
    event.preventDefault();
    request(destination, event.currentTarget.textContent ?? '', event.currentTarget);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <a href> would let the webview open the address without review.
    <span
      className="coven-link"
      role="link"
      tabIndex={0}
      aria-haspopup="dialog"
      onClick={(event) => {
        // Releasing a text selection over the link selects; it does not open.
        if (event.detail > 0 && selectionTouches(event.currentTarget)) return;
        activate(event);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) activate(event);
      }}
      onMouseDown={(event) => {
        // A middle press would otherwise start autoscroll on some platforms.
        if (event.button === 1) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) activate(event);
      }}
    >
      {children}
    </span>
  );
}
