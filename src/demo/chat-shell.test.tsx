import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { DemoShell } from './chat-demo';
import { MOCK_CONVERSATIONS } from './mock-data';
import { MOCK_FAMILIARS } from './mock-familiars';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('chat demo shell', () => {
  it('binds every conversation to a known familiar', () => {
    const familiarIds = new Set(MOCK_FAMILIARS.map((familiar) => familiar.id));

    expect(
      MOCK_CONVERSATIONS.every((conversation) => familiarIds.has(conversation.familiarId)),
    ).toBe(true);
  });

  it('keeps Chat as the only primary surface', () => {
    render(<DemoShell />);

    expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Familiars' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toBeVisible();
  });

  it('collapses and restores both side panels independently', () => {
    render(<DemoShell />);

    fireEvent.click(screen.getByText('Conversations', { selector: '.sidebar-title-label' }));
    expect(document.getElementById('conversation-panel')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Show conversations' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide agent inspector' }));
    const thread = screen.getByRole('main');
    expect(within(thread).getByRole('button', { name: 'Show conversations' })).toBeVisible();
    expect(within(thread).getByRole('button', { name: 'Show agent inspector' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
    expect(screen.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  });

  it('resizes both side rails with accessible keyboard separators', () => {
    render(<DemoShell />);

    const conversationsHandle = screen.getByRole('separator', {
      name: 'Resize conversations sidebar',
    });
    const inspectorHandle = screen.getByRole('separator', {
      name: 'Resize agent inspector',
    });

    expect(conversationsHandle).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(conversationsHandle, { key: 'ArrowLeft' });
    expect(conversationsHandle).toHaveAttribute('aria-valuenow', '308');

    expect(inspectorHandle).toHaveAttribute('aria-valuenow', '340');
    fireEvent.keyDown(inspectorHandle, { key: 'ArrowLeft' });
    expect(inspectorHandle).toHaveAttribute('aria-valuenow', '352');
  });

  it('groups New Chat and command search in one compact action row', () => {
    render(<DemoShell />);

    const sidebar = screen.getByRole('complementary', { name: 'Conversations' });
    const toggle = within(sidebar).getByRole('button', { name: 'Hide conversations' });
    const newConversation = within(sidebar).getByRole('button', { name: 'Start a new chat' });
    const search = within(sidebar).getByRole('button', { name: 'Search conversations' });

    expect(within(sidebar).getByRole('heading', { name: 'Conversations' })).toBeVisible();
    expect(toggle.querySelector('svg')).not.toBeNull();
    expect(newConversation.parentElement).toBe(search.parentElement);
    expect(newConversation.parentElement).toHaveClass('sidebar-primary-actions');
    expect(within(sidebar).queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('opens conversation search from its button and the command shortcut', () => {
    render(<DemoShell />);

    fireEvent.click(screen.getByRole('button', { name: 'Search conversations' }));
    let dialog = screen.getByRole('dialog', { name: 'Search conversations' });
    const input = within(dialog).getByRole('searchbox', { name: 'Search conversations' });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'new' } });
    expect(within(dialog).queryByRole('button', { name: /Quick Chat/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /New Chat/ }));
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cody' })).toBeVisible();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    dialog = screen.getByRole('dialog', { name: 'Search conversations' });
    expect(dialog).toBeVisible();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(dialog).not.toBeInTheDocument();
  });

  it('groups conversations with Cave-style status structure', () => {
    render(<DemoShell />);

    const sidebar = screen.getByRole('complementary', { name: 'Conversations' });
    expect(within(sidebar).getByRole('heading', { name: /Recent/ })).toBeVisible();
    expect(
      within(sidebar).getByText('2', { selector: '.conversation-section-count' }),
    ).toBeVisible();
    expect(sidebar.querySelector('.conversation-scroll')).toHaveClass('is-sparse');
    expect(within(sidebar).getByRole('button', { name: 'Quick Chat' })).toHaveAttribute(
      'data-status',
      'available',
    );
    expect(within(sidebar).getByRole('button', { name: 'New Chat' })).toHaveAttribute(
      'data-status',
      'working',
    );
  });

  it('opens generated images in a dismissible focused preview', () => {
    render(<DemoShell />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand image: A purple cat in a glowing garden' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Expanded image: A purple cat in a glowing garden' }),
    ).toBeVisible();
    const closeButton = screen.getByRole('button', { name: 'Close image preview' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Expanded image: A purple cat in a glowing garden' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand image: A purple cat in a glowing garden' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Expanded image: A purple cat in a glowing garden',
    });
    fireEvent.click(within(dialog).getByRole('img'));
    expect(dialog).toBeVisible();

    const backdrop = dialog.querySelector('.image-lightbox-backdrop');
    if (!(backdrop instanceof HTMLElement)) {
      throw new Error('Image lightbox backdrop was not rendered');
    }
    fireEvent.click(backdrop);
    expect(dialog).not.toBeInTheDocument();
  });

  it('shows concise demo reasoning for an agent response', () => {
    render(<DemoShell />);

    const reasoningLabel = screen.getByText('Reasoning', { selector: '.reasoning-label' });
    const reasoning = reasoningLabel.closest('details');
    expect(reasoning).toBeVisible();
    expect(reasoning).toHaveAttribute('open');
    expect(reasoning).toHaveTextContent('Identified “cat” as the subject');
    expect(reasoning).toHaveTextContent('Demo');
    expect(reasoning).toHaveTextContent('Interpret prompt');
    expect(reasoning).toHaveTextContent('Compose image');
    expect(reasoning).toHaveTextContent('Keep it local');
    expect(reasoning?.querySelectorAll('.reasoning-step-icon .mm-icon')).toHaveLength(3);

    const summary = reasoningLabel.closest('summary');
    if (!(summary instanceof HTMLElement)) {
      throw new Error('Reasoning summary was not rendered');
    }
    fireEvent.click(summary);
    expect(reasoning).not.toHaveAttribute('open');
  });

  it('updates the inspector when the active conversation changes agent', () => {
    render(<DemoShell />);

    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    expect(screen.getByRole('heading', { name: 'Cody' })).toBeVisible();
  });

  it('switches the active familiar from the left rail', () => {
    render(<DemoShell />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar familiar: Astra' }));
    expect(screen.getByRole('menu', { name: 'Sidebar familiar: Astra' })).toHaveAttribute(
      'data-open',
    );
    expect(screen.getByRole('group', { name: 'Familiars' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Cody/ }));

    expect(screen.getByRole('heading', { name: 'Cody' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sidebar familiar: Cody' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('does not reserve a top row for the active familiar', () => {
    render(<DemoShell />);

    expect(document.querySelector('.thread-header')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Active familiar: Astra' }),
    ).not.toBeInTheDocument();
  });

  it('keeps one narrow overlay open at a time and closes it with Escape', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });

    try {
      render(<DemoShell />);

      expect(document.getElementById('conversation-panel')).toBeVisible();
      expect(document.getElementById('agent-inspector')).not.toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: 'Show agent inspector' }));
      expect(document.getElementById('conversation-panel')).not.toBeVisible();
      expect(document.getElementById('agent-inspector')).toBeVisible();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.getElementById('agent-inspector')).not.toBeVisible();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('reconciles open panels when a mounted desktop window becomes narrow', () => {
    const originalMatchMedia = window.matchMedia;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    let matches = false;
    const mediaQuery = {
      get matches() {
        return matches;
      },
      media: '(max-width: 820px)',
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    } as MediaQueryList;
    window.matchMedia = vi.fn().mockReturnValue(mediaQuery);

    try {
      render(<DemoShell />);
      expect(document.getElementById('conversation-panel')).toBeVisible();
      expect(document.getElementById('agent-inspector')).toBeVisible();

      act(() => {
        matches = true;
        for (const listener of listeners) {
          listener({ matches: true, media: mediaQuery.media } as MediaQueryListEvent);
        }
      });

      expect(document.getElementById('conversation-panel')).toBeVisible();
      expect(document.getElementById('agent-inspector')).not.toBeVisible();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.getElementById('conversation-panel')).not.toBeVisible();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('keeps liquid glass restrained to shell chrome', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/demo/chat-demo.css'), 'utf8');

    expect(css).toContain('--demo-bg: #111216');
    expect(css).toContain('--demo-glass: rgba(37, 38, 44, 0.72)');
    expect(css).toContain('backdrop-filter: blur(24px) saturate(140%)');
    expect(css).toContain('.chat-demo.is-conversations-closed');
    expect(css).toContain('@media (min-width: 1100px)');
    expect(css).toContain('.chat-demo .message-stack {\n  display: grid;\n  width: 100%');
    expect(css).toContain('.chat-demo.is-inspector-closed');
    expect(css).toContain('.chat-demo [hidden]');
    expect(css).toMatch(/\.chat-demo \.sidebar\s*{[^}]*grid-column: 1/s);
    expect(css).toMatch(/\.chat-demo \.thread\s*{[^}]*grid-column: 2/s);
    expect(css).toMatch(/\.chat-demo > \[aria-label="Agent inspector"\]\s*{[^}]*grid-column: 3/s);
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('.rail-button');
  });
});
