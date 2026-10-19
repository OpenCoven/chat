import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchNavigation } from '../test/watch-navigation';
import {
  LinkReviewContext,
  LinkReviewScope,
  REVIEW_ADDRESS_LIMIT,
  ReviewLink,
  reviewAddress,
} from './external-link-review';
import { FormattedMessage } from './formatted-message';

const REVIEW = { name: 'Open this link?' } as const;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let navigation: ReturnType<typeof watchNavigation>;

beforeEach(() => {
  navigation = watchNavigation();
});

afterEach(() => {
  navigation.stop();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  vi.restoreAllMocks();
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  // The legacy path refuses too, so a rejected write is a real failure.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
}

function review() {
  return screen.getByRole('dialog', REVIEW);
}

function openControl() {
  return within(review()).getByRole('link', { name: 'Open' });
}

/** A transcript stand-in: a focusable conversation log around one message, bound to a chat. */
function Conversation({ chat, children }: { chat: string; children: ReactNode }) {
  const log = useRef<HTMLDivElement>(null);
  return (
    <LinkReviewContext.Provider value={{ key: chat, fallback: () => log.current }}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: mirrors the scrollable transcript. */}
      <div ref={log} role="log" aria-label="Messages" tabIndex={0}>
        {children}
      </div>
    </LinkReviewContext.Provider>
  );
}

describe('reviewAddress', () => {
  it('names the site apart from ports, sign-in text and international names', () => {
    expect(reviewAddress('https://example.com:8443/a/b?c=d#e')).toEqual({
      kind: 'ready',
      address: 'https://example.com:8443/a/b?c=d#e',
      host: 'example.com:8443',
      signIn: false,
      international: false,
    });
    expect(reviewAddress('https://bank.example@evil.example/login')).toMatchObject({
      host: 'evil.example',
      signIn: true,
    });
    expect(reviewAddress('https://user:secret@evil.example/')).toMatchObject({
      host: 'evil.example',
      signIn: true,
    });
    // Markdown hands the renderer percent-encoded hosts; both forms reach the same site.
    for (const written of ['https://exämple.com/', 'https://ex%C3%A4mple.com/'])
      expect(reviewAddress(written)).toMatchObject({
        host: 'xn--exmple-cua.com',
        address: 'https://xn--exmple-cua.com/',
        international: true,
      });
    expect(reviewAddress('http://[::1]:8080/x')).toMatchObject({ host: '[::1]:8080' });
  });

  it('refuses anything that is not a complete web address', () => {
    for (const destination of [
      'https://',
      'http://[',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://example.com/',
      '/settings',
      '//evil.example/x',
    ])
      expect(reviewAddress(destination)).toEqual({ kind: 'unreadable' });
  });

  it('reviews addresses up to the byte limit whole and refuses one byte more', () => {
    const base = 'https://example.com/';
    const atLimit = `${base}${'a'.repeat(REVIEW_ADDRESS_LIMIT - base.length)}`;
    expect(REVIEW_ADDRESS_LIMIT).toBe(8192);
    expect(reviewAddress(atLimit)).toMatchObject({ kind: 'ready', address: atLimit });
    expect(reviewAddress(`${atLimit}a`)).toEqual({ kind: 'too-long', bytes: 8193 });
  });

  it('counts the bytes of multibyte input, not its characters', () => {
    const base = 'https://example.com/';
    // "é" is two UTF-8 bytes and travels as "%C3%A9": six bytes in the address.
    const atLimit = `${base}${'é'.repeat(1362)}`;
    expect(atLimit.length).toBeLessThan(REVIEW_ADDRESS_LIMIT);
    expect(reviewAddress(atLimit)).toMatchObject({ kind: 'ready' });
    expect(reviewAddress(`${atLimit}é`)).toEqual({ kind: 'too-long', bytes: 8198 });
    // A four-byte character is two UTF-16 units and twelve bytes once encoded.
    const emoji = `${base}${'😀'.repeat(681)}`;
    expect(emoji.length).toBe(base.length + 681 * 2);
    expect(reviewAddress(emoji)).toMatchObject({ kind: 'ready' });
    expect(reviewAddress(`${emoji}😀`)).toEqual({ kind: 'too-long', bytes: 8204 });
  });
});

describe('reviewing a link', () => {
  it('shows the site apart from the link text and binds Open and Copy to that exact address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(
      <FormattedMessage
        text={
          'Sign in at [https://bank.example/login](https://evil.example/login?next=%2Fhome#top).'
        }
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'https://bank.example/login' }));
    const dialog = review();
    const address = 'https://evil.example/login?next=%2Fhome#top';
    expect(within(dialog).getByText('evil.example')).toHaveClass('coven-link-review-host');
    expect(within(dialog).getByText(address)).toHaveClass('coven-link-review-address');
    expect(within(dialog).getByText('https://bank.example/login')).toHaveClass(
      'coven-link-review-label',
    );
    expect(openControl()).toHaveAttribute('href', address);
    expect(openControl()).toHaveAttribute('target', '_blank');
    expect(openControl()).toHaveAttribute('rel', 'noopener noreferrer');
    expect(openControl()).toHaveAttribute('referrerpolicy', 'no-referrer');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy address' }));
    });
    expect(writeText).toHaveBeenCalledWith(address);
    fireEvent.click(openControl());
    expect(navigation.opened).toEqual([address]);
  });

  it('says plainly that text before an "@" is not the site', () => {
    render(<FormattedMessage text="[account](https://bank.example@evil.example/)" />);
    fireEvent.click(screen.getByRole('link', { name: 'account' }));
    expect(review()).toHaveTextContent(
      'The text before “@” is a sign-in name, not the site. This link goes to evil.example.',
    );
    expect(within(review()).getByText('evil.example')).toHaveClass('coven-link-review-host');
  });

  it.each([
    ['a plain click', {}],
    ['a Command click', { metaKey: true }],
    ['a Control click', { ctrlKey: true }],
    ['a Shift click', { shiftKey: true }],
    ['an Option click', { altKey: true }],
  ])('opens nothing from %s, only the review', (_label, modifiers) => {
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(fireEvent.click(link, modifiers)).toBe(false);
    expect(review()).toBeInTheDocument();
    expect(navigation.opened).toEqual([]);
  });

  it('routes a middle click through the review and leaves the context menu alone', () => {
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    // The context menu stays the webview's own; with no address it offers text actions only.
    expect(fireEvent.contextMenu(link)).toBe(true);
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(fireEvent.mouseDown(link, { button: 1 })).toBe(false);
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(review()).toBeInTheDocument();
    expect(navigation.opened).toEqual([]);
  });

  it('opens from the keyboard with Enter, focuses Cancel, and keeps Tab inside', () => {
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('tabindex', '0');
    link.focus();
    fireEvent.keyDown(link, { key: ' ' });
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    fireEvent.keyDown(link, { key: 'Enter' });
    const dialog = review();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    const order = Array.from(dialog.querySelectorAll('button, a[href]')).map(
      (control) => control.textContent,
    );
    expect(order).toEqual(['Cancel', 'Copy address', 'Open']);
    openControl().focus();
    fireEvent.keyDown(openControl(), { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(openControl()).toHaveFocus();
    expect(navigation.opened).toEqual([]);
  });

  it('returns focus to the link after Cancel, Escape or a click outside', () => {
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    fireEvent.click(link);
    fireEvent.click(within(review()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(link).toHaveFocus();
    fireEvent.click(link);
    fireEvent.keyDown(within(review()).getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(link).toHaveFocus();
    fireEvent.click(link);
    fireEvent.click(review());
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(link).toHaveFocus();
    expect(navigation.opened).toEqual([]);
  });

  it('hands the address on once however often Open is pressed, and never claims a page opened', () => {
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    fireEvent.click(openControl());
    fireEvent.click(openControl());
    fireEvent(
      openControl(),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );
    fireEvent.keyDown(openControl(), { key: 'Enter' });
    expect(navigation.opened).toEqual(['https://example.com/docs']);
    expect(openControl()).toHaveAttribute('aria-disabled', 'true');
    const dialog = review();
    expect(dialog).toHaveTextContent("can't confirm that a page opened");
    expect(dialog).toHaveTextContent('use Copy address');
    expect(dialog).not.toHaveTextContent(/\bopened the\b|loaded/i);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy address' })).toBeEnabled();
  });

  it('reports a copy only once the clipboard accepts it, and a refusal until a retry works', async () => {
    let accept: () => void = () => undefined;
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            accept = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined);
    stubClipboard(writeText);
    render(<FormattedMessage text="[docs](https://example.com/docs)" />);
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    const copy = within(review()).getByRole('button', { name: 'Copy address' });
    fireEvent.click(copy);
    await act(async () => {});
    expect(review()).not.toHaveTextContent('Copied the address.');
    await act(async () => accept());
    expect(review()).toHaveTextContent('Copied the address.');
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(review()).not.toHaveTextContent('Copied the address.');
    expect(review()).toHaveTextContent(
      "Couldn't copy the address. Try again, or select it above and copy it.",
    );
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(review()).toHaveTextContent('Copied the address.');
    expect(review()).not.toHaveTextContent("Couldn't copy");
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(navigation.opened).toEqual([]);
  });

  it('keeps the reviewed address while the message changes or another link is pressed', () => {
    const view = render(<FormattedMessage text="Start [first](https://one.example/a) and" />);
    fireEvent.click(screen.getByRole('link', { name: 'first' }));
    view.rerender(
      <FormattedMessage
        text={
          'Start [first](https://two.example/b) and [second](https://three.example/c) streamed in'
        }
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'second' }));
    expect(screen.getAllByRole('dialog', REVIEW)).toHaveLength(1);
    expect(within(review()).getByText('one.example')).toBeInTheDocument();
    expect(openControl()).toHaveAttribute('href', 'https://one.example/a');
    fireEvent.click(openControl());
    expect(navigation.opened).toEqual(['https://one.example/a']);
  });

  it('refuses an address over the limit whole, without showing or copying a shortened one', () => {
    const address = `https://example.com/${'a'.repeat(REVIEW_ADDRESS_LIMIT - 19)}`;
    render(<FormattedMessage text={`[huge](${address})`} />);
    const link = screen.getByRole('link', { name: 'huge' });
    fireEvent.click(link);
    const dialog = screen.getByRole('dialog', { name: 'This link is too long to review' });
    expect(dialog).toHaveTextContent('Its address is 8,193 bytes.');
    expect(dialog).toHaveTextContent('up to 8,192 bytes');
    expect(dialog).not.toHaveTextContent('example.com');
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Copy address' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(link).toHaveFocus();
    expect(navigation.opened).toEqual([]);
  });

  it('refuses an address that is not a complete web address', () => {
    render(<FormattedMessage text="[broken](https://)" />);
    fireEvent.click(screen.getByRole('link', { name: 'broken' }));
    const dialog = screen.getByRole('dialog', { name: "Chat can't read this link" });
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(navigation.opened).toEqual([]);
  });

  it('leaves in-page links as they were', () => {
    const { container } = render(<FormattedMessage text="Back to [the top](#top)." />);
    const link = screen.getByRole('link', { name: 'the top' });
    expect(link).toHaveAttribute('href', '#top');
    expect(container.querySelector('a[target]')).toBeNull();
    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never makes unsafe, relative or raw-HTML destinations navigable', () => {
    const { container } = render(
      <FormattedMessage
        text={[
          '[script](javascript:alert%281%29)',
          '[data](data:text/html,hi)',
          '[file](file:///etc/passwd)',
          '[vb](vbscript:msgbox)',
          '[mail](mailto:someone@example.com)',
          '[ftp](ftp://example.com/x)',
          '[relative](/settings)',
          '[protocol](//evil.example/x)',
          '<a href="https://evil.example">raw</a>',
          '<someone@example.com>',
        ].join('\n\n')}
      />,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelector('a, [role="link"]')).toBeNull();
    fireEvent.click(screen.getByText('script'));
    fireEvent.click(screen.getByText('raw'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigation.opened).toEqual([]);
  });

  it('fetches nothing and stores nothing while a link is reviewed, copied and opened', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const icons = document.head.querySelectorAll('link').length;
    render(
      <FormattedMessage
        text={'![pixel](https://example.com/p.png) [docs](https://example.com/d)'}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    await act(async () => {
      fireEvent.click(within(review()).getByRole('button', { name: 'Copy address' }));
    });
    fireEvent.click(openControl());
    expect(document.querySelector('img')).toBeNull();
    expect(document.head.querySelectorAll('link')).toHaveLength(icons);
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('ends a text selection over the link without opening a review', () => {
    render(<FormattedMessage text="Select [these words](https://example.com/w) please" />);
    const link = screen.getByRole('link', { name: 'these words' });
    const selection = window.getSelection();
    selection?.selectAllChildren(link);
    fireEvent.click(link, { detail: 1 });
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    selection?.removeAllRanges();
    fireEvent.click(link, { detail: 1 });
    expect(review()).toBeInTheDocument();
  });
});

describe('review lifetime', () => {
  it('closes when the conversation changes and returns focus to it', () => {
    const message = <FormattedMessage text="[docs](https://example.com/docs)" />;
    const view = render(<Conversation chat="a:1">{message}</Conversation>);
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    expect(review()).toBeInTheDocument();
    // The same message component now shows another chat: ids repeat across chats.
    view.rerender(<Conversation chat="b:2">{message}</Conversation>);
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveFocus();
    view.rerender(<Conversation chat="a:1">{message}</Conversation>);
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(navigation.opened).toEqual([]);
  });

  it('closes when its message is removed and returns focus to the conversation', () => {
    const view = render(
      <Conversation chat="a:1">
        <FormattedMessage text="[docs](https://example.com/docs)" />
      </Conversation>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    within(review()).getByRole('button', { name: 'Cancel' }).focus();
    view.rerender(<Conversation chat="a:1">{null}</Conversation>);
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveFocus();
  });

  it('returns focus to the conversation when the link itself was redrawn', () => {
    const view = render(
      <Conversation chat="a:1">
        <FormattedMessage text="See [docs](https://example.com/docs)" />
      </Conversation>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    view.rerender(
      <Conversation chat="a:1">
        <FormattedMessage text={'- See [docs](https://example.com/docs)\n- and more'} />
      </Conversation>,
    );
    expect(openControl()).toHaveAttribute('href', 'https://example.com/docs');
    fireEvent.click(within(review()).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveFocus();
  });
});

describe('inside another dialog', () => {
  function Table() {
    const [open, setOpen] = useState(true);
    if (!open) return <p>Table closed</p>;
    return (
      <dialog
        open
        aria-label="Expanded table"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <LinkReviewScope>
          <ReviewLink destination="https://table.example/row">Row link</ReviewLink>
        </LinkReviewScope>
        <button type="button">Copy table</button>
      </dialog>
    );
  }

  it('closes only the topmost flow on Escape and returns focus into the dialog beneath', () => {
    render(<Table />);
    const link = screen.getByRole('link', { name: 'Row link' });
    fireEvent.click(link);
    expect(review()).toHaveAttribute('open');
    fireEvent.keyDown(within(review()).getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', REVIEW)).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Expanded table' })).toBeInTheDocument();
    expect(link).toHaveFocus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.getByText('Table closed')).toBeInTheDocument();
    expect(navigation.opened).toEqual([]);
  });

  it('opens only the address reviewed from inside the dialog', () => {
    render(<Table />);
    fireEvent.click(screen.getByRole('link', { name: 'Row link' }));
    fireEvent.click(openControl());
    expect(navigation.opened).toEqual(['https://table.example/row']);
    expect(screen.getByRole('dialog', { name: 'Expanded table' })).toBeInTheDocument();
  });

  it('renders inert text when no review scope is present', () => {
    render(<ReviewLink destination="https://example.com/">orphan</ReviewLink>);
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByText('orphan'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigation.opened).toEqual([]);
  });
});
