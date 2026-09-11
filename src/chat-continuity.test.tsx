import type { CaveConversationMessage } from '@opencoven/cave-client/managed';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatShell } from './chat-shell';
import { chapterTurnElementId } from './lib/chat-chapters';
import { openChatStore } from './lib/local/chat-store';
import {
  type ChatWriter,
  createLocalChatWriter,
  createReadOnlyChatWriter,
  type WriteResult,
} from './lib/local/chat-writer';
import { createLocalQueryAdapter, LOCAL_FAMILIAR_ID } from './lib/local/local-query-adapter';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { QueryAdapter } from './lib/sdk/query-adapter';

const timestamp = '2026-09-09T00:00:00.000Z';
const conversations = [
  { id: 'a-new', familiarId: 'a', title: 'A newest', updatedAt: timestamp },
  { id: 'a-old', familiarId: 'a', title: 'A older', updatedAt: timestamp },
  { id: 'b', familiarId: 'b', title: 'B exact', updatedAt: timestamp },
];
const ok = <T,>(data: T) => ({ status: 'ok' as const, data });
const message = (id: string): CaveConversationMessage => ({
  id: `${id}-message`,
  conversationId: id,
  text: `${id} text`,
  role: 'user',
  parentId: null,
  createdAt: timestamp,
  attachmentCount: 0,
  toolCount: 0,
});
function source(): QueryAdapter {
  return {
    listFamiliars: vi.fn(async () =>
      ok({
        data: [
          { id: 'a', displayName: 'Same name', role: 'Guide' },
          { id: 'b', displayName: 'Same name', role: 'Guide' },
        ],
      }),
    ),
    listConversations: vi.fn(async () => ok({ data: conversations })),
    listProjects: vi.fn(async () => ok({ data: [] })),
    getConversation: vi.fn(async (id) => {
      const record = conversations.find((item) => item.id === id);
      return record ? ok(record) : { status: 'error' as const, code: 'not_found' };
    }),
    listMessages: vi.fn(async (id) => ok({ data: [message(id)] })),
    familiarContract: vi.fn(),
    familiarAnalytics: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

test('familiar return restores the exact older conversation and anchor, not newest', async () => {
  const adapter = source();
  const view = render(<ChatShell queryAdapter={adapter} />);
  fireEvent.click(await screen.findByRole('option', { name: /A older/ }));
  const anchor = await screen.findByText('a-old text');
  fireEvent.focus(anchor.closest('li') as HTMLElement);
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'b' } });
  await screen.findByText('b text');
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'a' } });
  await screen.findByText('a-old text');
  expect(document.getElementById(chapterTurnElementId('a-old', 'a-old-message'))).toHaveFocus();
  view.unmount();
  render(<ChatShell queryAdapter={adapter} />);
  expect(await screen.findByText('a-old text')).toBeVisible();
});

test.each(['not loaded', 'unavailable'])(
  'a remembered later-page familiar stays represented when its roster entry is %s',
  async (availability) => {
    const adapter = source();
    const other = source();
    const first = { id: 'a', displayName: 'First familiar', role: 'Guide' };
    const later = { id: 'b', displayName: 'Later familiar', role: 'Guide' };
    vi.mocked(adapter.listFamiliars).mockImplementation(async (options) =>
      ok({
        data: options?.cursor ? [later] : [first],
        cursor: options?.cursor
          ? { current: options.cursor, hasMore: false }
          : { hasMore: true, next: 'later' },
      }),
    );
    const view = render(<ChatShell queryAdapter={adapter} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more familiars' }));
    await screen.findByRole('option', { name: 'Later familiar — Guide' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), {
      target: { value: 'b' },
    });
    await screen.findByText('b text');
    view.rerender(<ChatShell queryAdapter={other} />);
    await screen.findByText('a-new text');
    if (availability === 'unavailable') {
      vi.mocked(adapter.listFamiliars).mockResolvedValue(
        ok({ data: [first], cursor: { hasMore: false } }),
      );
      vi.mocked(adapter.getConversation).mockResolvedValue({
        status: 'error',
        code: 'not_found',
      });
    }
    view.rerender(<ChatShell queryAdapter={adapter} />);
    if (availability === 'unavailable') {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'selected conversation is unavailable',
      );
      expect(screen.queryByText('a-new text')).not.toBeInTheDocument();
    } else {
      await screen.findByText('b text');
    }
    const select = screen.getByRole('combobox', { name: 'Familiar' });
    expect(select).toHaveValue('b');
    expect(select.querySelector('option:checked')).toHaveTextContent(
      `Saved familiar b — ${availability}`,
    );
    if (availability === 'not loaded') {
      fireEvent.click(screen.getByRole('button', { name: 'Load more familiars' }));
      await screen.findByRole('option', { name: 'Later familiar — Guide' });
      expect(select).toHaveValue('b');
      expect(select.querySelector('option:checked')).toHaveTextContent('Later familiar — Guide');
      expect(screen.queryByRole('option', { name: /Saved familiar/ })).not.toBeInTheDocument();
      expect(screen.getByText('b text')).toBeVisible();
    }
  },
);

test('source and writer changes quarantine drafts and late send outcomes', async () => {
  const adapter = source();
  const other = source();
  let resolve!: (value: WriteResult<CaveConversationMessage>) => void;
  const writer: ChatWriter = {
    canWrite: () => true,
    createConversation: vi.fn(),
    sendMessage: vi.fn(
      () =>
        new Promise<WriteResult<CaveConversationMessage>>((done) => {
          resolve = done;
        }),
    ),
  };
  const view = render(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByText('a-new text');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'first source draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  view.rerender(<ChatShell queryAdapter={other} writer={writer} />);
  await screen.findByText('a-new text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'second source draft' },
  });
  await act(async () => resolve({ status: 'error', code: 'service_unavailable' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('second source draft');
  view.rerender(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByText('a-new text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('first source draft');
  expect(screen.getByRole('alert')).toHaveTextContent('could not be saved');
  view.rerender(<ChatShell queryAdapter={adapter} writer={{ ...writer }} />);
  await screen.findByText('a-new text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

test('missing remembered conversations and anchors never silently choose latest', async () => {
  const adapter = source();
  const view = render(<ChatShell queryAdapter={adapter} />);
  fireEvent.click(await screen.findByRole('option', { name: /A older/ }));
  fireEvent.focus((await screen.findByText('a-old text')).closest('li') as HTMLElement);
  view.unmount();
  vi.mocked(adapter.getConversation).mockResolvedValue({ status: 'error', code: 'not_found' });
  const next = render(<ChatShell queryAdapter={adapter} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'selected conversation is unavailable',
  );
  expect(screen.queryByText('a-new text')).not.toBeInTheDocument();
  next.unmount();
  const older = conversations[1];
  if (!older) throw new Error('Missing older fixture');
  vi.mocked(adapter.getConversation).mockResolvedValue(ok(older));
  vi.mocked(adapter.listMessages).mockResolvedValue(ok({ data: [] }));
  render(<ChatShell queryAdapter={adapter} />);
  expect(await screen.findByText(/saved message is unavailable/)).toBeVisible();
});

test('production local side notes preserve parent draft and import only the edited review', async () => {
  const store = await openChatStore({
    familiarId: LOCAL_FAMILIAR_ID,
    backend: createMemoryChatBackend(),
  });
  const parent = await store.createConversation('Exact parent');
  const writer = createLocalChatWriter(store);
  const adapter = createLocalQueryAdapter(store);
  render(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByRole('button', { name: 'New retained side note' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'unsent parent draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'New retained side note' }));
  await screen.findByRole('button', { name: 'Close note' });
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'raw side text' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /raw side text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
    target: { value: 'only reviewed text' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(store.listMessages(parent.id, 50).data.map((entry) => entry.text)).toEqual([
      'only reviewed text',
    ]),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Close note' }));
  expect(await screen.findByText('only reviewed text')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('unsent parent draft');
  expect(screen.queryByText('raw side text')).not.toBeInTheDocument();
});

test('Cave refuses side mutations rather than offering a local fallback', async () => {
  render(<ChatShell queryAdapter={source()} writer={createReadOnlyChatWriter()} />);
  expect(await screen.findByText(/Side chats and Bring back are unavailable/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'New retained side note' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(
    screen.getByText(
      'Import provenance is unavailable through this installed SDK. Messages are displayed as read-only text.',
    ),
  ).toBeVisible();
});

test('a mismatched write receipt cannot clear the exact-thread draft', async () => {
  const writer: ChatWriter = {
    canWrite: () => true,
    createConversation: vi.fn(),
    sendMessage: vi.fn(async () => ok(message('b'))),
  };
  render(<ChatShell queryAdapter={source()} writer={writer} />);
  await screen.findByText('a-new text');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'keep this draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'did not match this exact conversation',
  );
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('keep this draft');
});

test('each familiar keeps its own draft while a saved older chat remains off the root page', async () => {
  const adapter = source();
  const writer: ChatWriter = {
    canWrite: () => true,
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
  };
  const view = render(<ChatShell queryAdapter={adapter} writer={writer} />);
  fireEvent.click(await screen.findByRole('option', { name: /A older/ }));
  await screen.findByText('a-old text');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'draft a' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'b' } });
  await screen.findByText('b text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'draft b' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'a' } });
  await screen.findByText('a-old text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft a');
  view.unmount();
  vi.mocked(adapter.listConversations).mockResolvedValue(
    ok({ data: conversations.filter((record) => record.id !== 'a-old') }),
  );
  render(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByText('a-old text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft a');
});

test('producer replacement behind the same adapter cannot reuse another source selection', async () => {
  const adapter = source();
  let identity = {};
  adapter.getSourceIdentity = () => identity;
  const view = render(<ChatShell queryAdapter={adapter} />);
  fireEvent.click(await screen.findByRole('option', { name: /A older/ }));
  await screen.findByText('a-old text');
  identity = {};
  view.rerender(<ChatShell queryAdapter={adapter} />);
  expect(await screen.findByText('a-new text')).toBeVisible();
  expect(screen.queryByText('a-old text')).not.toBeInTheDocument();
});

test('a wrong-familiar exact record is refused before the composer can write', async () => {
  const adapter = source();
  vi.mocked(adapter.getConversation).mockResolvedValue(
    ok({
      id: 'a-new',
      familiarId: 'another',
      title: 'Foreign record',
      updatedAt: timestamp,
    }),
  );
  const writer: ChatWriter = {
    canWrite: () => true,
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
  };
  render(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  expect(screen.queryByText('a-new text')).not.toBeInTheDocument();
  expect(writer.sendMessage).not.toHaveBeenCalled();
});

test('returning before a pending save completes refreshes only that exact thread and submits once', async () => {
  const adapter = source();
  let resolve!: (value: WriteResult<CaveConversationMessage>) => void;
  const writer: ChatWriter = {
    canWrite: () => true,
    createConversation: vi.fn(),
    sendMessage: vi.fn(
      () =>
        new Promise<WriteResult<CaveConversationMessage>>((done) => {
          resolve = done;
        }),
    ),
  };
  render(<ChatShell queryAdapter={adapter} writer={writer} />);
  await screen.findByText('a-new text');
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'pending note' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(writer.sendMessage).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'b' } });
  await screen.findByText('b text');
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), { target: { value: 'a' } });
  await screen.findByText('a-new text');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  vi.mocked(adapter.listMessages).mockImplementation(async (id) =>
    ok({
      data: [message(id), { ...message(id), id: 'saved', text: 'pending note' }],
    }),
  );
  await act(async () => resolve(ok(message('a-new'))));
  expect(await screen.findByText('pending note')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});
