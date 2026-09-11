import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatSideConversations } from './chat-side-conversations';
import { continuityMemory, sideCreationMemory } from './lib/chat-continuity';
import { openChatStore } from './lib/local/chat-store';
import { createLocalChatWriter } from './lib/local/chat-writer';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { CreateSideInput } from './lib/local/side-conversations';

async function fixture(outcome: 'error' | 'throw' | 'ok') {
  const store = await openChatStore({ backend: createMemoryChatBackend(), familiarId: 'local' });
  const parent = await store.createConversation('Parent');
  const otherParent = await store.createConversation('Other parent');
  const localWriter = createLocalChatWriter(store);
  const capability = localWriter.sideConversations;
  if (!capability) throw new Error('Missing local side capability');
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = vi.fn(async (input: CreateSideInput) => {
    const result = await capability.create(input);
    if (create.mock.calls.length === 1) {
      await acknowledgement;
      if (outcome === 'throw') throw new Error('Lost acknowledgement');
      if (outcome === 'error') return { status: 'error' as const, code: 'service_unavailable' };
    }
    return result;
  });
  const writer = { ...localWriter, sideConversations: { ...capability, create } };
  const source = {};
  const props = {
    conversationId: parent.id,
    messages: [],
    hasMoreMessages: false,
    writer,
    isDurable: false,
    onNavigate: vi.fn(),
    onWritten: vi.fn(),
    memory: continuityMemory(source, writer),
    familiarId: 'local',
  };
  return { store, parent, otherParent, props, create, release, source };
}

test.each(['error', 'throw'] as const)(
  'uncertain creation %s survives parent navigation and retries its original key',
  async (outcome) => {
    const current = await fixture(outcome);
    const view = render(<ChatSideConversations key="parent" {...current.props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New retained side note' }));
    await waitFor(() =>
      expect(current.store.listSideConversations(current.parent.id, 50).data).toHaveLength(1),
    );
    view.rerender(
      <ChatSideConversations
        key="other"
        {...current.props}
        conversationId={current.otherParent.id}
      />,
    );
    expect(await screen.findByRole('button', { name: 'New retained side note' })).toBeEnabled();
    await act(async () => current.release());
    view.rerender(<ChatSideConversations key="parent" {...current.props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry retained side note creation' }),
    );
    await waitFor(() => expect(current.props.onNavigate).toHaveBeenCalledOnce());
    expect(current.create.mock.calls[1]?.[0]).toEqual(current.create.mock.calls[0]?.[0]);
    expect(current.store.listSideConversations(current.parent.id, 50).data).toHaveLength(1);
  },
);

test.each(['error', 'ok'] as const)(
  'an in-flight creation remains pending across source remount until its late %s acknowledgement',
  async (outcome) => {
    const current = await fixture(outcome);
    const view = render(<ChatSideConversations key="original" {...current.props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New retained side note' }));
    await waitFor(() => expect(current.create).toHaveBeenCalledOnce());
    view.rerender(
      <ChatSideConversations
        key="other-source"
        {...current.props}
        memory={continuityMemory({}, current.props.writer)}
      />,
    );
    expect(await screen.findByRole('button', { name: 'New retained side note' })).toBeEnabled();
    view.rerender(<ChatSideConversations key="original" {...current.props} />);
    expect(
      await screen.findByRole('button', { name: 'Retry retained side note creation' }),
    ).toBeDisabled();
    await act(async () => current.release());
    expect(current.props.onNavigate).not.toHaveBeenCalled();
    if (outcome === 'ok') {
      expect(await screen.findByRole('button', { name: 'New retained side note' })).toBeEnabled();
      await waitFor(() => expect(current.props.onWritten).toHaveBeenCalledOnce());
    } else {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Retry retained side note creation' }),
      );
      await waitFor(() => expect(current.props.onNavigate).toHaveBeenCalledOnce());
      expect(current.create.mock.calls[1]?.[0]).toEqual(current.create.mock.calls[0]?.[0]);
    }
    expect(current.store.listSideConversations(current.parent.id, 50).data).toHaveLength(1);
  },
);

test('creation references are isolated by exact source, writer, familiar and parent', async () => {
  const current = await fixture('ok');
  const entry = sideCreationMemory(current.props.memory, 'local', current.parent.id);
  entry.update({ operationKey: 'pending-key', pending: true });
  expect(
    sideCreationMemory(
      continuityMemory(current.source, current.props.writer),
      'local',
      current.parent.id,
    ),
  ).toBe(entry);
  for (const other of [
    sideCreationMemory(continuityMemory({}, current.props.writer), 'local', current.parent.id),
    sideCreationMemory(
      continuityMemory(current.source, { ...current.props.writer }),
      'local',
      current.parent.id,
    ),
    sideCreationMemory(current.props.memory, 'other-familiar', current.parent.id),
    sideCreationMemory(current.props.memory, 'local', current.otherParent.id),
  ]) {
    expect(other.getSnapshot().operationKey).toBeNull();
    expect(other.getSnapshot().pending).toBe(false);
  }
});

test.each(['ok', 'error', 'throw'] as const)(
  'a late %s acknowledgement cannot clear or notify for a newer creation request',
  async (outcome) => {
    const current = await fixture(outcome);
    render(<ChatSideConversations {...current.props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New retained side note' }));
    await waitFor(() => expect(current.create).toHaveBeenCalledOnce());
    const entry = sideCreationMemory(current.props.memory, 'local', current.parent.id);
    act(() =>
      entry.update({ operationKey: 'newer-request', pending: true, notice: 'Newer request' }),
    );
    const newer = entry.getSnapshot();
    await act(async () => current.release());
    expect(entry.getSnapshot()).toBe(newer);
    expect(current.props.onNavigate).not.toHaveBeenCalled();
    expect(current.props.onWritten).not.toHaveBeenCalled();
  },
);
