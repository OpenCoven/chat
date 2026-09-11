import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './app';
import { continuityMemory, sideReviewMemory } from './lib/chat-continuity';
import type { ChatBackend } from './lib/local/chat-records';
import { createLocalChatSource } from './lib/local/chat-source';
import { openChatStore } from './lib/local/chat-store';
import { createMemoryChatBackend } from './lib/local/memory-backend';

async function fixture() {
  const backend = createMemoryChatBackend();
  let armed = false;
  let blocked = false;
  const failing: ChatBackend = {
    ...backend,
    commit: async (change) => {
      await backend.commit(change);
      if (armed) {
        armed = false;
        blocked = true;
      }
    },
    getMutationRevision: async () => {
      if (blocked) throw new Error('post-commit read failed');
      return backend.getMutationRevision?.() ?? 0;
    },
  };
  const source = await createLocalChatSource({ backend: failing, familiarId: 'local' });
  const parent = await source.store.createConversation('Recovery parent');
  const create = vi.fn(source.writer.createConversation);
  const send = vi.fn(source.writer.sendMessage);
  const owned = {
    ...source,
    writer: { ...source.writer, createConversation: create, sendMessage: send },
  };
  return {
    source: owned,
    parent,
    backend,
    create,
    send,
    arm: () => {
      armed = true;
    },
    allowReads: () => {
      blocked = false;
    },
    mount: () =>
      render(
        <App
          localSourceFactory={() => Promise.resolve(owned)}
          desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
        />,
      ),
  };
}

test('a committed message discarded externally remains copyable until explicit dismissal without resubmitting', async () => {
  const current = await fixture();
  const side = await current.source.store.createSideConversation({
    parentConversationId: current.parent.id,
    operationKey: 'discard-after-commit',
  });
  current.mount();
  fireEvent.click(await screen.findByRole('button', { name: /Retained side note · open/ }));
  const composer = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'Saved before the discard' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  current.arm();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/The message was saved, but local history/);
  await act(async () => {
    const other = await openChatStore({ backend: current.backend, familiarId: 'local' });
    await other.setSideState(
      { parentConversationId: current.parent.id, sideConversationId: side.id },
      'discarded',
    );
  });
  current.allowReads();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' })),
  );
  const saved = await screen.findByRole('textbox', { name: 'Unavailable saved content' });
  expect(saved).toHaveValue('Saved before the discard');
  expect(saved).toHaveAttribute('readonly');
  expect(saved).not.toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(current.send).toHaveBeenCalledOnce();
  expect((await current.backend.loadAll()).messages).toEqual([]);
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss unavailable save' })),
  );
  expect(screen.queryByRole('textbox', { name: 'Unavailable saved content' })).toBeNull();
  expect(current.send).toHaveBeenCalledOnce();
  expect((await current.backend.loadAll()).messages).toEqual([]);
});

test.each([
  ['conversation', 'no-commit'],
  ['message', 'no-commit'],
  ['conversation', 'missing-availability'],
  ['message', 'missing-availability'],
  ['conversation', 'inconsistent-availability'],
  ['message', 'inconsistent-availability'],
] as const)(
  'App rejects a %s recovery with %s even with an exact receipt',
  async (kind, problem) => {
    const current = await fixture();
    const reconcile = current.source.writer.reconcileWrite;
    if (!reconcile) throw new Error('Missing reconciliation capability');
    const contradictory = vi
      .spyOn(current.source.writer, 'reconcileWrite')
      .mockImplementation(async (id) => {
        const result = await reconcile(id);
        if (result.status !== 'ok') return result;
        if (problem === 'no-commit')
          return {
            status: 'ok',
            data: {
              receipt: result.data.receipt,
              outcome: 'not_committed',
              availability: 'absent',
            },
          };
        const data = { ...result.data };
        if (problem === 'missing-availability') Reflect.deleteProperty(data, 'availability');
        else Reflect.set(data, 'availability', 'absent');
        return { status: 'ok', data };
      });
    current.mount();
    await screen.findByRole('heading', { name: 'Recovery parent' });
    current.arm();
    if (kind === 'message') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Already committed' },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    } else fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByText(new RegExp(`The ${kind} was saved, but local history`));
    current.allowReads();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await screen.findByText(/Local history could not be reconciled/);
    expect(
      screen.getByRole('button', { name: kind === 'message' ? 'Send' : 'New' }),
    ).toBeDisabled();
    if (kind === 'message')
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Already committed');
    contradictory.mockRestore();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' })),
    );
    expect(screen.queryByRole('button', { name: 'Reconcile local save' })).toBeNull();
  },
);

test.each(['conversation', 'message'] as const)(
  'App reconciles a known committed %s after a refresh failure without submitting again',
  async (kind) => {
    const current = await fixture();
    current.mount();
    await screen.findByRole('heading', { name: 'Recovery parent' });
    current.arm();
    if (kind === 'message') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Saved exactly once' },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(current.send).toHaveBeenCalledOnce());
    } else fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByText(new RegExp(`The ${kind} was saved, but local history`));
    const action = screen.getByRole('button', { name: kind === 'message' ? 'Send' : 'New' });
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await screen.findByText(/Local history could not be reconciled/);
    expect(action).toBeDisabled();
    current.allowReads();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reconcile local save' })).toBeNull(),
    );
    if (kind === 'message') {
      expect(current.send).toHaveBeenCalledOnce();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
      expect(
        within(screen.getByRole('list', { name: 'Messages' })).getByText('Saved exactly once'),
      ).toBeVisible();
      expect((await current.backend.loadAll()).messages).toHaveLength(1);
    } else {
      expect(current.create).toHaveBeenCalledOnce();
      expect(await screen.findByRole('option', { name: /New conversation/ })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Recovery parent' })).toBeVisible();
      expect((await current.backend.loadAll()).conversations).toHaveLength(2);
    }
  },
);

test.each([
  { kind: 'message', field: 'familiarId' },
  { kind: 'message', field: 'conversationId' },
  { kind: 'message', field: 'parentId' },
  { kind: 'message', field: 'text' },
  { kind: 'message', field: 'createdAt' },
  { kind: 'message', field: 'role' },
  { kind: 'conversation', field: 'familiarId' },
  { kind: 'conversation', field: 'title' },
  { kind: 'conversation', field: 'createdAt' },
] as const)(
  'App keeps $kind recovery blocked when a matching receipt ID has a different $field',
  async ({ kind, field }) => {
    const current = await fixture();
    const reconcile = current.source.writer.reconcileWrite;
    if (!reconcile) throw new Error('Missing recovery capability');
    const mismatched = vi
      .spyOn(current.source.writer, 'reconcileWrite')
      .mockImplementation(async (id) => {
        const result = await reconcile(id);
        if (result.status !== 'ok') return result;
        const receipt = result.data.receipt;
        return {
          ...result,
          data: {
            ...result.data,
            receipt:
              field === 'role'
                ? { ...receipt, role: 'assistant' }
                : { ...receipt, [field]: 'different receipt value' },
          },
        };
      });
    current.mount();
    await screen.findByRole('heading', { name: 'Recovery parent' });
    current.arm();
    if (kind === 'message') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Keep the exact recovery draft' },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    } else fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByText(new RegExp(`The ${kind} was saved, but local history`));
    current.allowReads();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await screen.findByText(/Local history could not be reconciled/);
    expect(
      screen.getByRole('button', { name: kind === 'message' ? 'Send' : 'New' }),
    ).toBeDisabled();
    if (kind === 'message') {
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
        'Keep the exact recovery draft',
      );
      expect(current.send).toHaveBeenCalledOnce();
    } else expect(current.create).toHaveBeenCalledOnce();
    mismatched.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local save' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reconcile local save' })).toBeNull(),
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    const records = await current.backend.loadAll();
    expect(kind === 'message' ? records.messages : records.conversations).toHaveLength(
      kind === 'message' ? 1 : 2,
    );
  },
);

test.each(['rejected', 'uncertain'] as const)(
  'App keeps the exact %s review copyable after external discard makes the selected side unavailable',
  async (phase) => {
    const current = await fixture();
    const side = await current.source.store.createSideConversation({
      parentConversationId: current.parent.id,
      operationKey: 'review-side',
    });
    await current.source.store.appendMessage(side.id, 'user', 'Original source');
    const capability = current.source.writer.sideConversations;
    if (!capability) throw new Error('Missing local side capability');
    const bringBack = vi.fn(async (input: Parameters<typeof capability.bringBack>[0]) => {
      if (phase === 'uncertain') await capability.bringBack(input);
      return {
        status: 'error' as const,
        code: phase === 'rejected' ? 'stale_review' : 'service_unavailable',
      };
    });
    const owned = {
      ...current.source,
      writer: {
        ...current.source.writer,
        sideConversations: { ...capability, bringBack },
      },
    };
    render(
      <App
        localSourceFactory={() => Promise.resolve(owned)}
        desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Retained side note · open/ }));
    const selectedSource = await screen.findByRole('checkbox', { name: /Original source/ });
    fireEvent.click(selectedSource);
    await waitFor(() => expect(selectedSource).toBeChecked());
    const prepare = screen.getByRole('button', { name: 'Review Bring back' });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
      target: { value: 'Keep my carefully edited excerpt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
    await screen.findByText(
      phase === 'rejected'
        ? /reviewed local branch changed/
        : /import result could not be confirmed/,
    );
    const other = await openChatStore({ familiarId: 'local', backend: current.backend });
    await other.setSideState(
      { parentConversationId: current.parent.id, sideConversationId: side.id },
      'discarded',
    );
    await act(async () => {
      await current.source.store.createConversation('Another local write');
    });
    const excerpt = await screen.findByRole('textbox', { name: 'Unavailable reviewed excerpt' });
    expect(excerpt).toHaveValue('Keep my carefully edited excerpt');
    expect(excerpt).toHaveAttribute('readonly');
    expect(excerpt).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Bring back reviewed excerpt' })).toBeNull();
    expect(bringBack).toHaveBeenCalledOnce();
    const memory = continuityMemory(current.source.store, owned.writer);
    expect(sideReviewMemory(memory, 'local', current.parent.id, side.id).getSnapshot().review).toBe(
      bringBack.mock.calls[0]?.[0],
    );
    expect(screen.queryByRole('heading', { name: 'Recovery parent' })).toBeNull();
    const cancel = screen.getByRole('button', { name: 'Cancel unavailable review' });
    if (phase === 'uncertain') {
      expect(cancel).toBeDisabled();
      fireEvent.click(cancel);
      expect(excerpt).toHaveValue('Keep my carefully edited excerpt');
      expect(
        sideReviewMemory(memory, 'local', current.parent.id, side.id).getSnapshot().review,
      ).toBe(bringBack.mock.calls[0]?.[0]);
      expect(
        within(screen.getByRole('region', { name: 'Unavailable local review' })).queryByText(
          /Retry the unchanged review/,
        ),
      ).toBeNull();
      expect(current.source.store.listMessages(current.parent.id, 50).data).toHaveLength(1);
    } else {
      fireEvent.click(cancel);
      expect(screen.queryByRole('textbox', { name: 'Unavailable reviewed excerpt' })).toBeNull();
    }
  },
);
