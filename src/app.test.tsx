import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';

import { App } from './app';
import type { DesktopHost } from './lib/desktop-host';
import type { CaveConnectionController } from './lib/sdk/connection-controller';
import type { QueryAdapter } from './lib/sdk/query-adapter';

const INSTALLATION_ID = '0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7';

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
  it('renders the production browser fallback without creating a controller', () => {
    const controllerFactory = vi.fn();
    const readInstallationId = vi.fn<DesktopHost['readInstallationId']>();

    render(
      <App
        desktopIdentityHost={{ canUseTauriCommands: () => false, readInstallationId }}
        controllerFactory={controllerFactory}
      />,
    );

    expect(screen.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Cave connection requires the desktop app. Open in the OpenCoven app to connect.',
    );
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(readInstallationId).not.toHaveBeenCalled();
  });

  it('bootstraps the controller with the native installation ID exactly once in StrictMode', async () => {
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
    const { unmount } = render(
      <StrictMode>
        <App
          desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
          controllerFactory={controllerFactory}
          queryAdapterFactory={() => queryAdapter}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(harness.controller.start).toHaveBeenCalledTimes(1);
    });
    await screen.findByText('Hello from Cave.');
    expect(readInstallationId).toHaveBeenCalledTimes(1);
    expect(controllerFactory).toHaveBeenCalledWith(INSTALLATION_ID);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(harness.controller.dispose).not.toHaveBeenCalled();
    expect(queryAdapter.dispose).not.toHaveBeenCalled();

    unmount();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(harness.controller.dispose).toHaveBeenCalledTimes(1);
    expect(queryAdapter.dispose).toHaveBeenCalledTimes(1);
  });

  it('invalidates query reads when the connection leaves ready without disposing the adapter', async () => {
    const harness = createControllerHarness({
      state: 'ready',
      caveInstanceId: 'cave-1',
      covenAvailable: false,
    });
    const queryAdapter = makeQueryAdapter();
    const readInstallationId = vi
      .fn<DesktopHost['readInstallationId']>()
      .mockResolvedValue(INSTALLATION_ID);
    const { unmount } = render(
      <App
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
        controllerFactory={() => harness.controller}
        queryAdapterFactory={() => queryAdapter}
      />,
    );

    await waitFor(() => {
      expect(harness.controller.start).toHaveBeenCalledTimes(1);
    });
    await screen.findByText('Hello from Cave.');

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
    expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Cave offline. Retry the connection or start Cave.',
    );

    unmount();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
  });

  it('rejects malformed and failed installation bootstrap reads before retrying', async () => {
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

    render(
      <App
        desktopIdentityHost={{ canUseTauriCommands: () => true, readInstallationId }}
        controllerFactory={controllerFactory}
        queryAdapterFactory={queryAdapterFactory}
      />,
    );

    expect(await screen.findByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Secure installation identity unavailable. Retry setup to continue.',
    );
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(queryAdapterFactory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));

    await waitFor(() => {
      expect(readInstallationId).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
        'Secure installation identity unavailable. Retry setup to continue.',
      );
    });
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(queryAdapterFactory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));

    await waitFor(() => {
      expect(readInstallationId).toHaveBeenCalledTimes(3);
      expect(controllerFactory).toHaveBeenCalledWith(INSTALLATION_ID);
      expect(queryAdapterFactory).toHaveBeenCalledTimes(1);
      expect(harness.controller.start).toHaveBeenCalledTimes(1);
    });
  });
});
