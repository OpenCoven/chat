import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './app';
import { createLocalChatSource } from './lib/local/chat-source';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { BringBackInput } from './lib/local/side-conversations';

async function fixture() {
  const source = await createLocalChatSource({
    backend: createMemoryChatBackend(),
    familiarId: 'local',
  });
  const parent = await source.store.createConversation('Selection parent');
  const side = await source.store.createSideConversation({
    parentConversationId: parent.id,
    operationKey: 'selection-side',
  });
  const messages = [];
  for (let index = 1; index <= 51; index += 1) {
    messages.push(await source.store.appendMessage(side.id, 'user', `Selected message ${index}`));
  }
  const capability = source.writer.sideConversations;
  if (!capability) throw new Error('Missing side capability');
  const prepare = vi.fn(capability.prepareBringBack);
  const bringBack = vi.fn(capability.bringBack);
  const writer = {
    ...source.writer,
    sideConversations: { ...capability, prepareBringBack: prepare, bringBack },
  };
  const owned = { ...source, writer };
  return {
    source,
    parent,
    side,
    messages,
    capability,
    prepare,
    bringBack,
    mount: () =>
      render(
        <App
          localSourceFactory={() => Promise.resolve(owned)}
          desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
        />,
      ),
  };
}

async function openSide() {
  fireEvent.click(await screen.findByRole('button', { name: /^Retained side note/ }));
  await screen.findByRole('checkbox', { name: /Selected message 1$/ });
}

async function reloadSideByNavigation() {
  fireEvent.click(screen.getByRole('button', { name: 'Return to parent' }));
  await screen.findByRole('heading', { name: 'Selection parent' });
  await openSide();
  expect(screen.queryByRole('checkbox', { name: /Selected message 51$/ })).not.toBeInTheDocument();
}

test.each([
  ['fresh', 'partial'],
  ['fresh', 'whole'],
  ['reselected', 'partial'],
  ['reselected', 'whole'],
] as const)(
  '%s review preserves a %s unloaded selection until explicit load or reselection',
  async (phase, missing) => {
    const current = await fixture();
    if (phase === 'reselected')
      current.bringBack.mockResolvedValueOnce({ status: 'error', code: 'not_found' });
    current.mount();
    await openSide();
    if (phase === 'reselected') {
      fireEvent.click(screen.getByRole('checkbox', { name: /Selected message 1$/ }));
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: /Selected message 1$/ })).toBeChecked();
        expect(screen.getByRole('button', { name: 'Review Bring back' })).toBeEnabled();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
      fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
        target: { value: 'Preserved edited excerpt' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Choose available messages' }));
    }
    if (missing === 'partial')
      fireEvent.click(screen.getByRole('checkbox', { name: /Selected message 1$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Selected message 51$/ }));
    await reloadSideByNavigation();
    const previousPreparations = current.prepare.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
    await screen.findByText(/Selected messages are not all loaded/);
    expect(current.prepare).toHaveBeenCalledTimes(previousPreparations);
    if (phase === 'fresh') {
      expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
      expect(await screen.findByRole('checkbox', { name: /Selected message 51$/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /Selected message 1$/ })).toHaveProperty(
        'checked',
        missing === 'partial',
      );
    } else {
      expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(
        'Preserved edited excerpt',
      );
      expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveAttribute('readonly');
      fireEvent.click(screen.getByRole('button', { name: 'Clear message selection' }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Selected message 2$/ }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).not.toHaveAttribute(
        'readonly',
      ),
    );
    const expectedText =
      phase === 'reselected'
        ? 'Preserved edited excerpt'
        : missing === 'partial'
          ? 'Selected message 1\n\nSelected message 51'
          : 'Selected message 51';
    expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(expectedText);
    fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
    await waitFor(() =>
      expect(current.source.store.listMessages(current.parent.id, 50).data).toHaveLength(1),
    );
    const input = current.bringBack.mock.calls.at(-1)?.[0];
    expect(input?.sourceMessageIds).toEqual(
      phase === 'reselected'
        ? [current.messages[1]?.id]
        : missing === 'partial'
          ? [current.messages[0]?.id, current.messages[50]?.id]
          : [current.messages[50]?.id],
    );
    if (phase === 'reselected')
      expect(input?.operationKey).not.toBe(current.bringBack.mock.calls[0]?.[0].operationKey);
  },
);

test('a captured uncertain review reconciles unchanged even when its selected source page is no longer loaded', async () => {
  const current = await fixture();
  let attempt = 0;
  current.bringBack.mockImplementation(async (input: BringBackInput) => {
    const result = await current.capability.bringBack(input);
    return ++attempt === 1 ? { status: 'error', code: 'service_unavailable' } : result;
  });
  current.mount();
  await openSide();
  fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /Selected message 51$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
  await screen.findByRole('textbox', { name: 'Reviewed excerpt' });
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await screen.findByText(/Retry the unchanged review with the same operation key/);
  await reloadSideByNavigation();
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveValue(
    'Selected message 51',
  );
  expect(screen.getByRole('textbox', { name: 'Reviewed excerpt' })).toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument(),
  );
  expect(current.bringBack.mock.calls[1]?.[0]).toEqual(current.bringBack.mock.calls[0]?.[0]);
  expect(current.source.store.listMessages(current.parent.id, 50).data).toHaveLength(1);
});
