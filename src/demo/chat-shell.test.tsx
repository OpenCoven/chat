import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { DemoShell } from './chat-demo';
import { MOCK_CONVERSATIONS } from './mock-data';
import { MOCK_FAMILIARS } from './mock-familiars';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('chat demo shell', () => {
  it('binds every conversation to a known familiar', () => {
    const familiarIds = new Set(MOCK_FAMILIARS.map((familiar) => familiar.id));

    expect(
      MOCK_CONVERSATIONS.every((conversation) => familiarIds.has(conversation.familiarId)),
    ).toBe(true);
  });

  it('keeps Chat as the only primary surface', () => {
    render(<DemoShell />);

    expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Familiars' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toBeVisible();
  });

  it('collapses and restores both side panels independently', () => {
    render(<DemoShell />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide conversations' }));
    expect(document.getElementById('conversation-panel')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Show conversations' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide agent inspector' }));
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'Show conversations' })).toBeVisible();
    expect(within(header).getByRole('button', { name: 'Show agent inspector' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
    expect(screen.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  });

  it('updates the inspector when the active conversation changes agent', () => {
    render(<DemoShell />);

    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    expect(screen.getByRole('heading', { name: 'Cody' })).toBeVisible();
  });

  it('keeps one narrow overlay open at a time and closes it with Escape', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });

    try {
      render(<DemoShell />);

      expect(document.getElementById('conversation-panel')).toBeVisible();
      expect(document.getElementById('agent-inspector')).not.toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: 'Show agent inspector' }));
      expect(document.getElementById('conversation-panel')).not.toBeVisible();
      expect(document.getElementById('agent-inspector')).toBeVisible();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.getElementById('agent-inspector')).not.toBeVisible();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('keeps liquid glass restrained to shell chrome', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/demo/chat-demo.css'), 'utf8');

    expect(css).toContain('--demo-bg: #111216');
    expect(css).toContain('--demo-glass: rgba(37, 38, 44, 0.72)');
    expect(css).toContain('backdrop-filter: blur(24px) saturate(140%)');
    expect(css).toContain('.chat-demo.is-conversations-closed');
    expect(css).toContain('.chat-demo.is-inspector-closed');
    expect(css).toContain('.chat-demo [hidden]');
    expect(css).toMatch(/\.chat-demo \.sidebar\s*{[^}]*grid-column: 1/s);
    expect(css).toMatch(/\.chat-demo \.thread\s*{[^}]*grid-column: 2/s);
    expect(css).toMatch(/\.chat-demo > \[aria-label="Agent inspector"\]\s*{[^}]*grid-column: 3/s);
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('.rail-button');
  });
});
