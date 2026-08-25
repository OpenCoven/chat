import { fireEvent, render, screen } from '@testing-library/react';

import { ChatInspector } from './chat-inspector';
import { MOCK_FAMILIARS } from './mock-familiars';

const astra = MOCK_FAMILIARS.find((familiar) => familiar.id === 'astra');

describe('ChatInspector', () => {
  it('shows the active familiar and its bounded authority', () => {
    render(<ChatInspector familiar={astra} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));

    const panel = screen.getByRole('tabpanel', { name: 'Access' });
    expect(panel).toHaveTextContent('Must ask');
    expect(panel).toHaveTextContent('publish a finding');
  });

  it('moves between tabs with arrow keys', () => {
    render(<ChatInspector familiar={astra} onClose={vi.fn()} />);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });

    expect(screen.getByRole('tab', { name: 'Access' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens app settings in place and returns to the agent', () => {
    const onClose = vi.fn();
    render(<ChatInspector familiar={astra} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'App settings' }));
    expect(screen.getByRole('heading', { name: 'App settings' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();

    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }));
    expect(screen.getByText('cave-7f3a91c2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy diagnostic report' })).toBeVisible();

    const connection = screen.getByRole('tab', { name: 'Connection' });
    connection.focus();
    fireEvent.keyDown(connection, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide agent inspector' }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Astra' }));
    expect(screen.getByRole('heading', { name: 'Astra' })).toBeVisible();
  });

  it('keeps settings reachable when the familiar is unavailable', () => {
    render(<ChatInspector familiar={undefined} onClose={vi.fn()} />);

    expect(screen.getByText('Agent unavailable')).toBeVisible();
    expect(screen.getByText('Choose a conversation to see its agent.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'App settings' })).toBeVisible();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
