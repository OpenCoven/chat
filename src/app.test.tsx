import { render, screen, within } from '@testing-library/react';

import { App } from './app';
import { APP_CONNECTION_SUMMARY, APP_METADATA, APP_SCAFFOLD_STATUS } from './lib/app-metadata';
import type { DesktopHost } from './lib/desktop-host';

const PREVIEW_IDENTITY = Object.freeze({
  name: 'OpenCoven Chat (preview)',
  identifier: 'preview-only',
  phase: 'phase-0-scaffold-preview',
});

function makeDesktopHost(overrides: Partial<DesktopHost> = {}): DesktopHost {
  return {
    canUseTauriCommands: () => false,
    readAppIdentity: vi.fn().mockResolvedValue({
      name: 'OpenCoven Chat',
      identifier: 'ai.opencoven.chat',
      phase: 'phase-0-scaffold',
    }),
    previewAppIdentity: () => PREVIEW_IDENTITY,
    ...overrides,
  };
}

describe('App', () => {
  it('renders an explicitly labeled browser preview fallback when Tauri is unavailable', () => {
    const desktopIdentityHost = makeDesktopHost();

    render(<App desktopIdentityHost={desktopIdentityHost} />);

    expect(screen.getByRole('heading', { name: 'OpenCoven Chat (preview)' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Desktop identity status' })).toHaveTextContent(
      'Browser preview fallback active. Desktop identity is available only inside Tauri.',
    );
    expect(screen.getByText('Browser preview fallback')).toBeVisible();
    expect(desktopIdentityHost.readAppIdentity).not.toHaveBeenCalled();
  });

  it('shows an unavailable Cave connection state for Phase 0', () => {
    render(<App desktopIdentityHost={makeDesktopHost()} />);

    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      APP_CONNECTION_SUMMARY,
    );
  });

  it('documents the frozen SDK-managed Cave boundary without integrating it', () => {
    render(<App desktopIdentityHost={makeDesktopHost()} />);

    const boundary = screen
      .getByRole('heading', { name: 'Integration boundary' })
      .closest('section');

    expect(boundary).toHaveTextContent('Future Cave integration must import only from');
    expect(boundary).toHaveTextContent('@opencoven/cave-client');
    expect(boundary).toHaveTextContent(
      'The SDK-managed webview boundary uses frozen packed artifacts and leaves discovery parsing, Client v1 schemas, and credentials outside UI code.',
    );
    expect(boundary).toHaveTextContent(
      'The contract canary verifies the locked packed artifact digests and rejects workspace or source-relative package contamination.',
    );
  });

  it('announces scaffold-only status semantics', () => {
    render(<App desktopIdentityHost={makeDesktopHost()} />);

    expect(screen.getByText(APP_SCAFFOLD_STATUS)).toBeVisible();
  });

  it('keeps the connection badge decorative', () => {
    // The badge carries a colour dot. Colour is reinforcement, so the state
    // must stay readable from the output element alone and the dot must not
    // reach the accessibility tree as a second, conflicting announcement.
    const { container } = render(<App desktopIdentityHost={makeDesktopHost()} />);

    const badge = container.querySelector('.state-badge');

    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge?.querySelector('.state-dot')).not.toBeNull();
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      APP_CONNECTION_SUMMARY,
    );
  });

  it('exposes a stable scaffold fingerprint for preview smoke checks', () => {
    const { container } = render(<App desktopIdentityHost={makeDesktopHost()} />);

    expect(container.firstElementChild).toHaveAttribute(
      'data-scaffold-fingerprint',
      APP_METADATA.fingerprint,
    );
  });

  it('renders the native app_identity result after a successful invoke', async () => {
    const desktopIdentityHost = makeDesktopHost({
      canUseTauriCommands: () => true,
      readAppIdentity: vi.fn().mockResolvedValue({
        name: 'Native OpenCoven Chat',
        identifier: 'ai.opencoven.chat.native',
        phase: 'phase-0-native',
      }),
    });

    render(<App desktopIdentityHost={desktopIdentityHost} />);

    expect(await screen.findByRole('heading', { name: 'Native OpenCoven Chat' })).toBeVisible();
    expect(screen.getByText('Native app_identity command')).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Desktop identity status' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces native app_identity invoke failures instead of silently defaulting', async () => {
    const desktopIdentityHost = makeDesktopHost({
      canUseTauriCommands: () => true,
      readAppIdentity: vi.fn().mockRejectedValue(new Error('invoke failed: missing handler')),
    });

    render(<App desktopIdentityHost={desktopIdentityHost} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Desktop identity unavailable. invoke failed: missing handler',
    );
    const identityPanel = screen
      .getByRole('heading', { name: 'Desktop identity' })
      .closest('aside');

    expect(identityPanel).not.toBeNull();
    expect(within(identityPanel as HTMLElement).getAllByText('Unavailable')).toHaveLength(3);
    expect(screen.getByText('OpenCoven Chat')).toBeVisible();
  });

  it('shows a raw string rejection in the native app failure UI', async () => {
    const desktopIdentityHost = makeDesktopHost({
      canUseTauriCommands: () => true,
      readAppIdentity: vi.fn().mockRejectedValue('invoke failed: raw string'),
    });

    render(<App desktopIdentityHost={desktopIdentityHost} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Desktop identity unavailable. invoke failed: raw string',
    );
  });

  it('falls back to the generic native app failure copy for unknown rejection payloads', async () => {
    const desktopIdentityHost = makeDesktopHost({
      canUseTauriCommands: () => true,
      readAppIdentity: vi.fn().mockRejectedValue({ code: 'E_NATIVE', secret: 'hidden' }),
    });

    render(<App desktopIdentityHost={desktopIdentityHost} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Desktop identity unavailable. The native app_identity command failed.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('E_NATIVE');
    expect(screen.getByRole('alert')).not.toHaveTextContent('hidden');
  });
});
