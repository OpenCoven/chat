import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';

import { App } from './app';
import type { DesktopHost } from './lib/desktop-host';
import { EMPTY_RECORDS } from './lib/local/chat-records';
import type { LocalChatSource } from './lib/local/chat-source';
import { createChatStore } from './lib/local/chat-store';
import { createLocalChatWriter } from './lib/local/chat-writer';
import { createLocalQueryAdapter, LOCAL_FAMILIAR_ID } from './lib/local/local-query-adapter';
import { createMemoryChatBackend } from './lib/local/memory-backend';
import type { BringBackInput } from './lib/local/side-conversations';
import type { CaveConnectionController } from './lib/sdk/connection-controller';
import type { QueryAdapter } from './lib/sdk/query-adapter';

const INSTALLATION_ID = '0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7';

function createLocalSourceFactory() {
  const store = createChatStore(createMemoryChatBackend(), EMPTY_RECORDS, {
    familiarId: LOCAL_FAMILIAR_ID,
  });
  const source: LocalChatSource = Object.freeze({
    kind: 'local',
    label: 'This device',
    adapter: createLocalQueryAdapter(store),
    writer: createLocalChatWriter(store),
    isDurable: store.isDurable(),
    store,
  });

  return Object.freeze({ store, factory: () => Promise.resolve(source) });
}

function createControllerHarness(
  initialState: CaveConnectionController['getState'] extends () => infer T ? T : never,
) {
  let state = initialState;
  const listeners = new Set<(value: typeof state) => void>();

  const controller = {
    getState: () => state,
    getReadyClient: () =>
      state.state === 'ready'
        ? ({} as NonNullable<ReturnType<CaveConnectionController['getReadyClient']>>)
        : null,
    subscribe: (listener: (value: typeof state) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue(undefined),
    beginPairing: vi.fn().mockResolvedValue(undefined),
    cancelPairing: vi.fn().mockResolvedValue(undefined),
    forgetCredential: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } satisfies CaveConnectionController;

  return Object.freeze({
    controller,
    setState(nextState: typeof state) {
      state = nextState;
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
  });
}

function makeQueryAdapter(): QueryAdapter {
  return {
    listFamiliars: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        data: [{ id: 'familiar-1', displayName: 'Mara', role: 'Guide' }],
      },
    }),
    listProjects: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        data: [
          {
            id: 'project-1',
            name: 'OpenCoven Chat',
            root: '/workspace/chat',
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
        ],
      },
    }),
    listConversations: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        data: [
          {
            id: 'conversation-1',
            familiarId: 'familiar-1',
            title: 'Read-only check-in',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
        ],
      },
    }),
    getConversation: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        id: 'conversation-1',
        familiarId: 'familiar-1',
        title: 'Read-only check-in',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    }),
    listMessages: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        data: [
          {
            id: 'message-1',
            conversationId: 'conversation-1',
            parentId: null,
            role: 'assistant',
            text: 'Hello from Cave.',
            createdAt: '2026-08-25T00:00:00.000Z',
            attachmentCount: 0,
            toolCount: 0,
          },
        ],
      },
    }),
    familiarContract: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    familiarAnalytics: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('App', () => {
  it.each(['parent', 'foreign'])(
    'a late real-store import refreshes the active %s after another write and panel unmount',
    async (destination) => {
      const local = createLocalSourceFactory();
      const parent = await local.store.createConversation('Import parent');
      const other = await local.store.createConversation('Other parent');
      const side = await local.store.createSideConversation({
        parentConversationId: parent.id,
        operationKey: 'seed-side',
      });
      await local.store.appendMessage(side.id, 'user', 'Source text');
      const source = await local.factory();
      const capability = source.writer.sideConversations;
      if (!capability) throw new Error('Missing local side capability');
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bringBack = vi.fn(async (input: BringBackInput) => {
        await delayed;
        return capability.bringBack(input);
      });
      const writer = { ...source.writer, sideConversations: { ...capability, bringBack } };
      const ownedSource = { ...source, writer };
      const controllerFactory = vi.fn();
      render(
        <App
          localSourceFactory={() => Promise.resolve(ownedSource)}
          controllerFactory={controllerFactory}
          desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
        />,
      );
      fireEvent.click(await screen.findByRole('option', { name: /Import parent/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Retained side note/ }));
      fireEvent.click(await screen.findByRole('checkbox', { name: /Source text/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Review Bring back' }));
      fireEvent.change(await screen.findByRole('textbox', { name: 'Reviewed excerpt' }), {
        target: { value: 'Late imported excerpt' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Bring back reviewed excerpt' }));
      await waitFor(() => expect(bringBack).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole('option', { name: /Other parent/ }));
      await screen.findByRole('heading', { name: 'Other parent' });
      const composer = await screen.findByRole('textbox', { name: 'Message' });
      fireEvent.change(composer, { target: { value: 'Other write completed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await within(await screen.findByRole('list', { name: 'Messages' })).findByText(
        'Other write completed',
      );
      expect(local.store.listMessages(other.id, 50).data).toHaveLength(1);
      await waitFor(() =>
        expect(
          within(screen.getByRole('listbox', { name: 'Conversations' })).getAllByRole('option')[0],
        ).toHaveTextContent('Other parent'),
      );
      if (destination === 'parent') {
        fireEvent.click(screen.getByRole('option', { name: /Import parent/ }));
        await screen.findByRole('heading', { name: 'Import parent' });
        await screen.findByRole('button', { name: 'New retained side note' });
      }
      expect(screen.queryByRole('textbox', { name: 'Reviewed excerpt' })).not.toBeInTheDocument();
      expect(screen.queryByText('Late imported excerpt')).not.toBeInTheDocument();
      await act(async () => release());
      await waitFor(() => expect(local.store.listMessages(parent.id, 50).data).toHaveLength(1));
      if (destination === 'parent') {
        expect(await screen.findByText('Late imported excerpt')).toBeVisible();
      } else {
        expect(screen.getByRole('heading', { name: 'Other parent' })).toBeVisible();
        expect(screen.queryByText('Late imported excerpt')).not.toBeInTheDocument();
        await waitFor(() =>
          expect(
            within(screen.getByRole('listbox', { name: 'Conversations' })).getAllByRole(
              'option',
            )[0],
          ).toHaveTextContent('Import parent'),
        );
      }
      expect(controllerFactory).not.toHaveBeenCalled();
    },
  );

  it('owns one local-store subscription for creation, state and append notifications and removes it on unmount', async () => {
    const local = createLocalSourceFactory();
    const parent = await local.store.createConversation('Visible parent');
    const source = await local.factory();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn<typeof local.store.subscribe>((listener) => {
      const stop = local.store.subscribe(listener);
      return () => {
        unsubscribe();
        stop();
      };
    });
    const ownedSource = { ...source, store: { ...local.store, subscribe } };
    const view = render(
      <App
        localSourceFactory={() => Promise.resolve(ownedSource)}
        desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId: vi.fn() }}
      />,
    );
    await screen.findByRole('heading', { name: 'Visible parent' });
    let side!: Awaited<ReturnType<typeof local.store.createSideConversation>>;
    await act(async () => {
      side = await local.store.createSideConversation({
        parentConversationId: parent.id,
        operationKey: 'background-create',
      });
    });
    await screen.findByRole('button', { name: /Retained side note · open/ });
    await act(async () => {
      await local.store.setSideState(
        { parentConversationId: parent.id, sideConversationId: side.id },
        'closed',
      );
    });
    await screen.findByRole('button', { name: /Retained side note · closed/ });
    await act(async () => {
      await local.store.appendMessage(parent.id, 'user', 'Owner-observed append');
    });
    await screen.findByText('Owner-observed append');
    await act(async () => {
      await local.store.createConversation('Background thread');
    });
    await screen.findByRole('option', { name: /Background thread/ });
    expect(screen.getByRole('heading', { name: 'Visible parent' })).toBeVisible();
    expect(subscribe).toHaveBeenCalledOnce();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('local mutation notifications do not refetch the active Cave source', async () => {
    const local = createLocalSourceFactory();
    const parent = await local.store.createConversation('Local parent');
    const harness = createControllerHarness({
      state: 'ready',
      caveInstanceId: 'cave-1',
      covenAvailable: false,
    });
    const adapter = makeQueryAdapter();
    const readInstallationId = vi
      .fn<DesktopHost['readInstallationId']>()
      .mockResolvedValue(INSTALLATION_ID);
    render(
      <App
        localSourceFactory={local.factory}
        controllerFactory={() => harness.controller}
        queryAdapterFactory={() => adapter}
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Cave' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Coven Cave' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Coven Cave' }));
    await screen.findByText('Hello from Cave.');
    const reads = [
      adapter.listFamiliars,
      adapter.listProjects,
      adapter.listConversations,
      adapter.getConversation,
      adapter.listMessages,
    ];
    const counts = reads.map((read) => vi.mocked(read).mock.calls.length);
    await act(async () => {
      await local.store.appendMessage(parent.id, 'user', 'Local background write');
    });
    expect(reads.map((read) => vi.mocked(read).mock.calls.length)).toEqual(counts);
    expect(adapter.invalidate).not.toHaveBeenCalled();
    expect(readInstallationId).toHaveBeenCalledOnce();
    expect(screen.getByText('Hello from Cave.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'This device' }));
    expect(await screen.findByText('Local background write')).toBeVisible();
  });

  it('mounts local chat without touching Cave', async () => {
    const controllerFactory = vi.fn();
    const readInstallationId = vi.fn<DesktopHost['readInstallationId']>();
    const local = createLocalSourceFactory();

    render(
      <App
        controllerFactory={controllerFactory}
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
        localSourceFactory={local.factory}
      />,
    );

    expect(await screen.findByText('This device')).toBeVisible();
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(readInstallationId).not.toHaveBeenCalled();
  });

  it('keeps local chat usable when Tauri commands are unavailable', async () => {
    const controllerFactory = vi.fn();
    const readInstallationId = vi.fn<DesktopHost['readInstallationId']>();
    const local = createLocalSourceFactory();

    render(
      <App
        controllerFactory={controllerFactory}
        desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId }}
        localSourceFactory={local.factory}
      />,
    );

    expect(
      await screen.findByText('Coven Cave needs the desktop app. Local chat works here.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect to Cave' })).toBeNull();
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(readInstallationId).not.toHaveBeenCalled();
  });

  it('writes a local message and shows it without a fabricated reply', async () => {
    const local = createLocalSourceFactory();

    render(
      <App
        desktopIdentityHost={{
          canUseTauriCommands: () => false,
          readInstallationId: vi.fn<DesktopHost['readInstallationId']>(),
        }}
        localSourceFactory={local.factory}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    await screen.findByRole('option', { name: /New conversation/ });

    const input = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: 'first local note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('first local note')).toBeVisible();
    // The harness uses the memory backend, so the app must say so rather than
    // implying the note was saved.
    expect(
      screen.getByText(
        'This device has no available storage, so these messages are kept in memory only and will be lost when the app closes.',
      ),
    ).toBeVisible();
  });

  it('starts Cave only after the user opts in, exactly once in StrictMode', async () => {
    const harness = createControllerHarness({
      state: 'ready',
      caveInstanceId: 'cave-1',
      covenAvailable: false,
    });
    const queryAdapter = makeQueryAdapter();
    const readInstallationId = vi
      .fn<DesktopHost['readInstallationId']>()
      .mockResolvedValue(INSTALLATION_ID);
    const controllerFactory = vi.fn(() => harness.controller);
    const local = createLocalSourceFactory();

    const { unmount } = render(
      <StrictMode>
        <App
          controllerFactory={controllerFactory}
          desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
          localSourceFactory={local.factory}
          queryAdapterFactory={() => queryAdapter}
        />
      </StrictMode>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Cave' }));

    await waitFor(() => {
      expect(harness.controller.start).toHaveBeenCalledTimes(1);
    });
    expect(readInstallationId).toHaveBeenCalledTimes(1);
    expect(controllerFactory).toHaveBeenCalledWith(INSTALLATION_ID);

    fireEvent.click(await screen.findByRole('button', { name: 'Coven Cave' }));
    expect(await screen.findByText('Hello from Cave.')).toBeVisible();

    expect(harness.controller.dispose).not.toHaveBeenCalled();
    expect(queryAdapter.dispose).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => {
      expect(harness.controller.dispose).toHaveBeenCalledTimes(1);
      expect(queryAdapter.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('invalidates query reads and falls back to local when the connection leaves ready', async () => {
    const harness = createControllerHarness({
      state: 'ready',
      caveInstanceId: 'cave-1',
      covenAvailable: false,
    });
    const queryAdapter = makeQueryAdapter();
    const readInstallationId = vi
      .fn<DesktopHost['readInstallationId']>()
      .mockResolvedValue(INSTALLATION_ID);
    const local = createLocalSourceFactory();

    const { unmount } = render(
      <App
        controllerFactory={() => harness.controller}
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
        localSourceFactory={local.factory}
        queryAdapterFactory={() => queryAdapter}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Cave' }));
    await waitFor(() => {
      expect(harness.controller.start).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Coven Cave' }));
    expect(await screen.findByText('Hello from Cave.')).toBeVisible();

    act(() => {
      harness.setState({
        state: 'offline',
        lastHealthyAt: null,
        diagnosticId: 'diag-1',
      });
    });

    await waitFor(() => {
      expect(queryAdapter.invalidate).toHaveBeenCalledTimes(1);
    });
    expect(queryAdapter.dispose).not.toHaveBeenCalled();
    // The Cave view is gone, but the user still has their own chat.
    expect(await screen.findByRole('heading', { name: 'Local chat' })).toBeVisible();

    unmount();
  });

  it('disables Cave pairing but not local chat when the installation identity is unavailable', async () => {
    const harness = createControllerHarness({
      state: 'ready',
      caveInstanceId: 'cave-1',
      covenAvailable: false,
    });
    const readInstallationId = vi
      .fn<DesktopHost['readInstallationId']>()
      .mockResolvedValueOnce('not-a-uuid')
      .mockRejectedValueOnce(new Error('native keyring unavailable'))
      .mockResolvedValueOnce(INSTALLATION_ID);
    const controllerFactory = vi.fn(() => harness.controller);
    const queryAdapterFactory = vi.fn(makeQueryAdapter);
    const local = createLocalSourceFactory();

    render(
      <App
        controllerFactory={controllerFactory}
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
        localSourceFactory={local.factory}
        queryAdapterFactory={queryAdapterFactory}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Cave' }));

    expect(await screen.findByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Secure installation identity unavailable. Retry setup to continue.',
    );
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(queryAdapterFactory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    await waitFor(() => {
      expect(readInstallationId).toHaveBeenCalledTimes(2);
    });
    expect(controllerFactory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep using local chat' }));
    expect(screen.getByRole('button', { name: 'This device' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
