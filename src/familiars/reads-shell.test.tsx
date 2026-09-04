import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MOCK_FAMILIARS } from '../demo/mock-familiars';
import { createMockFamiliarsSource } from './mock-source';
import { FamiliarsReadsShell } from './reads-shell';
import type { Capability, FamiliarsSource, QueryResult } from './source';

describe('FamiliarsReadsShell', () => {
  it('lists familiars and conversations, then selects the first conversation', async () => {
    render(<FamiliarsReadsShell source={createMockFamiliarsSource()} />);

    const sidebar = screen.getByRole('complementary', { name: 'Conversations sidebar' });
    await waitFor(() => {
      expect(within(sidebar).getByText('Astra')).toBeInTheDocument();
    });
    for (const familiar of MOCK_FAMILIARS) {
      expect(within(sidebar).getByText(familiar.name)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Q3 pricing evidence map/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('loads messages for the selected conversation, keeping only user and familiar text', async () => {
    render(<FamiliarsReadsShell source={createMockFamiliarsSource()} />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Map the evidence for the Q3 pricing decision. Start from the two vendor decks in notes/pricing/.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('switches conversations on click and loads that thread', async () => {
    render(<FamiliarsReadsShell source={createMockFamiliarsSource()} />);

    const flakyButton = await screen.findByRole('button', { name: /Flaky test in auth suite/ });
    fireEvent.click(flakyButton);

    await waitFor(() => {
      expect(flakyButton).toHaveAttribute('aria-current', 'true');
    });
  });

  it('shows the ward on the Access tab and analytics on the Activity tab', async () => {
    render(<FamiliarsReadsShell source={createMockFamiliarsSource()} />);
    await screen.findAllByText('Astra');

    fireEvent.click(screen.getByRole('tab', { name: 'access' }));
    await waitFor(() => {
      expect(screen.getByText('publish a finding')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'activity' }));
    await waitFor(() => {
      expect(screen.getByText(/runs completed/)).toBeInTheDocument();
    });
  });

  it('renders a not-available notice for every Stage 2-4 control the mock source does not advertise', async () => {
    render(<FamiliarsReadsShell source={createMockFamiliarsSource()} />);
    await screen.findAllByText('Astra');

    for (const label of ['Sending', '@-mentions', 'Held actions', 'Reasoning steps', 'Images']) {
      expect(screen.getByText(new RegExp(`^${label}: Not available yet`))).toBeInTheDocument();
    }
    for (const label of ['Summoning', 'Screen view']) {
      expect(screen.getByText(new RegExp(`^${label}: Not available yet`))).toBeInTheDocument();
    }
  });

  it('renders the Access and Activity tabs disabled when the source does not advertise those capabilities', async () => {
    const source = createMockFamiliarsSource({ capabilities: new Set() });
    render(<FamiliarsReadsShell source={source} />);
    await screen.findAllByText('Astra');

    fireEvent.click(screen.getByRole('tab', { name: 'access' }));
    expect(screen.getByText(/^Access: Not available yet/)).toBeInTheDocument();
    expect(screen.queryByText('publish a finding')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'activity' }));
    expect(screen.getByText(/^Activity: Not available yet/)).toBeInTheDocument();
    expect(screen.queryByText(/runs completed/)).not.toBeInTheDocument();
  });

  it('renders a diagnostic error state rather than crashing when a read fails', async () => {
    const failingSource: FamiliarsSource = {
      async familiars(): Promise<QueryResult<never>> {
        return { status: 'error', code: 'service_unavailable' };
      },
      async familiar() {
        return { status: 'not_ready' };
      },
      async activity() {
        return { status: 'not_ready' };
      },
      async conversations(): Promise<QueryResult<never>> {
        return { status: 'error', code: 'service_unavailable' };
      },
      async messages() {
        return { status: 'not_ready' };
      },
      capabilities(): ReadonlySet<Capability> {
        return new Set();
      },
    };

    render(<FamiliarsReadsShell source={failingSource} />);

    await waitFor(() => {
      expect(screen.getAllByText(/Couldn’t load .* \(service_unavailable\)\./)).toHaveLength(2);
    });
  });
});
