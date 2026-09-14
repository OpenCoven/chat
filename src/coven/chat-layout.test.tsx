import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatLayout, type ChatLayoutProps } from './chat-layout';

function layoutProps(): ChatLayoutProps {
  return {
    familiars: [],
    sessions: [],
    messages: [],
    familiarId: '',
    sessionId: '',
    draft: '',
    status: 'Open the desktop app to use the Coven CLI.',
    ready: false,
    busy: false,
    loading: false,
    cancelling: false,
    error: '',
    onFamiliar: vi.fn(),
    onDraft: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onRefresh: vi.fn(),
  };
}

describe('production Familiars layout', () => {
  it('hides archived familiar rows until the settings filter is enabled', () => {
    const props = {
      ...layoutProps(),
      familiars: [
        { id: 'a', name: 'Active familiar' },
        { id: 'b', name: 'Archived familiar' },
      ],
      sessions: [{ id: 'old', title: 'Old', familiarId: 'b', archived: true }],
    };
    const view = render(<ChatLayout {...props} />);
    expect(screen.getByRole('button', { name: 'Active familiar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archived familiar' })).not.toBeInTheDocument();
    view.rerender(<ChatLayout {...props} archivedFilter />);
    expect(screen.getByRole('button', { name: 'Archived familiar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Active familiar' })).not.toBeInTheDocument();
  });

  it('keeps the archive filter inside collapsed user settings', () => {
    const onArchivedFilter = vi.fn();
    render(<ChatLayout {...layoutProps()} onArchivedFilter={onArchivedFilter} />);
    const settings = screen.getByText('User settings').closest('details');
    expect(settings).not.toHaveAttribute('open');
    expect(screen.getByRole('checkbox', { name: 'Show archived chats' })).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Archived chats' })).not.toBeInTheDocument();
    if (!settings) throw new Error('User settings are missing.');
    settings.open = true;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived chats' }));
    expect(onArchivedFilter).toHaveBeenCalledWith(true);
  });

  it('shows one row per familiar rather than one row per ledger session', () => {
    const props = layoutProps();
    render(
      <ChatLayout
        {...props}
        familiars={[
          { id: 'f', name: 'Echo' },
          { id: 'g', name: 'Salem' },
        ]}
        familiarId="f"
        sessions={[
          { id: 'head', familiarId: 'f', title: 'Current ledger', preview: 'Latest reply' },
          { id: 'old', familiarId: 'f', title: 'Previous ledger' },
        ]}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Echo' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Echo' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Echo' })).toHaveTextContent('Latest reply');
    expect(screen.getByRole('button', { name: 'Salem' })).toHaveTextContent('Start a conversation');
    expect(screen.queryByRole('button', { name: 'Previous ledger' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Salem' }));
    expect(props.onFamiliar).toHaveBeenCalledWith('g');
  });

  it('uses file cards and a compact plus attachment affordance', () => {
    const onAttach = vi.fn();
    const { container } = render(
      <ChatLayout
        {...layoutProps()}
        ready
        onAttach={onAttach}
        attachments={[{ id: 'file', name: 'notes.md', bytes: [65] }]}
        messages={[
          { id: 'u', role: 'user', text: '', attachments: [{ name: 'sent.md', size: 12 }] },
        ]}
      />,
    );
    expect(container.querySelector('.coven-compact-composer')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '1');
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled();
    expect(
      screen.getByText('sent.md').closest('[data-slot="attachment-chip"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('notes.md').closest('[data-slot="attachment-chip"]'),
    ).toBeInTheDocument();
  });

  it('keeps cancellation available while viewing an archived chat during a run', () => {
    const props = { ...layoutProps(), ready: true, readOnly: true, busy: true };
    render(<ChatLayout {...props} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    const stop = screen.getByRole('button', { name: 'Stop run' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('opens the familiar overview card from a reply avatar or name without navigating', () => {
    const props = {
      ...layoutProps(),
      familiarId: 'f',
      familiars: [{ id: 'f', name: 'Local familiar', description: 'Configured purpose' }],
      messages: [{ id: 'a', role: 'assistant' as const, text: 'A real reply' }],
    };
    render(<ChatLayout {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    const links = screen.getAllByRole('button', { name: "Show Local familiar's familiar card" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      fireEvent.click(link);
      expect(screen.getByRole('complementary', { name: 'Familiar inspector' })).toBeVisible();
      expect(screen.getByRole('region', { name: 'Overview' })).toHaveTextContent(
        'Configured purpose',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    }
    expect(props.onFamiliar).not.toHaveBeenCalled();
  });

  it('formats assistant Markdown while preserving user and system text literally', () => {
    const { container } = render(
      <ChatLayout
        {...layoutProps()}
        messages={[
          { id: 'u', role: 'user', text: '**literal user**' },
          { id: 'a', role: 'assistant', text: '## Answer\n\n**Formatted answer**' },
          { id: 's', role: 'system', text: '**literal system**' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Answer', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Formatted answer').tagName).toBe('STRONG');
    expect(screen.getByText('**literal user**')).toBeInTheDocument();
    expect(screen.getByText('**literal system**')).toBeInTheDocument();
    expect(container.querySelectorAll('.coven-formatted')).toHaveLength(1);
  });

  it('keeps three design columns and honest browser setup without seeded content', () => {
    const { container } = render(<ChatLayout {...layoutProps()} />);
    expect(container.querySelector('.fr-shell')).toBeInTheDocument();
    expect(container.querySelector('.fr-sidebar')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Familiars sidebar' })).toBeInTheDocument();
    expect(container.querySelector('.fr-thread')).toBeInTheDocument();
    expect(container.querySelector('.fr-inspector')).toBeInTheDocument();
    expect(screen.getByText('Open the desktop app to use the Coven CLI.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByText(/Astra|Cave connected|held|pricing/i)).not.toBeInTheDocument();
  });

  it('tells a ready user without a familiar that one must be selected, matching the disabled composer', () => {
    render(<ChatLayout {...layoutProps()} ready />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByText(/optional/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/select a familiar/i).length).toBeGreaterThan(0);
  });

  it('shows real messages, filters conversations and renders honest access', () => {
    const props = layoutProps();
    render(
      <ChatLayout
        {...props}
        ready
        familiars={[
          { id: 'f', name: 'Actual agent' },
          { id: 'g', name: 'Other agent' },
        ]}
        familiarId="f"
        sessions={[
          { id: 's', title: 'Actual session', familiarId: 'f' },
          { id: 't', title: 'Other session', familiarId: 'g' },
        ]}
        sessionId="s"
        messages={[{ id: 'm', role: 'assistant', text: 'Real output' }]}
      />,
    );
    expect(screen.getByText('Real output')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Other agent' }));
    expect(props.onFamiliar).toHaveBeenCalledWith('g');
    expect(screen.queryByRole('button', { name: 'Actual agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch familiar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import from Cave' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    expect(screen.getByText(/Access rules and approvals are not exposed/)).toBeInTheDocument();
  });

  it('collapses rails and forwards sends without attachment or command affordances', () => {
    const props = { ...layoutProps(), ready: true, draft: 'hello' };
    render(<ChatLayout {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide familiars' }));
    expect(screen.getByRole('button', { name: 'Show familiars' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commands' })).not.toBeInTheDocument();
  });

  it('uses the inspector cards for actual familiar metadata', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiarId="f"
        familiars={[
          {
            id: 'f',
            name: 'Local familiar',
            description: 'My configured purpose',
            workspace: '/actual/workspace',
          },
        ]}
      />,
    );
    expect(screen.getByText('My configured purpose').closest('.fr-card')).toBeInTheDocument();
    expect(screen.getByText('/actual/workspace')).toBeInTheDocument();
    expect(screen.queryByText('SOUL.md')).not.toBeInTheDocument();
  });

  it('follows live messages only while the reader remains near the bottom', () => {
    const props = layoutProps();
    const view = render(<ChatLayout {...props} />);
    const transcript = screen.getByRole('log');
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    view.rerender(
      <ChatLayout
        {...props}
        messages={[{ id: '1', role: 'assistant', text: 'First live message' }]}
      />,
    );
    expect(transcript.scrollTop).toBe(100);
    transcript.scrollTop = 690;
    fireEvent.scroll(transcript);
    view.rerender(
      <ChatLayout
        {...props}
        messages={[
          { id: '1', role: 'assistant', text: 'First live message' },
          { id: '2', role: 'assistant', text: 'Second live message' },
        ]}
      />,
    );
    expect(transcript.scrollTop).toBe(1000);
  });

  it('uses the real avatar in the switcher, empty thread, messages and inspector', () => {
    const avatarUrl = 'data:image/png;base64,YWJj';
    const props = {
      ...layoutProps(),
      familiarId: 'f',
      familiars: [{ id: 'f', name: 'Local familiar', avatarUrl }],
    };
    const view = render(<ChatLayout {...props} />);
    expect(screen.getAllByRole('img', { name: 'Local familiar avatar' })).toHaveLength(4);
    view.rerender(
      <ChatLayout {...props} messages={[{ id: 'm', role: 'assistant', text: 'Real reply' }]} />,
    );
    const image = document.querySelector('.fr-familiar img');
    expect(image).toHaveAttribute('src', avatarUrl);
    expect(screen.getAllByRole('img', { name: 'Local familiar avatar' })).toHaveLength(4);
  });
});

describe('compact viewports', () => {
  function mockViewport(maxWidth: number) {
    const listeners = new Set<() => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => {
        const limit = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN);
        return {
          matches: Number.isFinite(limit) && maxWidth <= limit,
          media: query,
          addEventListener: (_: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
        } as unknown as MediaQueryList;
      },
    });
    return () => {
      Reflect.deleteProperty(window, 'matchMedia');
    };
  }

  it('turns both rails into closed drawers that open one at a time and dismiss from the scrim or Escape', () => {
    const restore = mockViewport(390);
    try {
      const { container } = render(<ChatLayout {...layoutProps()} ready />);
      const shell = container.querySelector('.coven-chat');
      expect(shell).toHaveAttribute('data-tier', 'compact');
      const sidebar = container.querySelector('.fr-sidebar') as HTMLElement;
      const inspector = container.querySelector('.fr-inspector') as HTMLElement;
      expect(sidebar).toHaveAttribute('aria-hidden', 'true');
      expect(inspector).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('button', { name: 'Close panels' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Show familiars' }));
      expect(sidebar).not.toHaveAttribute('aria-hidden');
      expect(shell).toHaveAttribute('data-sidebar', 'open');
      fireEvent.click(screen.getByRole('button', { name: 'Close panels' }));
      expect(sidebar).toHaveAttribute('aria-hidden', 'true');

      fireEvent.click(screen.getByRole('button', { name: 'Show familiars' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }));
      expect(sidebar).toHaveAttribute('aria-hidden', 'true');
      expect(inspector).not.toHaveAttribute('aria-hidden');

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(inspector).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('button', { name: 'Close panels' })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('returns keyboard focus to the opener when a drawer closes', () => {
    const restore = mockViewport(390);
    try {
      render(<ChatLayout {...layoutProps()} ready />);
      const openFamiliars = screen.getByRole('button', { name: 'Show familiars' });
      openFamiliars.focus();
      fireEvent.click(openFamiliars);
      const hide = screen.getByRole('button', { name: 'Hide familiars' });
      hide.focus();
      fireEvent.click(hide);
      // The header opener remounts, so a surviving equivalent takes focus.
      expect(screen.getByRole('button', { name: 'Show familiars' })).toHaveFocus();

      const openInspector = screen.getByRole('button', { name: 'Show inspector' });
      openInspector.focus();
      fireEvent.click(openInspector);
      const scrim = screen.getByRole('button', { name: 'Close panels' });
      scrim.focus();
      fireEvent.click(scrim);
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }));
      screen.getByRole('button', { name: 'Close inspector' }).focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveFocus();
    } finally {
      restore();
    }
  });

  it('keeps the conversation rail but folds the inspector away on medium screens', () => {
    const restore = mockViewport(900);
    try {
      const { container } = render(<ChatLayout {...layoutProps()} ready />);
      expect(container.querySelector('.coven-chat')).toHaveAttribute('data-tier', 'medium');
      expect(screen.getByRole('complementary', { name: 'Familiars sidebar' })).not.toHaveAttribute(
        'aria-hidden',
      );
      expect(container.querySelector('.fr-inspector')).toHaveAttribute('aria-hidden', 'true');
    } finally {
      restore();
    }
  });

  it('opens every rail on wide screens and without matchMedia support', () => {
    const { container } = render(<ChatLayout {...layoutProps()} ready />);
    expect(container.querySelector('.coven-chat')).toHaveAttribute('data-tier', 'wide');
    expect(screen.getByRole('complementary', { name: 'Familiar inspector' })).not.toHaveAttribute(
      'aria-hidden',
    );
  });
});

describe('inspector metadata rows', () => {
  it('keeps a long workspace path recoverable through its tooltip instead of colliding with the label', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiarId="f"
        familiars={[
          {
            id: 'f',
            name: 'Astra',
            workspace: '/Users/someone/.coven/workspaces/familiars/astra/very/deep/path',
          },
        ]}
      />,
    );
    const value = screen.getByText(
      '/Users/someone/.coven/workspaces/familiars/astra/very/deep/path',
    );
    expect(value).toHaveAttribute(
      'title',
      '/Users/someone/.coven/workspaces/familiars/astra/very/deep/path',
    );
    expect(value).toHaveClass('coven-row-value--path');
  });
});
