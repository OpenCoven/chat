import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenChannel, ScreenRelay } from '../lib/screen-relay';
import { endedText, type RfbClass, ScreenViewer } from './screen-viewer';

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  viewOnly = false;
  scaleViewport = false;
  background = '';
  disconnect = vi.fn();
  sendCredentials = vi.fn();
  constructor(
    public target: HTMLElement,
    public channel: unknown,
    public options: unknown,
  ) {
    super();
    FakeRfb.instances.push(this);
  }
  emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function fakeRelay(available = true) {
  const channels: ScreenChannel[] = [];
  const relay: ScreenRelay = {
    available,
    open(url) {
      const channel = {
        url,
        binaryType: 'arraybuffer',
        protocol: '',
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        lastError: '',
        send: vi.fn(),
        close: vi.fn(),
      } as unknown as ScreenChannel & { url: string; close: ReturnType<typeof vi.fn> };
      channels.push(channel);
      return channel;
    },
  };
  return { relay, channels };
}

function renderViewer(relay: ScreenRelay | undefined) {
  FakeRfb.instances = [];
  const rfbs = FakeRfb.instances;
  const loadRfb = async () => FakeRfb as unknown as RfbClass;
  const onClose = vi.fn();
  const view = render(
    <ScreenViewer relay={relay} familiarName="Astra" onClose={onClose} loadRfb={loadRfb} />,
  );
  return { view, rfbs, onClose };
}

async function connectTo(address: string) {
  fireEvent.change(screen.getByLabelText('Screen address'), { target: { value: address } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  });
}

describe('endedText', () => {
  it('prefers the host explanation, then the server reason, then a plain close', () => {
    expect(endedText(1006, '', 'The screen server answered 403.')).toBe(
      'The screen server answered 403.',
    );
    expect(endedText(1001, 'going away', '')).toBe('going away');
    expect(endedText(1000, '', '')).toBe('Disconnected.');
    expect(endedText(1006, '', '')).toBe('The screen connection ended.');
  });
});

describe('ScreenViewer', () => {
  it('says the desktop app is needed and offers no connect outside it', () => {
    renderViewer(fakeRelay(false).relay);
    expect(screen.getByText('Screen viewing needs the desktop app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByLabelText('Screen address')).toBeDisabled();
  });

  it('connects through the relay, reports the desktop name, and defaults to view only', async () => {
    const { relay, channels } = fakeRelay();
    const { rfbs } = renderViewer(relay);
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    await connectTo('wss://sandbox/websockify?token=t');
    expect(channels).toHaveLength(1);
    expect((channels[0] as { url?: string }).url).toBe('wss://sandbox/websockify?token=t');
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    const rfb = rfbs[0];
    if (!rfb) throw new Error('no client');
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    act(() => rfb.emit('connect', {}));
    expect(screen.getByText('Connected to Astra · view only')).toBeInTheDocument();
    act(() => rfb.emit('desktopname', { name: 'sandbox:1' }));
    expect(screen.getByText('Connected to sandbox:1 · view only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'View only' }));
    expect(rfb.viewOnly).toBe(false);
    expect(screen.getByText('Connected to sandbox:1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.getByLabelText('Screen address')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(rfb.disconnect).toHaveBeenCalledOnce();
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(screen.getByText('Disconnected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('sends a provided password when asked and prompts when none was given', async () => {
    const { relay } = fakeRelay();
    const { rfbs } = renderViewer(relay);
    await connectTo('wss://sandbox/');
    const first = rfbs[0];
    if (!first) throw new Error('no client');
    act(() => first.emit('credentialsrequired', { types: ['password'] }));
    expect(screen.getByText('The screen server asks for a password.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('The screen server asks for a password.'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send password' }));
    expect(first.sendCredentials).toHaveBeenCalledWith({ password: 'hunter2' });
    expect(screen.queryByText('The screen server asks for a password.')).not.toBeInTheDocument();
    act(() => first.emit('disconnect', { clean: true }));
    expect(screen.getByText('Disconnected.')).toBeInTheDocument();

    // The password field is memory only; a reconnect answers the prompt itself.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    const second = rfbs[1];
    if (!second) throw new Error('no second client');
    act(() => second.emit('credentialsrequired', { types: ['password'] }));
    expect(second.sendCredentials).toHaveBeenCalledWith({ password: 'hunter2' });
    expect(screen.queryByText('The screen server asks for a password.')).not.toBeInTheDocument();
  });

  it('shows the host explanation for a refused connection and a security failure verbatim', async () => {
    const { relay, channels } = fakeRelay();
    const { rfbs } = renderViewer(relay);
    await connectTo('wss://sandbox/');
    const rfb = rfbs[0];
    const channel = channels[0];
    if (!rfb || !channel) throw new Error('no client');
    (channel as { lastError: string }).lastError = 'The screen server answered 403.';
    act(() => rfb.emit('disconnect', { clean: false }));
    expect(screen.getByText('The screen server answered 403.')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    const second = rfbs[1];
    if (!second) throw new Error('no second client');
    act(() => second.emit('securityfailure', { status: 1, reason: 'Authentication failed' }));
    expect(screen.getByText('Authentication failed')).toBeInTheDocument();
    act(() => second.emit('disconnect', { clean: false }));
    expect(screen.getByText('Authentication failed')).toBeInTheDocument();
  });

  it('tears the connection down when the pane closes or unmounts', async () => {
    const { relay, channels } = fakeRelay();
    const { view, rfbs, onClose } = renderViewer(relay);
    await connectTo('wss://sandbox/');
    fireEvent.click(screen.getByRole('button', { name: 'Close screen' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(rfbs[0]?.disconnect).toHaveBeenCalled();
    expect(channels[0]?.close).toHaveBeenCalled();
  });
});
