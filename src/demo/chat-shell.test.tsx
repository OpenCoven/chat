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
});
