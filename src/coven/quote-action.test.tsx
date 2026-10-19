import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatLayout, type ChatLayoutProps, PROMPT_LIMIT_BYTES } from './chat-layout';
import type { ChatMessage } from './events';

// Counts how often each reply is drawn. The wrapper renders the real component,
// so everything else on the page is what the reader would see.
const drawn = vi.hoisted(() => new Map<string, number>());
vi.mock('./formatted-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./formatted-message')>();
  return {
    ...actual,
    FormattedMessage: (props: { text: string }) => {
      drawn.set(props.text, (drawn.get(props.text) ?? 0) + 1);
      return <actual.FormattedMessage {...props} />;
    },
  };
});

const question: ChatMessage = { id: '1', role: 'user', text: 'What is the plan?' };
const reply: ChatMessage = {
  id: '2',
  role: 'assistant',
  text: 'The plan has three steps.\n\nFirst, read the source.',
};

function quoteProps(): ChatLayoutProps {
  return {
    familiars: [
      { id: 'astra', name: 'Astra' },
      { id: 'nova', name: 'Nova' },
    ],
    sessions: [],
    messages: [question, reply],
    familiarId: 'astra',
    sessionId: 's-astra',
    draft: '',
    status: '',
    ready: true,
    connected: true,
    busy: false,
    loading: false,
    cancelling: false,
    error: '',
    onFamiliar: vi.fn(),
    onDraft: vi.fn(),
    onEditDraft: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onRefresh: vi.fn(),
  };
}

/** The host's side of a draft edit: applied to the draft as it stands now. */
function Harness(props: ChatLayoutProps) {
  const [draft, setDraft] = useState(props.draft);
  const latest = useRef(draft);
  return (
    <ChatLayout
      {...props}
      draft={draft}
      onDraft={(value) => {
        latest.current = value;
        setDraft(value);
        props.onDraft(value);
      }}
      onEditDraft={(chat, edit) => {
        props.onEditDraft?.(chat, edit);
        const next = edit(latest.current);
        if (next === null) return false;
        latest.current = next;
        setDraft(next);
        return true;
      }}
    />
  );
}

function textNode(root: Node, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes(text)) return node;
  }
  throw new Error(`No text node contains "${text}"`);
}

function selectRange(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection();
  if (!selection) throw new Error('No selection');
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** Selects from the start of `from` to the end of `to`, as a reader's drag would. */
function selectText(from: string, to = from, root: Node = screen.getByRole('log')) {
  const start = textNode(root, from);
  const end = textNode(root, to);
  selectRange(start, start.data.indexOf(from), end, end.data.indexOf(to) + to.length);
}

function clearSelection() {
  document.getSelection()?.removeAllRanges();
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

const field = () => screen.getByRole('textbox', { name: 'Message Astra' }) as HTMLTextAreaElement;
const quoteButton = () => screen.queryByRole('button', { name: 'Quote selection' });

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  drawn.clear();
  vi.restoreAllMocks();
});

describe('quoting a selected passage', () => {
  it('quotes exactly the selected passage into the draft once, and never sends', () => {
    const props = quoteProps();
    render(<Harness {...props} />);
    selectText('three steps');
    const quote = quoteButton();
    expect(quote).toBeInTheDocument();
    if (quote) fireEvent.click(quote);
    expect(field()).toHaveValue('> three steps\n\n');
    expect(props.onEditDraft).toHaveBeenCalledTimes(1);
    expect(props.onEditDraft).toHaveBeenCalledWith(
      { familiarId: 'astra', sessionId: 's-astra' },
      expect.any(Function),
    );
    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    // The reader carries on typing after the quote.
    expect(field()).toHaveFocus();
    expect(field().selectionStart).toBe('> three steps\n\n'.length);
    expect(field().selectionEnd).toBe('> three steps\n\n'.length);
    expect(quoteButton()).not.toBeInTheDocument();
  });

  it('keeps the draft and its files, and quotes multiline and Unicode text as written', () => {
    const props = quoteProps();
    const note: ChatMessage = { id: '3', role: 'user', text: 'line one\nlíne twö 🌙\nline three' };
    render(
      <Harness
        {...props}
        messages={[question, reply, note]}
        draft="Thanks!"
        attachments={[{ id: 'a1', name: 'notes.txt', bytes: [104, 105] }]}
        onRemoveAttachment={vi.fn()}
      />,
    );
    selectText('line one', 'twö 🌙');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field()).toHaveValue('Thanks!\n\n> line one\n> líne twö 🌙\n\n');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it("quotes from the reader's own message and from inside a code block", () => {
    const props = quoteProps();
    const code: ChatMessage = {
      id: '3',
      role: 'assistant',
      text: 'Run this:\n\n```ts\nconst answer = 42;\n```',
    };
    render(<Harness {...props} messages={[question, reply, code]} />);
    selectText('What is the plan');
    expect(screen.getByText(/from your message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    selectText('const answer = 42;');
    expect(screen.getByText(/from Astra's reply/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field()).toHaveValue('> What is the plan\n\n> const answer = 42;\n\n');
  });

  it('accepts a whole-paragraph selection that ends where the next message starts', () => {
    const props = quoteProps();
    render(
      <Harness
        {...props}
        messages={[question, reply, { id: '3', role: 'user', text: 'Thanks' }]}
      />,
    );
    const log = screen.getByRole('log');
    // A triple-click selects to the start of whatever follows the paragraph.
    selectRange(textNode(log, 'First, read'), 0, textNode(log, 'Thanks'), 0);
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field()).toHaveValue('> First, read the source.\n\n');
  });

  it.each([
    [
      'crosses two messages',
      (log: HTMLElement) => selectText('What is the plan', 'three steps', log),
    ],
    [
      "reaches into the familiar's name",
      (log: HTMLElement) => {
        const name = log.querySelector('[data-block-id="2"] .fr-familiar-name');
        if (!name) throw new Error('No name');
        selectRange(textNode(name, 'Astra'), 0, textNode(log, 'three steps'), 5);
      },
    ],
    [
      'takes in the Copy control',
      (log: HTMLElement) => {
        const copy = log.querySelector('[data-block-id="2"] .coven-message-copy');
        if (!copy) throw new Error('No Copy');
        selectRange(textNode(copy, 'Copy'), 0, textNode(log, 'three steps'), 5);
      },
    ],
    [
      "spans a code block's language and Copy bar",
      (log: HTMLElement) => selectText('Run this', 'const answer', log),
    ],
    [
      'spans tool activity inside a reply',
      (log: HTMLElement) => selectText('Before the tool', 'After the tool', log),
    ],
    ['sits in a tool call', (log: HTMLElement) => selectText('npm test', 'npm test', log)],
    [
      'sits on an attachment card',
      (log: HTMLElement) => selectText('report.txt', 'report.txt', log),
    ],
    [
      'sits in a notice',
      (log: HTMLElement) => selectText('Earlier turns were replayed', undefined, log),
    ],
    [
      'is only blank space',
      (log: HTMLElement) => {
        const node = textNode(log, 'gap  here');
        const at = node.data.indexOf('  ');
        selectRange(node, at, node, at + 2);
      },
    ],
    [
      'is a bare caret',
      (log: HTMLElement) => {
        const node = textNode(log, 'three steps');
        selectRange(node, 3, node, 3);
      },
    ],
  ])('offers nothing for a selection that %s', (_case, select) => {
    const props = quoteProps();
    const messages: ChatMessage[] = [
      { id: '0', role: 'notice', notice: 'replay', text: 'Earlier turns were replayed.' },
      question,
      reply,
      { id: '3', role: 'assistant', text: 'Run this:\n\n```ts\nconst answer = 42;\n```' },
      { id: '4', role: 'assistant', text: 'Before the tool.\n\n⚒ Bash(ls)\n\nAfter the tool.' },
      { id: '5', role: 'tool', text: 'Bash', tool: { name: 'Bash', args: 'npm test' } },
      {
        id: '6',
        role: 'user',
        text: 'See the file, gap  here.',
        attachments: [{ name: 'report.txt', size: 12 }],
      },
    ];
    render(<Harness {...props} messages={messages} />);
    select(screen.getByRole('log'));
    expect(quoteButton()).not.toBeInTheDocument();
    expect(document.querySelector('.coven-quote')).toBeNull();
  });

  it('refuses a passage over 4,096 bytes without shortening it', () => {
    const props = quoteProps();
    const long: ChatMessage = { id: '3', role: 'user', text: 'x'.repeat(5000) };
    render(<Harness {...props} messages={[question, reply, long]} />);
    selectText('x'.repeat(5000));
    expect(quoteButton()).not.toBeInTheDocument();
    expect(screen.getByText(/5,004 bytes/)).toHaveTextContent(
      'That passage is 5,004 bytes as a quote, and a quote can be up to 4,096. Select less of it.',
    );
    expect(props.onEditDraft).not.toHaveBeenCalled();
  });

  it('leaves a draft that would pass the message limit as it was', () => {
    const props = quoteProps();
    const draft = 'd'.repeat(PROMPT_LIMIT_BYTES - 8);
    render(<Harness {...props} draft={draft} />);
    selectText('three steps');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field().value).toBe(draft);
    expect(
      screen.getByText(
        'Quoting it would make your message 32,777 bytes, and Coven accepts up to 32,768. Shorten the message, then select the passage again.',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['changed', [question, { ...reply, text: 'The plan has four steps.' }]],
    ['removed', [question]],
  ])('asks for a new selection when the passage has %s', (_case, messages) => {
    const props = quoteProps();
    const view = render(<Harness {...props} />);
    selectText('three steps');
    const quote = screen.getByRole('button', { name: 'Quote selection' });
    act(() => quote.focus());
    view.rerender(<Harness {...props} messages={messages} />);
    fireEvent.click(quote);
    expect(props.onEditDraft).not.toHaveBeenCalled();
    expect(field()).toHaveValue('');
    expect(
      screen.getByText(
        "That passage changed or isn't in this chat any more. Select it again to quote it.",
      ),
    ).toBeInTheDocument();
    // Focus stays in the action rather than falling to the page.
    expect(screen.getByRole('button', { name: 'Dismiss quote' })).toHaveFocus();
  });

  it('drops a selection when the familiar or chat changes, and never brings it back', () => {
    const props = quoteProps();
    const view = render(<Harness {...props} />);
    selectText('three steps');
    expect(quoteButton()).toBeInTheDocument();
    // Message ids repeat across chats: Nova's "2" is not Astra's.
    view.rerender(
      <Harness
        {...props}
        familiarId="nova"
        sessionId="s-nova"
        messages={[{ id: '2', role: 'assistant', text: 'Nova has three steps too.' }]}
      />,
    );
    expect(quoteButton()).not.toBeInTheDocument();
    view.rerender(<Harness {...props} />);
    expect(quoteButton()).not.toBeInTheDocument();
    selectText('three steps');
    view.rerender(<Harness {...props} sessionId="s-astra-next" />);
    expect(quoteButton()).not.toBeInTheDocument();
    expect(props.onEditDraft).not.toHaveBeenCalled();
  });

  it('turns a refusal from the host into a request to select again', () => {
    const props = quoteProps();
    render(<ChatLayout {...props} onEditDraft={() => false} />);
    selectText('three steps');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(
      screen.getByText(
        "That passage changed or isn't in this chat any more. Select it again to quote it.",
      ),
    ).toBeInTheDocument();
  });

  it('works from the keyboard without sending, even with Enter held', () => {
    const props = quoteProps();
    render(<Harness {...props} />);
    selectText('three steps');
    const quote = screen.getByRole('button', { name: 'Quote selection' });
    act(() => quote.focus());
    // Moving focus to the action may collapse the selection; what it captured stands.
    clearSelection();
    fireEvent.keyDown(quote, { key: 'Enter' });
    expect(field()).toHaveValue('> three steps\n\n');
    expect(field()).toHaveFocus();
    // A held Enter repeats into the field that just took focus.
    fireEvent.keyDown(field(), { key: 'Enter', repeat: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyUp(field(), { key: 'Enter' });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape or Dismiss and returns focus to the conversation', () => {
    const props = quoteProps();
    render(<Harness {...props} />);
    selectText('three steps');
    const quote = screen.getByRole('button', { name: 'Quote selection' });
    act(() => quote.focus());
    fireEvent.keyDown(quote, { key: 'Escape' });
    expect(quoteButton()).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveFocus();
    selectText('First, read');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss quote' }));
    expect(quoteButton()).not.toBeInTheDocument();
    expect(props.onEditDraft).not.toHaveBeenCalled();
  });

  it('goes when the selection does, and leaves Copy and Cmd/Ctrl+F alone', () => {
    render(<Harness {...quoteProps()} />);
    selectText('three steps');
    // Copying the selection is the reader's own; nothing intercepts it.
    expect(fireEvent.copy(textNode(screen.getByRole('log'), 'three steps'))).toBe(true);
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', metaKey: true });
    expect(document.querySelector('.coven-find')).not.toBeNull();
    expect(quoteButton()).toBeInTheDocument();
    clearSelection();
    expect(quoteButton()).not.toBeInTheDocument();
  });

  it('follows the composer: no quoting while the chat is archived or unavailable', () => {
    const props = quoteProps();
    const view = render(<Harness {...props} readOnly ready={false} />);
    selectText('three steps');
    expect(quoteButton()).not.toBeInTheDocument();
    view.rerender(<Harness {...props} loading />);
    expect(quoteButton()).not.toBeInTheDocument();
  });

  it('quotes during a run without stopping or sending it', () => {
    const props = quoteProps();
    render(<Harness {...props} busy runFamiliarId="astra" runStartedAt={Date.now()} />);
    selectText('three steps');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field()).toHaveValue('> three steps\n\n');
    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("holds the reader's place and leaves earlier messages alone while a reply streams", () => {
    const props = quoteProps();
    const view = render(<Harness {...props} />);
    const log = screen.getByRole('log');
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    log.scrollTop = 700;
    fireEvent.scroll(log);
    selectText('three steps');
    const selected = textNode(log, 'three steps');
    const before = drawn.get(reply.text);
    expect(before).toBeGreaterThan(0);
    const live = (text: string) => (
      <Harness
        {...props}
        busy
        runFamiliarId="astra"
        messages={[question, reply, { id: '3', role: 'assistant', text }]}
      />
    );
    view.rerender(live('Streaming'));
    view.rerender(live('Streaming more'));
    // Near the bottom the transcript usually follows new text; not under a selection.
    expect(log.scrollTop).toBe(700);
    expect(drawn.get(reply.text)).toBe(before);
    expect(textNode(log, 'three steps')).toBe(selected);
    expect(document.getSelection()?.toString()).toBe('three steps');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(field()).toHaveValue('> three steps\n\n');
    view.rerender(live('Streaming more text'));
    expect(log.scrollTop).toBe(1000);
  });

  it('keeps passages out of browser storage and stops listening once unmounted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const view = render(<Harness {...quoteProps()} />);
    selectText('three steps');
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    for (const [, value] of setItem.mock.calls) expect(value).not.toContain('three steps');
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith('selectionchange', expect.any(Function));
  });
});
