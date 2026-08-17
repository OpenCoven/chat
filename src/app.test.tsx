import { render, screen } from '@testing-library/react';

import { App } from './app';
import { APP_CONNECTION_SUMMARY, APP_METADATA, APP_SCAFFOLD_STATUS } from './lib/app-metadata';

describe('App', () => {
  it('renders the OpenCoven Chat identity', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'OpenCoven Chat' })).toBeVisible();
  });

  it('shows an unavailable Cave connection state for Phase 0', () => {
    render(<App />);

    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      APP_CONNECTION_SUMMARY,
    );
  });

  it('documents the future public Cave client boundary without integrating it', () => {
    render(<App />);

    const boundary = screen
      .getByRole('heading', { name: 'Integration boundary' })
      .closest('section');

    expect(boundary).toHaveTextContent('Future Cave integration must import only from');
    expect(boundary).toHaveTextContent('@opencoven/cave-client');
    expect(boundary).toHaveTextContent(
      'Phase 0 documents the typed package boundary only; runtime code still avoids private Cave schemas and source-relative SDK links.',
    );
    expect(boundary).toHaveTextContent(
      'Until package publication is explicitly approved, the cross-repository canary verifies packed @opencoven/cave-client tarballs in a temporary install copy instead of adding a local path dependency.',
    );
  });

  it('announces scaffold-only status semantics', () => {
    render(<App />);

    expect(screen.getByText(APP_SCAFFOLD_STATUS)).toBeVisible();
  });

  it('keeps the connection badge decorative', () => {
    // The badge carries a colour dot. Colour is reinforcement, so the state
    // must stay readable from the output element alone and the dot must not
    // reach the accessibility tree as a second, conflicting announcement.
    const { container } = render(<App />);

    const badge = container.querySelector('.state-badge');

    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge?.querySelector('.state-dot')).not.toBeNull();
    expect(screen.getByRole('status', { name: 'Connection state' })).toHaveTextContent(
      APP_CONNECTION_SUMMARY,
    );
  });

  it('exposes a stable scaffold fingerprint for preview smoke checks', () => {
    const { container } = render(<App />);

    expect(container.firstElementChild).toHaveAttribute(
      'data-scaffold-fingerprint',
      APP_METADATA.fingerprint,
    );
  });
});
