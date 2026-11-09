import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Companion } from '../lib/companion';
import { CompanionPanel } from './companion-panel';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
const link = `coven-chat://pair?endpoint=https%3A%2F%2F192.168.1.2%3A8443&token=${'a'.repeat(64)}&fingerprint=${'b'.repeat(64)}`;
function client(): Companion {
  return {
    status: vi.fn().mockResolvedValue({ enabled: false }),
    enable: vi.fn().mockResolvedValue({ enabled: true, pairingLink: link }),
    disable: vi.fn().mockResolvedValue({ enabled: false }),
    forget: vi.fn().mockResolvedValue({ enabled: false }),
  };
}
describe('iPhone companion controls', () => {
  it('loads only on opening, enables, exposes pairing and removes it on close', async () => {
    const api = client();
    render(<CompanionPanel client={api} />);
    expect(api.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'iPhone companion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on companion' }));
    expect(await screen.findByLabelText('Private pairing link')).toHaveValue(link);
    expect(await screen.findByAltText('Scan with Chat on your iPhone')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close companion' }));
    expect(screen.queryByLabelText('Private pairing link')).not.toBeInTheDocument();
    expect(api.disable).not.toHaveBeenCalled();
  });
  it('requires explicit forget confirmation and removes pairing after disable', async () => {
    const api = client();
    api.status = vi.fn().mockResolvedValue({ enabled: true, pairingLink: link });
    render(<CompanionPanel client={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'iPhone companion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget paired phones' }));
    expect(api.forget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await screen.findByRole('button', { name: 'Turn on companion' });
    expect(screen.queryByLabelText('Private pairing link')).not.toBeInTheDocument();
    expect(api.disable).toHaveBeenCalledOnce();
  });
  it('shows failures without claiming the listener is enabled', async () => {
    const api = client();
    api.enable = vi.fn().mockRejectedValue(new Error('No local network is available.'));
    render(<CompanionPanel client={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'iPhone companion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on companion' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No local network'));
    expect(screen.queryByLabelText('Private pairing link')).not.toBeInTheDocument();
  });
});
it('does not restore a stale pairing link from polling after Turn off', async () => {
  vi.useFakeTimers();
  try {
    let finish: (value: { enabled: boolean; pairingLink: string }) => void = () => {};
    const api = client();
    api.status = vi
      .fn()
      .mockResolvedValueOnce({ enabled: true, pairingLink: link })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<CompanionPanel client={api} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'iPhone companion' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    });
    await act(async () => {
      finish({ enabled: true, pairingLink: link });
    });
    expect(screen.queryByLabelText('Private pairing link')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
