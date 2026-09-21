import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenChannel, ScreenRelay } from '../lib/screen-relay';
import {
  activityCounts,
  ChatLayout,
  type ChatLayoutProps,
  composerCopy,
  emptyThreadText,
  matchesFamiliar,
  runStatusText,
} from './chat-layout';
import type { RfbClass } from './screen-viewer';

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
    connected: false,
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

describe('empty transcript copy', () => {
  it('names the three states without contradicting the heading', () => {
    expect(emptyThreadText(false)).toContain('Connect to your local Coven CLI');
    expect(emptyThreadText(false, 'Astra')).toContain('Connect to your local Coven CLI');
    expect(emptyThreadText(true)).toContain('Select a familiar');
    expect(emptyThreadText(true, 'Astra')).toContain('conversation with Astra');
    expect(emptyThreadText(true, 'Astra')).not.toContain('Select a familiar');
  });

  it('does not tell the reader to select the familiar they already selected', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        connected
        ready
      />,
    );
    expect(screen.getByText('Chat with Astra')).toBeInTheDocument();
    expect(screen.getByText(/start of your conversation with Astra/)).toBeInTheDocument();
    expect(screen.queryByText(/Select a familiar/)).not.toBeInTheDocument();
  });

  it('does not claim the CLI is down when it is up but nothing is selected', () => {
    // `ready` is false here in the real app (it demands a selection), so this
    // is precisely the state that used to read "Connect to your local Coven CLI".
    render(<ChatLayout {...layoutProps()} familiars={[{ id: 'f', name: 'Astra' }]} connected />);
    expect(screen.getByText(/Select a familiar from the sidebar/)).toBeInTheDocument();
    expect(screen.queryByText(/Connect to your local Coven CLI/)).not.toBeInTheDocument();
  });

  it('yields the transcript to the run indicator while a run is active', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        ready
        busy
      />,
    );
    expect(screen.queryByText('Chat with Astra')).not.toBeInTheDocument();
    // Run status now sits beside the composer and names the addressee, rather
    // than filling the transcript. The empty state must still yield to it.
    expect(screen.getByText(/Astra is responding/)).toBeInTheDocument();
  });
});

describe('structured tool activity', () => {
  const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'tool',
    text: name,
    tool: { name, args: 'ls -la', ...extra },
  });

  it('groups consecutive tool rows into one activity list inside the familiar turn', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        connected
        ready
        messages={[
          { id: '1', role: 'assistant', text: 'Looking.' },
          tool('2', 'Bash'),
          tool('3', 'Read', { args: 'src/app.ts', result: 'file body' }),
          { id: '4', role: 'assistant', text: 'Found it.' },
          tool('5', 'Grep', { isError: true, result: 'exit 1' }),
        ]}
      />,
    );
    const lists = screen.getAllByRole('list', { name: 'Tool activity' });
    expect(lists).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getAllByText('Tool activity')).toHaveLength(2);
    expect(screen.getByLabelText('Read result')).toHaveTextContent('file body');
    expect(screen.queryByLabelText('Bash result')).toBeNull();
    expect(screen.getByLabelText('Grep result')).toHaveTextContent('exit 1');
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('Tool')).not.toBeInTheDocument();
  });

  it('names the tool a run is executing and returns to responding once it settles', () => {
    const props = {
      ...layoutProps(),
      familiars: [{ id: 'f', name: 'Astra' }],
      familiarId: 'f',
      connected: true,
      ready: true,
      busy: true,
    };
    const view = render(<ChatLayout {...props} messages={[tool('1', 'Bash')]} />);
    expect(screen.getByText('Astra is running Bash…')).toBeVisible();
    view.rerender(<ChatLayout {...props} messages={[tool('1', 'Bash', { result: 'ok' })]} />);
    expect(screen.getByText('Astra is responding…')).toBeVisible();
    view.rerender(
      <ChatLayout
        {...props}
        messages={[tool('1', 'Bash'), { id: '2', role: 'assistant', text: 'Done.' }]}
      />,
    );
    expect(screen.getByText('Astra is responding…')).toBeVisible();
    view.rerender(<ChatLayout {...props} cancelling messages={[tool('1', 'Bash')]} />);
    expect(screen.getByText('Stopping; waiting for Coven…')).toBeVisible();
  });
});

describe('top bar identity', () => {
  it('shows no familiar identity when none is selected', () => {
    render(<ChatLayout {...layoutProps()} familiars={[{ id: 'f', name: 'Astra' }]} ready />);
    expect(screen.queryByText('Coven')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No familiar selected' })).toBeDisabled();
  });

  it('names the selected familiar and opens its card', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        ready
      />,
    );
    expect(screen.getByRole('button', { name: "Open Astra's familiar card" })).toBeEnabled();
  });
});

describe('composer copy', () => {
  it('names the addressee only when there is one', () => {
    expect(composerCopy(true, 'Astra')).toEqual({
      label: 'Message Astra',
      // The placeholder also advertises the reference affordances, which only
      // exist once there is a connected CLI and a familiar to address.
      placeholder: 'Message Astra · @ familiar · # project',
    });
    expect(composerCopy(true).placeholder).toBe('Select a familiar to send a message.');
    expect(composerCopy(true).label).toBe('Message');
    // A missing CLI is not fixed by choosing a familiar.
    expect(composerCopy(false).placeholder).toBe(
      'Connect to your local Coven CLI to send a message.',
    );
    expect(composerCopy(false, 'Astra').placeholder).toBe(
      'Connect to your local Coven CLI to send a message.',
    );
    // An archived chat still addresses its familiar, and `ready` is false
    // there, so selection -- not `ready` -- decides the addressee.
    expect(composerCopy(true, 'Lifecycle familiar').label).toBe('Message Lifecycle familiar');
  });

  it('does not offer to message the fallback name when nothing is selected', () => {
    render(
      <ChatLayout {...layoutProps()} familiars={[{ id: 'f', name: 'Astra' }]} connected ready />,
    );
    expect(screen.queryByPlaceholderText('Message Coven')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Select a familiar to send a message.')).toBeInTheDocument();
  });

  it('names the missing runtime rather than a selection when the CLI is down', () => {
    render(<ChatLayout {...layoutProps()} familiars={[{ id: 'f', name: 'Astra' }]} />);
    expect(
      screen.getByPlaceholderText('Connect to your local Coven CLI to send a message.'),
    ).toBeInTheDocument();
  });

  it('agrees with the transcript in every empty state', () => {
    // The two helpers decide on the same inputs, so the field and the
    // transcript can no longer name different obstacles.
    for (const connected of [true, false]) {
      for (const name of [undefined, 'Astra']) {
        const transcript = emptyThreadText(connected, name);
        const field = composerCopy(connected, name).placeholder;
        const blamesRuntime = (text: string) => text.includes('Coven CLI');
        const blamesSelection = (text: string) => text.includes('Select a familiar');
        expect(blamesRuntime(field)).toBe(blamesRuntime(transcript));
        expect(blamesSelection(field)).toBe(blamesSelection(transcript));
      }
    }
  });

  it('addresses the selected familiar', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        connected
        ready
      />,
    );
    expect(
      screen.getByPlaceholderText('Message Astra · @ familiar · # project'),
    ).toBeInTheDocument();
  });
});

describe('production Familiars layout', () => {
  it('uses independent reserved tabs with stable accessible names and live familiar labels', () => {
    const props = {
      ...layoutProps(),
      familiarId: 'nova',
      familiars: [{ id: 'nova', name: 'Nova' }],
    };
    const { container, rerender } = render(<ChatLayout {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide familiars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    const left = screen.getByRole('button', { name: 'Show familiars' });
    const right = screen.getByRole('button', { name: 'Show inspector' });
    const shell = container.querySelector<HTMLElement>('.coven-chat');
    expect(left).toHaveTextContent('Familiars');
    expect(right).toHaveTextContent('Nova');
    for (const [button, variable] of [
      [left, '--coven-sidebar-w'],
      [right, '--coven-inspector-w'],
    ] as const) {
      expect(button.parentElement).toBe(shell);
      expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).toHaveAttribute(
        'inert',
      );
      expect(shell?.style.getPropertyValue(variable)).toBe('var(--coven-rail-tab-w)');
    }
    expect(container.querySelector('.fr-thread .fr-rail-handle')).not.toBeInTheDocument();
    rerender(<ChatLayout {...props} familiars={[{ id: 'nova', name: 'Renamed familiar' }]} />);
    expect(right).toHaveTextContent('Renamed familiar');
    rerender(<ChatLayout {...props} familiars={[]} />);
    expect(right).toHaveTextContent('Details');
    fireEvent.click(left);
    expect(screen.getByRole('complementary', { name: 'Familiars sidebar' })).not.toHaveAttribute(
      'inert',
    );
    expect(left).not.toBeVisible();
  });

  it('shows the observed workspace and keeps connection diagnostics collapsed', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        ready
        familiarId="nova"
        sessionId="chat"
        familiars={[{ id: 'nova', name: 'Nova', workspace: '/familiars/nova' }]}
        sessions={[{ id: 'chat', title: 'Chat', projectRoot: '/projects/chat' }]}
        status="Coven runtime version details"
        busy
      />,
    );
    expect(screen.getByText('Chat project: /projects/chat')).toBeVisible();
    expect(screen.getByText('Coven runtime version details')).not.toBeVisible();
    expect(screen.getByText('Connection details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Nova is responding…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeEnabled();
  });

  it('toggles both rails with keyboard shortcuts without changing the draft', () => {
    const props = { ...layoutProps(), ready: true, draft: 'Keep this draft' };
    const { container } = render(<ChatLayout {...props} />);
    const shell = container.querySelector('.coven-chat');
    const field = screen.getByRole('textbox');
    act(() => field.focus());
    fireEvent.keyDown(field, { key: '\\', code: 'Backslash', metaKey: true });
    expect(shell).toHaveAttribute('data-sidebar', 'closed');
    fireEvent.keyDown(field, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(shell).toHaveAttribute('data-sidebar', 'open');
    fireEvent.keyDown(field, { key: '|', code: 'Backslash', metaKey: true, shiftKey: true });
    expect(shell).toHaveAttribute('data-inspector', 'closed');
    fireEvent.keyDown(field, { key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: true });
    expect(shell).toHaveAttribute('data-inspector', 'open');
    expect(field).toHaveValue('Keep this draft');
    expect(props.onDraft).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('ignores plain typing, composition, repeats, and modal dialogs for rail shortcuts', () => {
    const { container } = render(<ChatLayout {...layoutProps()} />);
    const shell = container.querySelector('.coven-chat');
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash' });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true, repeat: true });
    const dialog = document.createElement('dialog');
    dialog.open = true;
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    dialog.remove();
    expect(shell).toHaveAttribute('data-sidebar', 'open');
  });

  it('keeps archived familiar rows out of the agent list', () => {
    const props = {
      ...layoutProps(),
      familiars: [
        { id: 'a', name: 'Active familiar' },
        { id: 'b', name: 'Archived familiar' },
      ],
      sessions: [{ id: 'old', title: 'Old', familiarId: 'b', archived: true }],
    };
    render(<ChatLayout {...props} />);
    expect(screen.getByRole('button', { name: 'Active familiar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archived familiar' })).not.toBeInTheDocument();
  });

  it('offers the archived-chat view only when the host can change it', () => {
    const { unmount } = render(<ChatLayout {...layoutProps()} />);
    expect(screen.queryByText('User settings')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Show archived chats' })).not.toBeInTheDocument();
    unmount();

    const onArchivedFilter = vi.fn();
    render(<ChatLayout {...layoutProps()} onArchivedFilter={onArchivedFilter} />);
    const toggle = screen.getByRole('checkbox', { name: 'Show archived chats' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onArchivedFilter).toHaveBeenCalledWith(true);
  });

  it('reaches archived chats so they can be restored', () => {
    const props = {
      ...layoutProps(),
      familiars: [
        { id: 'live', name: 'Active familiar' },
        { id: 'gone', name: 'Archived familiar' },
      ],
      sessions: [
        { id: 's1', familiarId: 'live', title: 'Active familiar' },
        { id: 's2', familiarId: 'gone', title: 'Archived familiar', archived: true },
      ],
    };
    const { unmount } = render(<ChatLayout {...props} />);
    expect(screen.queryByRole('button', { name: 'Archived familiar' })).not.toBeInTheDocument();
    unmount();

    // Archiving must not strand a chat: the archived view is the route back.
    render(<ChatLayout {...props} archivedFilter onArchivedFilter={() => {}} />);
    expect(screen.getByRole('button', { name: 'Archived familiar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Active familiar' })).not.toBeInTheDocument();
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
    // `connected` is what makes this the healthy/no-selection state. Rendering
    // `ready` alone left the assertion below satisfied by the inspector's
    // unrelated prose while the composer named the runtime instead.
    render(<ChatLayout {...layoutProps()} connected ready />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByText(/optional/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/select a familiar/i).length).toBeGreaterThan(0);
    // The name promises the composer specifically, so assert it directly.
    expect(screen.getByPlaceholderText('Select a familiar to send a message.')).toBeInTheDocument();
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
    // The empty thread shows the purpose too; this asserts the inspector card.
    expect(
      within(screen.getByRole('region', { name: 'Overview' }))
        .getByText('My configured purpose')
        .closest('.fr-card'),
    ).toBeInTheDocument();
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

  it.each([300, 360])('rail tabs yield to the scrim at width %i', (width) => {
    const restore = mockViewport(width);
    try {
      const { container } = render(<ChatLayout {...layoutProps()} ready />);
      const shell = container.querySelector('.coven-chat');
      expect(screen.getByRole('button', { name: 'Show familiars' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Show inspector' })).toBeVisible();

      // With a drawer open the scrim owns the surface. A reserved tab left on
      // top of it would swallow the click that dismisses the drawer.
      fireEvent.click(screen.getByRole('button', { name: 'Show familiars' }));
      expect(shell).toHaveAttribute('data-sidebar', 'open');
      expect(screen.queryByRole('button', { name: 'Show inspector' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close panels' }));
      expect(shell).toHaveAttribute('data-sidebar', 'closed');
      const right = screen.getByRole('button', { name: 'Show inspector' });
      expect(right).toBeVisible();

      right.focus();
      fireEvent.click(right);
      expect(shell).toHaveAttribute('data-sidebar', 'closed');
      expect(shell).toHaveAttribute('data-inspector', 'open');
      screen.getByRole('button', { name: 'Close inspector' }).focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveFocus();
    } finally {
      restore();
    }
  });

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

      // Switching rails goes through the scrim rather than tab-to-tab, so the
      // dismiss target is never covered.
      fireEvent.click(screen.getByRole('button', { name: 'Show familiars' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close panels' }));
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
      // The full-height tab survives independently of the inert panel.
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

describe('sidebar recency', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');

  it('orders familiars by latest activity, captions each with its age, and keeps undated ones last', () => {
    vi.useFakeTimers({ now });
    try {
      render(
        <ChatLayout
          {...layoutProps()}
          connected
          familiars={[
            { id: 'a', name: 'Alder' },
            { id: 'b', name: 'Birch' },
            { id: 'c', name: 'Cedar' },
            { id: 'd', name: 'Dove' },
          ]}
          sessions={[
            { id: 's-a', familiarId: 'a', title: 'a', updatedAt: '2026-09-18T12:00:00Z' },
            { id: 's-b', familiarId: 'b', title: 'b', updatedAt: '2026-09-20T11:30:00Z' },
            { id: 's-c', familiarId: 'c', title: 'c', updatedAt: 'today' },
          ]}
        />,
      );
      const names = screen
        .getAllByRole('button', { name: /^(Alder|Birch|Cedar|Dove)$/ })
        .map((row) => row.getAttribute('aria-label'));
      expect(names).toEqual(['Birch', 'Alder', 'Cedar', 'Dove']);
      expect(screen.getByRole('button', { name: 'Birch' })).toHaveTextContent('30m');
      expect(screen.getByRole('button', { name: 'Alder' })).toHaveTextContent('2d');
      expect(screen.getByRole('button', { name: 'Alder' }).querySelector('time')).toHaveAttribute(
        'datetime',
        '2026-09-18T12:00:00Z',
      );
      // An unparseable CLI timestamp gets no caption rather than a wrong one.
      expect(screen.getByRole('button', { name: 'Cedar' }).querySelector('time')).toBeNull();
      expect(screen.getByRole('button', { name: 'Dove' }).querySelector('time')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('familiar list keyboard navigation', () => {
  function renderList() {
    const props = layoutProps();
    render(
      <ChatLayout
        {...props}
        connected
        familiars={[
          { id: 'a', name: 'Alder' },
          { id: 'b', name: 'Birch' },
          { id: 'c', name: 'Cedar' },
        ]}
      />,
    );
    return props;
  }

  it('moves from the search box into the rows and between them with the arrow keys', () => {
    renderList();
    const search = screen.getByRole('searchbox', { name: 'Search familiars' });
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Alder' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Birch' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(screen.getByRole('button', { name: 'Cedar' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Cedar' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: 'Birch' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Alder' })).toHaveFocus();
  });

  it('selects the first match with Enter and clears the filter with Escape', () => {
    const props = renderList();
    const search = screen.getByRole('searchbox', { name: 'Search familiars' });
    fireEvent.change(search, { target: { value: 'ced' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onFamiliar).toHaveBeenCalledWith('c');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.getAllByRole('button', { name: /^(Alder|Birch|Cedar)$/ })).toHaveLength(3);
    fireEvent.change(search, { target: { value: 'zzz' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onFamiliar).toHaveBeenCalledTimes(1);
  });
});

describe('error notices', () => {
  it('offers a dismiss control only when the host can clear the error', () => {
    const onDismissError = vi.fn();
    const view = render(<ChatLayout {...layoutProps()} error="The run failed." />);
    expect(screen.getByRole('alert')).toHaveTextContent('The run failed.');
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).not.toBeInTheDocument();
    view.rerender(
      <ChatLayout {...layoutProps()} error="The run failed." onDismissError={onDismissError} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(onDismissError).toHaveBeenCalledOnce();
  });
});

describe('live run row', () => {
  const props = () => ({
    ...layoutProps(),
    familiars: [{ id: 'f', name: 'Astra' }],
    familiarId: 'f',
    connected: true,
    ready: true,
    busy: true,
  });
  const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'tool',
    text: name,
    tool: { name, args: 'ls', ...extra },
  });

  it('waits at the end of the thread until prose streams, then yields to it', () => {
    const view = render(
      <ChatLayout {...props()} messages={[{ id: '1', role: 'user', text: 'Hi' }]} />,
    );
    expect(screen.getByText('Waiting for Astra…')).toBeVisible();
    view.rerender(
      <ChatLayout
        {...props()}
        messages={[
          { id: '1', role: 'user', text: 'Hi' },
          { id: '2', role: 'assistant', text: 'Hel' },
        ]}
      />,
    );
    expect(screen.queryByText('Waiting for Astra…')).not.toBeInTheDocument();
    view.rerender(<ChatLayout {...props()} busy={false} messages={[]} />);
    expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument();
    expect(screen.getByText('Chat with Astra')).toBeInTheDocument();
  });

  it('names the executing tool, marks its row as running, and reports stopping', () => {
    const view = render(<ChatLayout {...props()} messages={[tool('1', 'Bash')]} />);
    expect(screen.getByText('Running Bash…')).toBeVisible();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('data-running', 'true');
    view.rerender(<ChatLayout {...props()} messages={[tool('1', 'Bash', { result: 'ok' })]} />);
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for Astra…')).toBeVisible();
    view.rerender(<ChatLayout {...props()} cancelling messages={[tool('1', 'Bash')]} />);
    // The sidebar row marks the run as stopping too; this asserts the live row.
    expect(within(screen.getByRole('log')).getByText('Stopping…')).toBeVisible();
  });
});

describe('jump to latest', () => {
  it('counts the messages that arrived while the reader was scrolled back', () => {
    const props = { ...layoutProps(), messages: [{ id: '1', role: 'assistant', text: 'One' }] };
    const view = render(<ChatLayout {...props} />);
    const transcript = screen.getByRole('log');
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toHaveTextContent(
      /^Jump to latest$/,
    );
    view.rerender(
      <ChatLayout
        {...props}
        messages={[
          { id: '1', role: 'assistant', text: 'One' },
          { id: '2', role: 'user', text: 'Two' },
          { id: '3', role: 'assistant', text: 'Three' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toHaveTextContent(
      '2 new messages',
    );
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
    expect(transcript.scrollTop).toBe(1000);
  });
});

describe('copying a reply', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('copies the reply source and reports the outcome honestly', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <ChatLayout
        {...layoutProps()}
        familiars={[{ id: 'f', name: 'Astra' }]}
        familiarId="f"
        messages={[
          { id: '1', role: 'user', text: 'Question' },
          { id: '2', role: 'assistant', text: '**Answer**' },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Copy reply' });
    expect(screen.getAllByRole('button', { name: 'Copy reply' })).toHaveLength(1);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('**Answer**');
    await screen.findByText('Copied');
    expect(button).toHaveAttribute('data-state', 'copied');

    writeText.mockRejectedValue(new Error('denied'));
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    fireEvent.click(button);
    await screen.findByText('Copy failed');
    expect(button).toHaveAttribute('data-state', 'failed');
  });
});

describe('run attribution', () => {
  const two = () => ({
    ...layoutProps(),
    connected: true,
    ready: true,
    familiars: [
      { id: 'a', name: 'Astra' },
      { id: 'b', name: 'Bram' },
    ],
    sessions: [
      { id: 's-a', familiarId: 'a', title: 'a' },
      { id: 's-b', familiarId: 'b', title: 'b' },
    ],
  });

  it("names the run states without crediting another familiar's run to this one", () => {
    expect(runStatusText('Bram', 'Astra', true, false, undefined)).toBe('Bram is responding…');
    expect(runStatusText('Bram', 'Astra', true, false, 'Bash')).toBe('Bram is running Bash…');
    expect(runStatusText('Bram', 'Astra', true, true, 'Bash')).toBe('Stopping; waiting for Coven…');
    expect(runStatusText('Bram', 'Astra', false, false, undefined)).toBe(
      'Astra is still responding in another chat. Wait for that run to finish or stop it before messaging Bram.',
    );
    expect(runStatusText('Bram', 'Astra', false, true, undefined)).toBe(
      "Stopping Astra's run in another chat…",
    );
  });

  it('keeps the run with the familiar it was sent to after switching away', () => {
    render(
      <ChatLayout {...two()} familiarId="b" sessionId="s-b" busy runFamiliarId="a" messages={[]} />,
    );
    // Bram's empty thread stays an empty thread: no live row, no claimed run.
    expect(screen.getByText('Chat with Bram')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bram is responding/)).not.toBeInTheDocument();
    expect(screen.getByText(/Astra is still responding in another chat/)).toBeInTheDocument();
    // Stop still reaches the one active run.
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeEnabled();
    const astra = screen.getByRole('button', { name: 'Astra' });
    const bram = screen.getByRole('button', { name: 'Bram' });
    expect(astra).toHaveTextContent('Responding…');
    expect(bram).not.toHaveTextContent('Responding…');
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent(
      'Astra is responding in another chat',
    );
  });

  it("marks the shown familiar's own run in the sidebar and says when it is stopping", () => {
    const { rerender } = render(
      <ChatLayout {...two()} familiarId="a" sessionId="s-a" busy runFamiliarId="a" />,
    );
    expect(screen.getByRole('button', { name: 'Astra' })).toHaveTextContent('Responding…');
    expect(screen.getByText('Waiting for Astra…')).toBeInTheDocument();
    expect(screen.getByText('Astra is responding…')).toBeInTheDocument();
    rerender(
      <ChatLayout {...two()} familiarId="a" sessionId="s-a" busy runFamiliarId="a" cancelling />,
    );
    expect(screen.getByRole('button', { name: 'Astra' })).toHaveTextContent('Stopping…');
    rerender(<ChatLayout {...two()} familiarId="a" sessionId="s-a" />);
    expect(screen.getByRole('button', { name: 'Astra' })).not.toHaveTextContent(
      /Responding|Stopping/,
    );
  });

  it('credits the run to the shown familiar when the host does not say whose it is', () => {
    render(<ChatLayout {...two()} familiarId="a" sessionId="s-a" busy />);
    expect(screen.getByText('Astra is responding…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Astra' })).toHaveTextContent('Responding…');
  });
});

describe('inspector detail rows', () => {
  const props = () => ({
    ...layoutProps(),
    connected: true,
    ready: true,
    familiars: [
      { id: 'a', name: 'Astra' },
      { id: 'b', name: 'Bram' },
    ],
    sessions: [
      { id: 's-a', familiarId: 'a', title: 'a', updatedAt: '2026-09-20T11:30:00Z' },
      { id: 's-b', familiarId: 'b', title: 'b', archived: true },
    ],
  });

  it('reports the chat state and last activity instead of a count of every session', () => {
    const { rerender } = render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    const overview = () => screen.getByRole('region', { name: 'Overview' });
    expect(overview()).not.toHaveTextContent('Conversations');
    expect(overview()).toHaveTextContent('ChatActive');
    expect(overview().querySelector('time')?.getAttribute('datetime')).toBe('2026-09-20T11:30:00Z');
    rerender(<ChatLayout {...props()} familiarId="b" sessionId="s-b" />);
    expect(overview()).toHaveTextContent('ChatArchived');
    expect(overview()).toHaveTextContent('Last activityNot reported');
    rerender(<ChatLayout {...props()} familiars={[{ id: 'c', name: 'Cass' }]} familiarId="c" />);
    expect(overview()).toHaveTextContent('ChatNot started');
  });

  it('counts sent messages, replies and tool calls from the transcript', () => {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'hello' },
      { id: 't1', role: 'tool', text: 'Bash', tool: { name: 'Bash', args: 'ls', result: 'ok' } },
      {
        id: 't2',
        role: 'tool',
        text: 'Read',
        tool: { name: 'Read', args: 'x', result: 'missing', isError: true },
      },
      { id: 'u2', role: 'user', text: 'thanks' },
      { id: 'a2', role: 'assistant', text: '' },
    ];
    expect(activityCounts(messages)).toEqual({ sent: 2, replies: 1, tools: 2, failed: 1 });
    render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(activity).toHaveTextContent('RunIdle');
    expect(activity).toHaveTextContent('Your messages2');
    expect(activity).toHaveTextContent('Replies1');
    expect(activity).toHaveTextContent('Tool calls2 · 1 failed');
    expect(activity).not.toHaveTextContent('messages loaded');
  });

  it('names the executing tool in the Activity run row', () => {
    render(
      <ChatLayout
        {...props()}
        familiarId="a"
        sessionId="s-a"
        busy
        runFamiliarId="a"
        messages={[{ id: 't', role: 'tool', text: 'Bash', tool: { name: 'Bash', args: 'ls' } }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent('RunRunning Bash');
    expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent('Tool calls1');
  });

  it('tells the reader the screen viewer exists instead of calling it unavailable', () => {
    render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    const access = screen.getByRole('region', { name: 'Access' });
    expect(access).toHaveTextContent('Show screen');
    expect(access).not.toHaveTextContent('Screen sharing');
  });
});

describe('sidebar search', () => {
  it('offers to clear a search that matches nothing', () => {
    render(<ChatLayout {...layoutProps()} connected familiars={[{ id: 'a', name: 'Astra' }]} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching familiars.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Astra' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });
});

describe('screen viewer pane', () => {
  it('closes the host connection and forgets the address when the familiar changes', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const relay: ScreenRelay = {
      available: true,
      open: (url) => {
        const close = vi.fn();
        closes.push(close);
        return {
          url,
          binaryType: 'arraybuffer',
          protocol: '',
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          lastError: '',
          send: vi.fn(),
          close,
        } as unknown as ScreenChannel;
      },
    };
    class FakeRfb extends EventTarget {
      viewOnly = false;
      scaleViewport = false;
      background = '';
      disconnect = vi.fn();
    }
    const props = {
      ...layoutProps(),
      connected: true,
      ready: true,
      familiars: [
        { id: 'a', name: 'Alder' },
        { id: 'b', name: 'Birch' },
      ],
      screen: relay,
      screenLoadRfb: async () => FakeRfb as unknown as RfbClass,
    };
    const view = render(<ChatLayout {...props} familiarId="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show screen' }));
    fireEvent.change(screen.getByLabelText('Screen address'), {
      target: { value: 'wss://sandbox/websockify' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    expect(closes).toHaveLength(1);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    view.rerender(<ChatLayout {...props} familiarId="b" />);
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
    expect(screen.getByLabelText('Screen address')).toHaveValue('');
  });
});

describe('choosing a familiar', () => {
  const props = () => ({
    ...layoutProps(),
    connected: true,
    ready: true,
    familiars: [
      { id: 'a', name: 'Astra', description: 'Reviews pull requests.' },
      { id: 'b', name: 'Bram' },
    ],
    sessions: [{ id: 's-a', familiarId: 'a', title: 'a', updatedAt: '2026-09-20T11:30:00Z' }],
  });

  it('hands focus to the composer after a row is chosen', () => {
    const view = render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bram' }));
    // The host switches the selection; the composer takes focus once it is shown.
    view.rerender(<ChatLayout {...props()} familiarId="b" sessionId="" />);
    expect(screen.getByRole('textbox', { name: 'Message Bram' })).toHaveFocus();
  });

  it('waits for the thread to load before focusing, and drops a stale request', () => {
    const view = render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bram' }));
    view.rerender(<ChatLayout {...props()} familiarId="b" sessionId="" loading />);
    expect(screen.getByRole('textbox', { name: 'Message Bram' })).not.toHaveFocus();
    view.rerender(<ChatLayout {...props()} familiarId="b" sessionId="" />);
    expect(screen.getByRole('textbox', { name: 'Message Bram' })).toHaveFocus();
    // A request for Bram never fires on Astra's composer: the host moved on.
    fireEvent.click(screen.getByRole('button', { name: 'Bram' }));
    screen.getByRole('searchbox').focus();
    view.rerender(<ChatLayout {...props()} familiarId="a" sessionId="s-a" loading />);
    view.rerender(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('focuses the composer after Enter in the search box opens the first match', () => {
    const view = render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    const search = screen.getByRole('searchbox');
    search.focus();
    fireEvent.change(search, { target: { value: 'Br' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    view.rerender(<ChatLayout {...props()} familiarId="b" sessionId="" />);
    expect(screen.getByRole('textbox', { name: 'Message Bram' })).toHaveFocus();
  });

  it('reaches the familiar search with Cmd/Ctrl+K, opening the sidebar if needed', () => {
    render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide familiars' }));
    expect(screen.getByRole('button', { name: 'Show familiars' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Show familiars' })).not.toBeInTheDocument();
    screen.getByRole('textbox', { name: 'Message Astra' }).focus();
    fireEvent.keyDown(window, { key: 'K', code: 'KeyK', ctrlKey: true });
    expect(screen.getByRole('searchbox')).toHaveFocus();
    // Shift+K, a bare K, and an Alt chord are not the shortcut.
    screen.getByRole('textbox', { name: 'Message Astra' }).focus();
    fireEvent.keyDown(window, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK' });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true, altKey: true });
    expect(screen.getByRole('searchbox')).not.toHaveFocus();
    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  });

  it("shows the familiar's purpose under the empty thread heading", () => {
    render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    const empty = screen.getByText('Chat with Astra').parentElement;
    expect(empty).toHaveTextContent('Reviews pull requests.');
    expect(empty).toHaveTextContent('start of your conversation with Astra');
  });

  it("captions the header with the chat's last activity when it is a date", () => {
    const view = render(<ChatLayout {...props()} familiarId="a" sessionId="s-a" />);
    const caption = screen.getByRole('banner').querySelector('time');
    expect(caption?.textContent).toMatch(/^Updated /);
    expect(caption).toHaveAttribute('datetime', '2026-09-20T11:30:00Z');
    view.rerender(
      <ChatLayout
        {...props()}
        familiarId="a"
        sessionId="s-a"
        sessions={[{ id: 's-a', familiarId: 'a', title: 'a', updatedAt: 'today' }]}
      />,
    );
    expect(screen.getByRole('banner').querySelector('time')).toBeNull();
  });
});

describe('draft reminders', () => {
  it("leads a row's preview with the unsent draft instead of the last message", () => {
    render(
      <ChatLayout
        {...layoutProps()}
        connected
        ready
        familiars={[
          { id: 'a', name: 'Astra' },
          { id: 'b', name: 'Bram' },
        ]}
        sessions={[
          { id: 's-a', familiarId: 'a', title: 'a', preview: 'Reviewing the branch' },
          { id: 's-b', familiarId: 'b', title: 'b', preview: 'CI is green' },
        ]}
        familiarId="a"
        sessionId="s-a"
        drafts={{ b: 'ask about the flaky job', a: '   ' }}
      />,
    );
    const bram = screen.getByRole('button', { name: 'Bram' });
    expect(bram).toHaveTextContent('Draft:ask about the flaky job');
    expect(bram).not.toHaveTextContent('CI is green');
    // Whitespace is not a draft.
    const astra = screen.getByRole('button', { name: 'Astra' });
    expect(astra).not.toHaveTextContent('Draft:');
    expect(astra).toHaveTextContent('Reviewing the branch');
  });
});

describe('finished runs', () => {
  const props = () => ({
    ...layoutProps(),
    connected: true,
    ready: true,
    familiars: [
      { id: 'a', name: 'Astra' },
      { id: 'b', name: 'Bram' },
      { id: 'c', name: 'Cass' },
    ],
    sessions: [
      { id: 's-a', familiarId: 'a', title: 'a', updatedAt: '2026-09-20T11:30:00Z' },
      { id: 's-b', familiarId: 'b', title: 'b', updatedAt: '2026-09-20T11:30:00Z' },
    ],
    familiarId: 'c',
  });

  it('marks the rows whose runs ended elsewhere, by outcome, in place of their age', () => {
    render(<ChatLayout {...props()} finished={{ a: 'reply', b: 'error' }} />);
    const astra = screen.getByRole('button', { name: 'Astra (new reply)' });
    expect(astra).toHaveTextContent('New reply');
    expect(astra.querySelector('time')).toBeNull();
    const bram = screen.getByRole('button', { name: 'Bram (run failed)' });
    expect(bram).toHaveTextContent('Run failed');
    expect(screen.getByRole('button', { name: 'Cass' })).not.toHaveTextContent(/New reply|failed/);
  });

  it('lets a live run outrank a stale marker on the same row', () => {
    render(<ChatLayout {...props()} finished={{ a: 'reply' }} busy runFamiliarId="a" />);
    const astra = screen.getByRole('button', { name: 'Astra' });
    expect(astra).toHaveTextContent('Responding…');
    expect(astra).not.toHaveTextContent('New reply');
  });
});

describe('sidebar filter', () => {
  it('matches name, identity, or purpose without regard to case', () => {
    const item = { id: 'fam-astra-01', name: 'Astra', description: 'Reviews pull requests.' };
    expect(matchesFamiliar(item, '')).toBe(true);
    expect(matchesFamiliar(item, '  ')).toBe(true);
    expect(matchesFamiliar(item, 'AST')).toBe(true);
    expect(matchesFamiliar(item, 'astra-01')).toBe(true);
    expect(matchesFamiliar(item, 'pull req')).toBe(true);
    expect(matchesFamiliar(item, 'release')).toBe(false);
    expect(matchesFamiliar({ id: 'x', name: 'Bram' }, 'pull')).toBe(false);
  });

  it('finds a familiar by purpose from the search box', () => {
    render(
      <ChatLayout
        {...layoutProps()}
        connected
        familiars={[
          { id: 'a', name: 'Astra', description: 'Reviews pull requests.' },
          { id: 'b', name: 'Bram', description: 'Keeps CI honest.' },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ci honest' } });
    expect(screen.getByRole('button', { name: 'Bram' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Astra' })).not.toBeInTheDocument();
  });

  it('tells a disconnected reader to connect, not to configure a familiar', () => {
    const { rerender } = render(<ChatLayout {...layoutProps()} />);
    expect(
      screen.getByText(/Connect to your local Coven CLI to see your familiars/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Configure a familiar/)).not.toBeInTheDocument();
    rerender(<ChatLayout {...layoutProps()} connected />);
    expect(screen.getByText(/Configure a familiar in Coven/)).toBeInTheDocument();
  });
});

describe('inspector copy controls and row tooltips', () => {
  it('offers to copy the identity and the workspace path', () => {
    const { rerender } = render(
      <ChatLayout
        {...layoutProps()}
        connected
        ready
        familiars={[
          { id: 'fam-astra-01', name: 'Astra', workspace: '/w/astra', description: 'Reviews PRs.' },
        ]}
        familiarId="fam-astra-01"
      />,
    );
    expect(screen.getByRole('button', { name: 'Copy identity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy workspace path' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Astra' })).toHaveAttribute('title', 'Reviews PRs.');
    rerender(
      <ChatLayout
        {...layoutProps()}
        connected
        ready
        familiars={[{ id: 'fam-astra-01', name: 'Astra' }]}
        familiarId="fam-astra-01"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy workspace path' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Astra' })).not.toHaveAttribute('title');
  });
});

describe('retrying a failed run', () => {
  const props = () => ({
    ...layoutProps(),
    connected: true,
    ready: true,
    familiars: [{ id: 'a', name: 'Astra' }],
    familiarId: 'a',
    error: 'Coven reported a failed run.',
    onRetry: vi.fn(),
  });

  it('offers to send the restored draft again from the error notice', () => {
    const p = { ...props(), draft: 'the restored text' };
    render(<ChatLayout {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.onRetry).toHaveBeenCalledOnce();
  });

  it('offers it for restored attachments alone, and not once nothing is left to send', () => {
    const { rerender } = render(
      <ChatLayout {...props()} attachments={[{ id: 'x', name: 'note.txt', bytes: [97] }]} />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    rerender(<ChatLayout {...props()} draft="   " />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('does not offer it while the composer cannot send, or for an error that is not a run', () => {
    const { rerender } = render(<ChatLayout {...props()} draft="text" loading />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    const { onRetry: _none, ...noRetry } = props();
    rerender(<ChatLayout {...noRetry} draft="text" />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
