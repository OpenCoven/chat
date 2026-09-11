import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatShell } from './chat-shell';
import { continuityMemory, sideReviewMemory } from './lib/chat-continuity';
import { EMPTY_RECORDS } from './lib/local/chat-records';
import { createChatStore } from './lib/local/chat-store';
import {
  type ChatWriter,
  createLocalChatWriter,
  createReadOnlyChatWriter,
} from './lib/local/chat-writer';
import { createLocalQueryAdapter } from './lib/local/local-query-adapter';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { BringBackInput } from './lib/local/side-conversations';

async function fixture() {
  const backend = createMemoryChatBackend();
  let id = 0;
  const store = createChatStore(backend, EMPTY_RECORDS, {
    familiarId: 'local',
    createId: () => `id-${++id}`,
  });
  const parent = await store.createConversation('Exact local parent');
  const side = await store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'create-side',
  });
  await store.appendMessage(side.id, 'user', 'source text');
  return {
    store,
    parent,
    side,
    adapter: createLocalQueryAdapter(store),
    writer: createLocalChatWriter(store),
  };
}

async function openSide() {
  fireEvent.click(await screen.findByRole('button', { name: /Retained side note · open/ }));
  await screen.findByRole('button', { name: 'Return to parent' });
}

test('in-flight review survives source unmount and remount without releasing its operation key', async () => {
  const first = await fixture();
  const other = await fixture();
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: BringBackInput[] = [];
  const local = first.writer.sideConversations;
  if (!local) throw new Error('Missing local capability');
  const writer: ChatWriter = {
    ...first.writer,
    sideConversations: {
      ...local,
      async bringBack(input) {
        attempts.push(input);
        const result = await local.bringBack(input);
        if (attempts.length === 1) {
          await acknowledgement;
          return { status: 'error', code: 'service_unavailable' };
        }
        return result;
      },
    },
  };
  const view = render(<ChatShell queryAdapter={first.adapter} writer={writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
    target: { value: 'exact edited excerpt' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() => expect(first.store.listMessages(first.parent.id, 10).data).toHaveLength(1));
  expect(attempts[0]?.preconditions).toEqual({
    parentRevision: 0,
    parentLeafId: null,
    sideRevision: 1,
    sideLeafId: 'id-3',
  });
  view.rerender(<ChatShell queryAdapter={other.adapter} writer={other.writer} />);
  await openSide();
  expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
  view.rerender(<ChatShell queryAdapter={first.adapter} writer={writer} />);
  await openSide();
  const review = await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  expect(review).toHaveValue('exact edited excerpt');
  expect(review).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Bring back reviewed excerpt' })).toBeDisabled();
  await act(async () => release());
  expect(await screen.findByText(/Retry uses the same operation key/)).toBeVisible();
  expect(review).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument(),
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(first.store.listMessages(first.parent.id, 10).data).toHaveLength(1);
  expect(other.store.listMessages(other.parent.id, 10).data).toHaveLength(0);
});

test('review references are partitioned by source, writer, familiar, parent and side', () => {
  const source = {};
  const writer = createReadOnlyChatWriter();
  const memory = continuityMemory(source, writer);
  const entry = sideReviewMemory(memory, 'familiar', 'parent', 'side');
  entry.update({
    selected: ['message'],
    review: {
      parentConversationId: 'parent',
      sideConversationId: 'side',
      sourceMessageIds: ['message'],
      operationKey: 'stable-key',
      excerpt: 'edited text',
      preconditions: {
        parentRevision: 4,
        parentLeafId: 'leaf',
        sideRevision: 2,
        sideLeafId: 'message',
      },
    },
    phase: 'uncertain',
  });
  expect(sideReviewMemory(continuityMemory(source, writer), 'familiar', 'parent', 'side')).toBe(
    entry,
  );
  const others = [
    sideReviewMemory(continuityMemory({}, writer), 'familiar', 'parent', 'side'),
    sideReviewMemory(
      continuityMemory(source, createReadOnlyChatWriter()),
      'familiar',
      'parent',
      'side',
    ),
    sideReviewMemory(memory, 'other-familiar', 'parent', 'side'),
    sideReviewMemory(memory, 'familiar', 'other-parent', 'side'),
    sideReviewMemory(memory, 'familiar', 'parent', 'other-side'),
  ];
  for (const other of others) expect(other.getSnapshot().review).toBeNull();
});

test('explicit cancellation clears a review without writing an import', async () => {
  const current = await fixture();
  render(<ChatShell queryAdapter={current.adapter} writer={current.writer} />);
  await openSide();
  fireEvent.click(screen.getByRole('checkbox', { name: /source text/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return to parent' }));
  await openSide();
  expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
  expect(current.store.listMessages(current.parent.id, 10).data).toHaveLength(0);
});
