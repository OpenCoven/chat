import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './app';
import type { ChatRecords } from './lib/local/chat-records';
import { createLocalChatSource } from './lib/local/chat-source';
import { createMemoryChatBackend } from './lib/local/memory-backend';

test.each(['conversation', 'message'] as const)(
  'App keeps an unversioned pending %s blocked and copyable until its exact late commit is found',
  async (kind) => {
    const parent = {
      id: 'parent',
      familiarId: 'local',
      title: 'Existing parent',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    };
    const durable = createMemoryChatBackend({ conversations: [parent], messages: [] });
    const { getMutationRevision: _revision, ...unversioned } = durable;
    let delayed: ChatRecords | undefined;
    const commit = vi.fn(async (change: ChatRecords) => {
      delayed = change;
      throw new Error('Acknowledgement lost before the commit finishes');
    });
    const source = await createLocalChatSource({
      familiarId: 'local',
      backend: { ...unversioned, commit },
    });
    render(
      <App
        localSourceFactory={() => Promise.resolve(source)}
        desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
      />,
    );
    await screen.findByRole('heading', { name: 'Existing parent' });
    if (kind === 'message') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Copy this pending message' },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    } else fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile local save' }));
    await screen.findByText(/cannot prove that this save is absent/);
    const content = screen.getByRole('textbox', { name: 'Unresolved save content' });
    expect(content).toHaveValue(
      kind === 'message' ? 'Copy this pending message' : 'New conversation',
    );
    expect(content).toHaveAttribute('readonly');
    expect(content).toBeEnabled();
    const retryWrite = screen.getByRole('button', { name: kind === 'message' ? 'Send' : 'New' });
    expect(retryWrite).toBeDisabled();
    fireEvent.click(retryWrite);
    expect(commit).toHaveBeenCalledOnce();
    if (!delayed) throw new Error('Missing delayed change');
    const pendingChange = delayed;
    await act(async () => {
      await durable.commit(pendingChange);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reconcile local save' })).toBeNull(),
    );
    expect(commit).toHaveBeenCalledOnce();
    const records = await durable.loadAll();
    expect(
      kind === 'message'
        ? records.messages
        : records.conversations.filter((row) => row.title === 'New conversation'),
    ).toHaveLength(1);
  },
);
