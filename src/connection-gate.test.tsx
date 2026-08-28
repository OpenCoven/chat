import { fireEvent, render, screen } from '@testing-library/react';

import { ConnectionGate } from './connection-gate';

function makeController() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue(undefined),
    beginPairing: vi.fn().mockResolvedValue(undefined),
    cancelPairing: vi.fn().mockResolvedValue(undefined),
    forgetCredential: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ConnectionGate', () => {
  it('maps idle, pairing, offline, incompatible, and revoked actions to controller methods', () => {
    const idle = makeController();
    const pairingRequired = makeController();
    const pairing = makeController();
    const offline = makeController();
    const incompatible = makeController();
    const revoked = makeController();

    const { rerender } = render(<ConnectionGate controller={idle} state={{ state: 'idle' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start connection' }));
    expect(idle.start).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={pairingRequired}
        state={{ state: 'pairing_required', caveInstanceId: 'cave-1' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pair with Cave' }));
    expect(pairingRequired.beginPairing).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={pairing}
        state={{ state: 'pairing', requestId: 'request-1', expiresAt: Date.now() + 1_000 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(pairing.cancelPairing).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={offline}
        state={{ state: 'offline', lastHealthyAt: null, diagnosticId: 'diag-1' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(offline.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start Cave' }));
    expect(offline.launch).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={incompatible}
        state={{ state: 'incompatible', diagnosticId: 'diag-incompatible' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry after update/restart' }));
    expect(incompatible.retry).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate controller={revoked} state={{ state: 'revoked', diagnosticId: 'diag-2' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Forget access' }));
    expect(revoked.forgetCredential).toHaveBeenCalledTimes(1);
  });

  it('maps scope_denied to forgetting access', () => {
    const controller = makeController();

    render(
      <ConnectionGate
        controller={controller}
        state={{ state: 'error', code: 'scope_denied', diagnosticId: 'diag-3' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Forget access' }));
    expect(controller.forgetCredential).toHaveBeenCalledTimes(1);
  });

  it('renders distinct initial, cancelled, expired, denied, and rate-limited recovery actions', () => {
    const initial = makeController();
    const cancelled = makeController();
    const expired = makeController();
    const denied = makeController();
    const rateLimited = makeController();
    const { rerender } = render(
      <ConnectionGate
        controller={initial}
        state={{ state: 'pairing_required', caveInstanceId: 'cave-1' }}
      />,
    );

    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Cave is ready to pair. Grant read-only chat access to continue.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pair with Cave' }));
    expect(initial.beginPairing).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={cancelled}
        state={{
          state: 'pairing_required',
          caveInstanceId: 'cave-1',
          reason: 'cancelled',
        }}
      />,
    );
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Pairing cancelled. Pair again when you are ready.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pair with Cave' }));
    expect(cancelled.beginPairing).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={expired}
        state={{
          state: 'pairing_required',
          caveInstanceId: 'cave-1',
          reason: 'expired',
        }}
      />,
    );
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Pairing request expired. Start a new pairing request.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pair with Cave' }));
    expect(expired.beginPairing).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={denied}
        state={{ state: 'error', code: 'pairing_denied', diagnosticId: 'diag-denied' }}
      />,
    );
    expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Unable to connect to Cave (pairing_denied).',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(denied.retry).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectionGate
        controller={rateLimited}
        state={{ state: 'error', code: 'rate_limited', diagnosticId: 'diag-rate' }}
      />,
    );
    expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Cave is rate limited. Wait briefly, then retry.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(rateLimited.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start Cave' })).toBeNull();
    expect(rateLimited.launch).not.toHaveBeenCalled();
  });

  it('renders a browser fallback explanation without calling native actions', () => {
    const controller = makeController();

    render(<ConnectionGate controller={controller} state={{ state: 'browser_preview' }} />);

    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Cave connection requires the desktop app. Open in the OpenCoven app to connect.',
    );
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.retry).not.toHaveBeenCalled();
    expect(controller.launch).not.toHaveBeenCalled();
    expect(controller.beginPairing).not.toHaveBeenCalled();
    expect(controller.cancelPairing).not.toHaveBeenCalled();
    expect(controller.forgetCredential).not.toHaveBeenCalled();
  });

  it('uses the shared gate for installation bootstrap and retries only on request', () => {
    const retryInstallationBootstrap = vi.fn();
    const { rerender } = render(<ConnectionGate state={{ state: 'installation_initializing' }} />);

    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      'Preparing secure installation identity...',
    );
    expect(screen.queryByRole('button', { name: 'Retry setup' })).toBeNull();

    rerender(
      <ConnectionGate
        state={{ state: 'installation_unavailable' }}
        onInstallationRetry={retryInstallationBootstrap}
      />,
    );

    expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Secure installation identity unavailable. Retry setup to continue.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    expect(retryInstallationBootstrap).toHaveBeenCalledTimes(1);
  });

  it('explains how to recover from an incompatible Cave version', () => {
    render(<ConnectionGate state={{ state: 'incompatible', diagnosticId: 'diag-4' }} />);

    expect(screen.getByRole('alert', { name: 'Connection state' })).toHaveTextContent(
      'Cave version incompatible. Update or restart Cave, then retry the connection.',
    );
  });

  it('renders children once the connection is ready', () => {
    render(
      <ConnectionGate state={{ state: 'ready', caveInstanceId: 'cave-1', covenAvailable: false }}>
        <div>Read-only thread</div>
      </ConnectionGate>,
    );

    expect(screen.getByText('Read-only thread')).toBeVisible();
  });
});
