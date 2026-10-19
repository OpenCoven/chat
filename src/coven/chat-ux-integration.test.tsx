import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatLayout, type ChatLayoutProps } from './chat-layout';
import type { ChatMessage } from './events';

/**
 * The #480 slice together (#481 link review, #482 quote selection, #483
 * tables, #484 inspector resizing): each feature has its own suite; these
 * cases cover only what happens where they meet. See chat#485.
 */

const table = [
  '| Field | Link |',
  '| :-- | --: |',
  '| alpha | [Guide](https://docs.example.test/guide) |',
  '| beta | plain |',
].join('\n');
const reply: ChatMessage = {
  id: '2',
  role: 'assistant',
  text: `See [docs](https://docs.example.test/start) first.\n\n${table}\n\nDone.`,
};
const question: ChatMessage = { id: '1', role: 'user', text: 'Where do I start?' };

function props(): ChatLayoutProps {
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

/** The host's side of a draft edit, applied to the draft as it stands now. */
function Harness(initial: ChatLayoutProps) {
  const [draft, setDraft] = useState(initial.draft);
  const latest = useRef(draft);
  return (
    <ChatLayout
      {...initial}
      draft={draft}
      onDraft={(value) => {
        latest.current = value;
        setDraft(value);
      }}
      onEditDraft={(_chat, edit) => {
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

/** Selects `text` inside `root`, as a reader's drag would, and lets the page notice. */
function select(text: string, root: Node) {
  const node = textNode(root, text);
  const range = document.createRange();
  range.setStart(node, node.data.indexOf(text));
  range.setEnd(node, node.data.indexOf(text) + text.length);
  const selection = document.getSelection();
  if (!selection) throw new Error('No selection');
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

const quoteButton = () => screen.queryByRole('button', { name: 'Quote selection' });
const review = () => screen.queryByRole('dialog', { name: 'Open this link?' });
const sheet = () => screen.queryByRole('dialog', { name: 'Expanded table' });
const log = () => screen.getByRole('log', { name: 'Messages' });
const field = () => screen.getByRole('textbox', { name: 'Message Astra' }) as HTMLTextAreaElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  localStorage.clear();
});

describe('quote selection beside the link review and the table controls', () => {
  it('quotes a table cell and a link text from the reply, but never the table controls', () => {
    render(<Harness {...props()} />);
    select('alpha', log());
    expect(quoteButton()).toBeInTheDocument();
    fireEvent.click(quoteButton() as HTMLElement);
    expect(field().value).toBe('> alpha\n\n');
    expect(quoteButton()).toBeNull();

    // The link's own text is message text, even though a click on it reviews rather than opens.
    select('docs', log());
    expect(quoteButton()).toBeInTheDocument();
    expect(review()).toBeNull();

    // The Expand and Copy controls above the table are chrome, not a passage.
    select('Expand', log());
    expect(quoteButton()).toBeNull();
  });

  it('offers no quote from inside the link review or the expanded sheet, and keeps the draft as it was', () => {
    render(<Harness {...props()} draft="Draft so far" />);
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    const dialog = review();
    expect(dialog).toBeInTheDocument();
    select('docs.example.test', dialog as HTMLElement);
    expect(quoteButton()).toBeNull();
    fireEvent.keyDown(dialog as HTMLElement, { key: 'Escape' });
    expect(review()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    const expanded = sheet();
    expect(expanded).toBeInTheDocument();
    select('beta', expanded as HTMLElement);
    expect(quoteButton()).toBeNull();
    fireEvent.keyDown(expanded as HTMLElement, { key: 'Escape' });
    expect(sheet()).toBeNull();
    expect(field().value).toBe('Draft so far');
  });

  it('refuses a passage captured before a link review opened once the review has changed nothing', () => {
    render(<Harness {...props()} />);
    select('alpha', log());
    expect(quoteButton()).toBeInTheDocument();
    // A review opening and closing leaves the captured passage usable: nothing about it changed.
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    fireEvent.keyDown(review() as HTMLElement, { key: 'Escape' });
    expect(review()).toBeNull();
    // The selection is gone with the review's focus moves; the capture stands until used or dismissed.
    fireEvent.click(quoteButton() as HTMLElement);
    expect(field().value).toBe('> alpha\n\n');
  });
});

describe('the link review stacked over the expanded sheet', () => {
  it('closes only the topmost flow on Escape and walks focus back link, then Expand', () => {
    render(<Harness {...props()} />);
    const expand = screen.getByRole('button', { name: 'Expand table' });
    fireEvent.click(expand);
    const expanded = sheet() as HTMLElement;
    const link = within(expanded).getByRole('link', { name: 'Guide' });
    fireEvent.click(link);
    const dialog = review() as HTMLElement;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('docs.example.test')).toBeInTheDocument();
    // Both are open: the review is a descendant of the sheet, so it stacks above it.
    expect(expanded.contains(dialog)).toBe(true);
    // A browser's Escape on the topmost modal fires `cancel` on it; React carries that event up to
    // the sheet's onCancel too, so the sheet must tell its own cancel from its child's.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(review()).toBeNull();
    expect(sheet()).toBe(expanded);
    expect(link).toHaveFocus();
    fireEvent.click(link);
    fireEvent.keyDown(review() as HTMLElement, { key: 'Escape' });
    expect(review()).toBeNull();
    expect(sheet()).toBe(expanded);
    expect(link).toHaveFocus();
    fireEvent.keyDown(expanded, { key: 'Escape' });
    expect(sheet()).toBeNull();
    expect(expand).toHaveFocus();
  });

  it('closes both when the conversation changes, clears a waiting quote, and focus lands in the new conversation', () => {
    const initial = props();
    const { rerender } = render(<ChatLayout {...initial} />);
    select('alpha', log());
    expect(quoteButton()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    fireEvent.click(within(sheet() as HTMLElement).getByRole('link', { name: 'Guide' }));
    expect(review()).toBeInTheDocument();
    rerender(
      <ChatLayout
        {...initial}
        familiarId="nova"
        sessionId="s-nova"
        messages={[{ id: '2', role: 'assistant', text: `Other chat.\n\n${table}` }]}
      />,
    );
    expect(review()).toBeNull();
    expect(sheet()).toBeNull();
    expect(quoteButton()).toBeNull();
    expect(log()).toHaveFocus();
    // The other chat's own table can be expanded afresh: the one-at-a-time rule released.
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    expect(sheet()).toBeInTheDocument();
  });
});

describe('the inspector handle beside the dialogs', () => {
  function inspectorWidth(container: HTMLElement) {
    return container
      .querySelector<HTMLElement>('.coven-chat')
      ?.style.getPropertyValue('--coven-inspector-w');
  }

  it('ignores keys while a sheet or review is open, resizes again after, and stores only the number', () => {
    const { container } = render(<Harness {...props()} />);
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(inspectorWidth(container)).toBe('360px');
    fireEvent.click(within(sheet() as HTMLElement).getByRole('link', { name: 'Guide' }));
    fireEvent.keyDown(handle, { key: 'End' });
    expect(inspectorWidth(container)).toBe('360px');
    fireEvent.keyDown(review() as HTMLElement, { key: 'Escape' });
    fireEvent.keyDown(sheet() as HTMLElement, { key: 'Escape' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(inspectorWidth(container)).toBe('376px');

    // After the whole journey, storage holds the display preference and nothing from the chat.
    select('alpha', log());
    fireEvent.click(quoteButton() as HTMLElement);
    expect(field().value).toBe('> alpha\n\n');
    expect(Object.keys(localStorage)).toEqual(['opencoven.chat.preferences.v1']);
    const stored = localStorage.getItem('opencoven.chat.preferences.v1') ?? '';
    expect(JSON.parse(stored)).toEqual({
      textSize: 'default',
      groupTools: true,
      inspectorWidth: 376,
    });
    for (const word of ['alpha', 'docs.example.test', 'Guide', 'Draft', 'Where do I start'])
      expect(stored).not.toContain(word);
    expect(sessionStorage.length).toBe(0);
  });
});
