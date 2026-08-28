import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';

import { App } from './app';
import type { NativeBoundary } from './lib/sdk/native-boundary';

const AUTHORITY = {
  handle: 'authority:00000000-0000-4000-8000-000000000001',
  generation: 1,
};
const INSTANCE_ID = '00000000-0000-4000-8000-000000000002';

function makeBoundary(overrides: Partial<NativeBoundary> = {}): NativeBoundary {
  return {
    isAvailable: () => true,
    discover: vi.fn().mockResolvedValue(AUTHORITY),
    close: vi.fn().mockResolvedValue(true),
    installationIdentity: vi.fn().mockResolvedValue({
      installationId: '00000000-0000-4000-8000-000000000003',
    }),
    health: vi.fn().mockResolvedValue({
      status: 'ok',
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities: ['health'],
      operations: ['health.read'],
      instanceId: INSTANCE_ID,
      pairingRequired: false,
      releaseVersion: '0.1.0',
    }),
    pairingCreate: vi.fn().mockResolvedValue({
      handle: 'pairing:00000000-0000-4000-8000-000000000004',
      requestId: '00000000-0000-4000-8000-000000000005',
      expiresAt: 2_000_000_000_000,
    }),
    pairingPoll: vi.fn().mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      status: 'approved',
      expiresAt: 2_000_000_000_000,
    }),
    pairingExchange: vi.fn().mockResolvedValue({
      credential: {
        id: '00000000-0000-4000-8000-000000000007',
        appName: 'OpenCoven Chat',
        installationId: '00000000-0000-4000-8000-000000000003',
        scopes: ['chat:read'],
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
        revocationReason: null,
      },
    }),
    credentialState: vi.fn().mockResolvedValue('present'),
    forgetCredential: vi.fn().mockResolvedValue(true),
    listFamiliars: vi.fn().mockResolvedValue({
      data: [{ id: 'familiar-1', displayName: 'Astra', role: 'Research' }],
    }),
    listProjects: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'project-1',
          name: 'OpenCoven',
          root: 'OpenCoven',
          createdAt: '2026-08-28T09:00:00Z',
          updatedAt: '2026-08-28T10:00:00Z',
        },
      ],
    }),
    listConversations: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'conversation-1',
          familiarId: 'familiar-1',
          title: 'Native integration',
          updatedAt: '2026-08-28T11:00:00Z',
        },
      ],
    }),
    getConversation: vi.fn().mockResolvedValue({
      id: 'conversation-1',
      familiarId: 'familiar-1',
      title: 'Native integration',
      updatedAt: '2026-08-28T11:00:00Z',
    }),
    listConversationMessages: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'message-1',
          conversationId: 'conversation-1',
          parentId: null,
          role: 'assistant',
          text: 'Canonical message',
          createdAt: '2026-08-28T11:01:00Z',
          attachmentCount: 0,
          toolCount: 0,
        },
      ],
    }),
    diagnostics: vi.fn().mockResolvedValue({
      version: 1,
      platform: 'darwin',
      architecture: 'aarch64',
      checks: [],
    }),
    listenConnectionEvents: vi.fn().mockResolvedValue(() => undefined),
    ...overrides,
  };
}

describe('App', () => {
  it('shows an explicit unavailable browser fallback without fabricating trust', () => {
    const boundary = makeBoundary({ isAvailable: () => false });

    render(<App nativeHost={boundary} />);

    expect(screen.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent('Offline');
    expect(screen.getByText(/desktop app is required to connect securely/i)).toBeVisible();
    expect(boundary.discover).not.toHaveBeenCalled();
  });

  it('suppresses duplicate StrictMode bootstrap mutations', async () => {
    const boundary = makeBoundary();

    render(
      <StrictMode>
        <App nativeHost={boundary} />
      </StrictMode>,
    );

    expect(await screen.findByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Connected',
    );
    expect(boundary.discover).toHaveBeenCalledTimes(1);
    expect(boundary.listenConnectionEvents).toHaveBeenCalledTimes(1);
  });

  it('guides pairing through explicit approval and completion actions', async () => {
    const boundary = makeBoundary({
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        apiVersion: '1.0',
        minimumClientVersion: '0.1.0',
        capabilities: ['health'],
        operations: ['health.read'],
        instanceId: INSTANCE_ID,
        pairingRequired: true,
        releaseVersion: '0.1.0',
      }),
      credentialState: vi.fn().mockResolvedValueOnce('missing').mockResolvedValue('present'),
    });

    render(<App nativeHost={boundary} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Request approval' }));
    expect(await screen.findByText(/approve this device in Cave/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Check approval' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Complete connection' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Complete connection' }));

    expect(await screen.findByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Connected',
    );
    expect(boundary.pairingExchange).toHaveBeenCalledTimes(1);
  });

  it('renders canonical reads and paginates only on explicit actions', async () => {
    const secondConversation = {
      id: 'conversation-2',
      familiarId: 'familiar-1',
      title: 'Second page',
      updatedAt: '2026-08-28T12:00:00Z',
    };
    const boundary = makeBoundary({
      listConversations: vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              id: 'conversation-1',
              familiarId: 'familiar-1',
              title: 'Native integration',
              updatedAt: '2026-08-28T11:00:00Z',
            },
          ],
          cursor: { current: 'YQ', next: 'Yg', hasMore: true },
        })
        .mockResolvedValueOnce({
          data: [secondConversation],
          cursor: { current: 'Yg', hasMore: false },
        }),
    });

    render(<App nativeHost={boundary} />);

    const conversations = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(within(conversations).getByText('Native integration')).toBeVisible();
    expect(boundary.listConversations).toHaveBeenCalledTimes(1);
    expect(boundary.getConversation).not.toHaveBeenCalled();

    fireEvent.click(within(conversations).getByRole('button', { name: /Native integration/i }));
    expect(await screen.findByText('Canonical message')).toBeVisible();

    fireEvent.click(within(conversations).getByRole('button', { name: 'Load more conversations' }));
    expect(await within(conversations).findByText('Second page')).toBeVisible();
    expect(boundary.listConversations).toHaveBeenCalledTimes(2);
  });

  it('forgets only the local credential and returns to the approval gate', async () => {
    const boundary = makeBoundary();

    render(<App nativeHost={boundary} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Forget this device' }));

    expect(await screen.findByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Approval required',
    );
    expect(boundary.forgetCredential).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/does not revoke it on the service/i)).toBeVisible();
  });

  it('never renders secret-shaped values from rejected native data', async () => {
    const boundary = makeBoundary({
      discover: vi.fn().mockRejectedValue({
        code: 'service_unavailable',
        diagnosticId: '00000000-0000-4000-8000-000000000099',
        retryable: true,
        bearer: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    });
    const { container } = render(<App nativeHost={boundary} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Connection unavailable');
    expect(container.textContent).not.toMatch(
      /Bearer|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/u,
    );
  });
});
