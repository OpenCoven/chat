import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FamiliarInspector, type FamiliarInspectorProps } from './familiars-inspector';
import { MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';

function familiar(id: string): MockFamiliar {
  const found = MOCK_FAMILIARS.find((candidate) => candidate.id === id);

  if (!found) {
    throw new Error(`no mock familiar ${id}`);
  }

  return found;
}

function renderInspector(overrides: Partial<FamiliarInspectorProps> = {}) {
  const props: FamiliarInspectorProps = {
    familiar: familiar('astra'),
    tab: 'overview',
    onTabChange: vi.fn(),
    onHide: vi.fn(),
    heldTitles: ['publish a finding'],
    groups: {},
    onToggleGroup: vi.fn(),
    activityOpen: null,
    onToggleActivity: vi.fn(),
    onOpenDoc: vi.fn(),
    ...overrides,
  };

  return { ...render(<FamiliarInspector {...props} />), props };
}

describe('FamiliarInspector', () => {
  it('offers three views as pressed toggles', () => {
    const { props } = renderInspector({ tab: 'access' });
    const tabs = within(screen.getByRole('group', { name: 'Familiar details' }));

    expect(tabs.getByRole('button', { name: 'Access' })).toHaveAttribute('aria-pressed', 'true');
    expect(tabs.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(tabs.getByRole('button', { name: 'Activity' }));

    expect(props.onTabChange).toHaveBeenCalledWith('activity');
  });

  it('summarises the familiar and its ward on the overview', () => {
    const { props } = renderInspector();
    const panel = within(screen.getByRole('region', { name: 'Overview' }));

    expect(panel.getByText(/To map unfamiliar territory/)).toBeInTheDocument();
    expect(panel.getByText('available')).toBeInTheDocument();
    expect(panel.getByText('Quick chats')).toBeInTheDocument();
    expect(panel.getByText('412 entries · MEMORY.md')).toBeInTheDocument();
    expect(panel.getByText('Val Alexander')).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: /Ward.*3 may act · 2 must ask · 3 paths/ }));

    expect(props.onTabChange).toHaveBeenCalledWith('access');
  });

  it('shows what the familiar may do alone and what it must ask about', () => {
    const { props } = renderInspector({ tab: 'access' });
    const panel = within(screen.getByRole('region', { name: 'Access' }));

    expect(panel.getByText('Clear boundaries, visible at a glance.')).toBeInTheDocument();
    expect(panel.getByText('3 may act')).toBeInTheDocument();
    expect(panel.getByText('2 must ask')).toBeInTheDocument();

    for (const name of [/May act/, /Must ask/, /Workspace reach/]) {
      expect(panel.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }
    // A 5/5 contract has nothing to draw attention to, so it starts closed.
    expect(panel.getByRole('button', { name: /Familiar contract/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(panel.getByText('1 held now')).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: /^TOOLS\.md/ }));
    expect(props.onOpenDoc).toHaveBeenCalledWith({ file: 'TOOLS.md' });

    fireEvent.click(panel.getByRole('button', { name: /^read files/ }));
    expect(props.onOpenDoc).toHaveBeenCalledWith({ file: 'ward.toml', hl: 'read files' });

    fireEvent.click(panel.getByRole('button', { name: /Familiar contract/ }));
    expect(props.onToggleGroup).toHaveBeenCalledWith('contract', true);
  });

  it('opens the contract when a property is unmet, and everything when asked', () => {
    renderInspector({ tab: 'access', familiar: familiar('echo'), heldTitles: [] });
    const panel = within(screen.getByRole('region', { name: 'Access' }));

    expect(panel.getByRole('button', { name: /Familiar contract/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(panel.getByText('4/5')).toBeInTheDocument();
    expect(panel.getByText(/MEMORY.md is absent/)).toBeInTheDocument();
    expect(document.querySelectorAll('.fr-meter-seg--warn')).toHaveLength(1);
  });

  it('respects an explicit request to open every group', () => {
    renderInspector({ tab: 'access', groups: { auto: false }, accessGroups: 'all' });
    const panel = within(screen.getByRole('region', { name: 'Access' }));

    expect(panel.getByRole('button', { name: /May act/ })).toHaveAttribute('aria-expanded', 'true');
    expect(panel.getByRole('button', { name: /Familiar contract/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('reports the last seven days of activity in four sections and a chart', () => {
    const { props } = renderInspector({ tab: 'activity' });
    const panel = within(screen.getByRole('region', { name: 'Activity' }));

    expect(panel.getByRole('button', { name: /Completion/ })).toHaveTextContent('100%');
    expect(panel.getByRole('button', { name: /Median duration/ })).toHaveTextContent('1m 36s');
    expect(panel.getByRole('button', { name: /Tool calls/ })).toHaveTextContent('148');
    expect(panel.getByRole('button', { name: /Recent runs/ })).toHaveTextContent('4');
    expect(panel.getByText('Runs per day')).toBeInTheDocument();
    expect(panel.getByText('14')).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: /Recent runs/ }));
    expect(props.onToggleActivity).toHaveBeenCalledWith('recent');
  });

  it('expands a section inline', () => {
    renderInspector({ tab: 'activity', activityOpen: 'recent' });
    const panel = within(screen.getByRole('region', { name: 'Activity' }));

    expect(panel.getByRole('button', { name: /Recent runs/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(panel.getByText('Q3 pricing evidence map')).toBeInTheDocument();
    expect(panel.getByText('held')).toBeInTheDocument();
    expect(panel.getByText('14 calls')).toBeInTheDocument();
    // Two of Astra's four recent runs retried a fetch.
    expect(panel.getAllByText('1 retry')).toHaveLength(2);
  });

  it('has an empty state for a familiar that has not run yet', () => {
    renderInspector({ tab: 'activity', demoEmpty: 'runs' });

    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a task' })).toBeInTheDocument();
  });

  it('has an empty state for no familiar at all', () => {
    renderInspector({ demoEmpty: 'familiar' });

    expect(screen.getByText('No familiar selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Summon familiar' })).toBeInTheDocument();
  });

  it('hides from its own header', () => {
    const { props } = renderInspector();

    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }));

    expect(props.onHide).toHaveBeenCalled();
  });
});
