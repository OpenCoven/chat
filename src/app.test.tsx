import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';

import { App } from './app';
import type { DesktopHost } from './lib/desktop-host';
import { EMPTY_RECORDS } from './lib/local/chat-records';
import type { LocalChatSource } from './lib/local/chat-source';
import { createChatStore } from './lib/local/chat-store';
import { createLocalChatWriter } from './lib/local/chat-writer';
import { createLocalQueryAdapter, LOCAL_FAMILIAR_ID } from './lib/local/local-query-adapter';
import { createMemoryChatBackend } from './lib/local/memory-backend';
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
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('App', () => {
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
    expect(await screen.findByText('Local chat')).toBeVisible();

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
