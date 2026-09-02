import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FamiliarsShell } from './familiars-shell';

/**
 * The Familiars Redesign v2 surface, exercised the way a person would use it.
 *
 * Queries go by role and name. The design's own labels are the contract:
 * "Needs you", "Held action", "Held for approval", "Familiar switcher".
 */

function conversationsRail() {
  return screen.getByRole('complementary', { name: 'Conversations sidebar' });
}

function inspectorRail() {
  return screen.getByRole('complementary', { name: 'Familiar inspector' });
}

function composer() {
  return screen.getByRole('textbox', { name: 'Message' });
}

function threadTitle() {
  return document.querySelector('.fr-thread-title')?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FamiliarsShell', () => {
  it('renders the three columns around the pricing conversation', () => {
    render(<FamiliarsShell />);

    expect(conversationsRail()).toBeInTheDocument();
    expect(inspectorRail()).toBeInTheDocument();
    expect(threadTitle()).toBe('Q3 pricing evidence map');
    expect(screen.getByText('Astra', { selector: '.fr-thread-familiar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('separates what needs you from the recent conversations of the active familiar', () => {
    render(<FamiliarsShell />);

    const needsYou = within(screen.getByRole('region', { name: 'Needs you' }));
    expect(needsYou.getAllByRole('button')).toHaveLength(2);
    expect(needsYou.getByText('Open PR: rate limiter')).toBeInTheDocument();
    expect(needsYou.getByText('Astra · Publish a finding')).toBeInTheDocument();

    // Recent is filtered to Astra: her two other conversations, not Cody's.
    expect(screen.getByText('Vendor deck comparison')).toBeInTheDocument();
    expect(screen.getByText('Purple cat sketch')).toBeInTheDocument();
    expect(screen.queryByText('Flaky test in auth suite')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Filter recent conversations'));

    expect(screen.getByText('Flaky test in auth suite')).toBeInTheDocument();
    expect(screen.getByText('Inbox triage · Monday')).toBeInTheDocument();
  });

  it('shows an empty recent list when asked to', () => {
    render(<FamiliarsShell demoEmpty="conversations" />);

    expect(screen.getByText('No conversations with Astra yet.')).toBeInTheDocument();
  });

  it('switches familiars from the switcher and from a held conversation', () => {
    render(<FamiliarsShell />);

    fireEvent.click(screen.getByRole('button', { name: /Astra.*Research and synthesis/ }));
    const switcher = within(screen.getByRole('listbox', { name: 'Familiar switcher' }));
    const options = switcher.getAllByRole('option');

    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    // Astra and Cody each have one action waiting; Echo is simply offline.
    const held = switcher.getAllByText('1 held');
    expect(held).toHaveLength(2);
    for (const meta of held) {
      expect(meta).toHaveClass('fr-switcher-meta--held');
    }
    expect(switcher.getByText('offline')).toBeInTheDocument();

    fireEvent.click(switcher.getByRole('option', { name: /Echo/ }));

    expect(threadTitle()).toBe('Inbox triage · Monday');
    expect(screen.queryByRole('listbox', { name: 'Familiar switcher' })).not.toBeInTheDocument();
    expect(within(inspectorRail()).getByText('Echo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open PR: rate limiter/ }));

    expect(threadTitle()).toBe('Open PR: rate limiter');
    expect(within(inspectorRail()).getByText('Cody')).toBeInTheDocument();
  });

  it('holds a consequential action until you decide, then reports the decision', () => {
    render(<FamiliarsShell />);

    const hold = within(screen.getByRole('region', { name: 'Held action' }));
    expect(hold.getByText('Publish a finding')).toBeInTheDocument();
    expect(hold.getByText('Reversible')).toBeInTheDocument();
    expect(hold.getByText('No')).toHaveClass('fr-fact-value--no');
    expect(screen.getByRole('button', { name: '1 held' })).toBeInTheDocument();

    fireEvent.click(hold.getByRole('button', { name: /Approve/ }));

    expect(screen.queryByRole('region', { name: 'Held action' })).not.toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Needs you' })).queryByText(
        'Q3 pricing evidence map',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Astra is updating memory')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1400);
    });

    expect(screen.queryByText('Astra is updating memory')).not.toBeInTheDocument();
    expect(screen.getByText(/Published\. The finding is live on the board/)).toBeInTheDocument();
  });

  it('declines from the keyboard and ignores the shortcut with nothing pending', () => {
    render(<FamiliarsShell initialConversation="vendor" />);

    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true });
    expect(screen.queryByText('Declined')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Q3 pricing evidence map/ }));
    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true });

    expect(screen.getByText('Declined')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1400);
    });

    expect(screen.getByText(/The draft stays in notes\/findings\//)).toBeInTheDocument();
  });

  it('approves from the keyboard', () => {
    render(<FamiliarsShell />);

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });

    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('renders an expired hold as a quiet row with a way to ask again', () => {
    render(<FamiliarsShell holdOverride="expired" />);

    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/Astra released the run/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 held' })).not.toBeInTheDocument();
  });

  it('offers commands on a slash and marks the ones that must ask', () => {
    render(<FamiliarsShell />);

    fireEvent.change(composer(), { target: { value: '/' } });
    const menu = within(screen.getByRole('listbox', { name: 'Commands' }));

    expect(menu.getAllByRole('option')).toHaveLength(5);
    expect(menu.getByText('/publish').closest('button')).toHaveTextContent('must ask');
    expect(menu.getByText('/image').closest('button')).toHaveTextContent('may act');

    fireEvent.change(composer(), { target: { value: '/im' } });
    expect(menu.getAllByRole('option')).toHaveLength(1);

    fireEvent.keyDown(composer(), { key: 'Tab' });

    expect(composer()).toHaveValue('/image ');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
  });

  it('warns before a draft crosses into the must-ask tier and opens the ward', () => {
    render(<FamiliarsShell />);

    fireEvent.change(composer(), { target: { value: 'Publish the Q3 finding' } });
    const warning = screen.getByRole('button', { name: 'Held for approval' });

    expect(warning).toHaveAttribute('title', '“publish a finding” is in Astra’s must-ask tier');

    fireEvent.click(warning);

    const tabs = within(screen.getByRole('group', { name: 'Familiar details' }));
    expect(tabs.getByRole('button', { name: 'Access' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Must ask/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('sends on Enter and replies at the boundary when the draft would cross it', () => {
    render(<FamiliarsShell />);

    fireEvent.change(composer(), { target: { value: 'Open a pull request for the ledger' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });

    expect(composer()).toHaveValue('');
    expect(screen.getByText('Open a pull request for the ledger')).toBeInTheDocument();
    expect(screen.getByText('Astra is updating memory')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.getByText(/“open a pull request” is in my must-ask tier/)).toBeInTheDocument();
  });

  it('keeps Shift+Enter for a newline', () => {
    render(<FamiliarsShell />);

    fireEvent.change(composer(), { target: { value: 'first line' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });

    expect(composer()).toHaveValue('first line');
    expect(screen.queryByText('first line', { selector: '.fr-bubble' })).not.toBeInTheDocument();
  });

  it('toggles the rails with [ and ] except while typing', () => {
    render(<FamiliarsShell />);

    fireEvent.keyDown(window, { key: '[' });
    expect(
      screen.queryByRole('complementary', { name: 'Conversations sidebar' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show conversations' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ']' });
    expect(
      screen.queryByRole('complementary', { name: 'Familiar inspector' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
    expect(conversationsRail()).toBeInTheDocument();

    fireEvent.keyDown(composer(), { key: '[' });
    expect(conversationsRail()).toBeInTheDocument();
  });

  it('searches conversations from ⌘K and opens the first match on Enter', () => {
    render(<FamiliarsShell />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const dialog = within(screen.getByRole('dialog', { name: 'Search conversations' }));
    const input = dialog.getByRole('textbox', { name: 'Search conversations' });

    expect(dialog.getAllByRole('button', { name: /·/ })).toHaveLength(7);

    fireEvent.change(input, { target: { value: 'vendor' } });
    expect(dialog.getAllByRole('button', { name: /·/ })).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(threadTitle()).toBe('Vendor deck comparison');
    expect(screen.queryByRole('dialog', { name: 'Search conversations' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const reopened = within(screen.getByRole('dialog', { name: 'Search conversations' }));
    fireEvent.change(reopened.getByRole('textbox', { name: 'Search conversations' }), {
      target: { value: 'nothing here' },
    });
    expect(screen.getByText('No conversations match “nothing here”.')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search conversations' })).not.toBeInTheDocument();
  });

  it('opens the evidence map in a lightbox and closes it with Escape', () => {
    render(<FamiliarsShell />);

    fireEvent.click(screen.getByRole('button', { name: /^Open Evidence map/ }));
    const lightbox = screen.getByRole('dialog', { name: /Evidence map/ });

    expect(within(lightbox).getByText('C11 internal deck')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Evidence map/ })).not.toBeInTheDocument();
  });

  it('shows the familiar card from an avatar and hands off to the inspector', () => {
    render(<FamiliarsShell initialTab="overview" />);

    fireEvent.click(screen.getAllByRole('button', { name: 'About Astra' })[0] as HTMLElement);
    const card = within(screen.getByRole('dialog', { name: 'About Astra' }));

    expect(card.getByText('May act').nextSibling).toHaveTextContent('3');
    expect(card.getByText('Must ask').nextSibling).toHaveTextContent('2');
    expect(card.getByText('ward.toml 0.3.1')).toBeInTheDocument();

    fireEvent.click(card.getByRole('button', { name: 'Open in inspector' }));

    expect(screen.queryByRole('dialog', { name: 'About Astra' })).not.toBeInTheDocument();
    const tabs = within(screen.getByRole('group', { name: 'Familiar details' }));
    expect(tabs.getByRole('button', { name: 'Access' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('explains its reasoning in a card that folds away', () => {
    render(<FamiliarsShell />);

    const toggle = screen.getByRole('button', { name: /^Reasoning/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('1 failed');
    expect(toggle).toHaveTextContent('6 steps');
    expect(screen.getByText('14 tool calls')).toBeInTheDocument();
    expect(screen.getByText('Retry fetch')).toBeInTheDocument();
    expect(screen.getByText('Failed —')).toHaveClass('rc-state');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('lets the failed run in the flaky conversation say so', () => {
    render(<FamiliarsShell initialConversation="flaky" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Run failed');
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 held' })).not.toBeInTheDocument();
  });
});
