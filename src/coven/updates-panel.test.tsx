import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateStore, type Updater } from '../lib/updater';
import { UpdatesPanel } from './updates-panel';

function store(overrides: Partial<Updater> = {}) {
  const updater: Updater = {
    check: vi.fn().mockResolvedValue({ available: false, currentVersion: '0.0.5' }),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { updater, store: createUpdateStore(updater) };
}

const available = {
  available: true as const,
  currentVersion: '0.0.5',
  version: '0.0.6',
  notes: 'Faster replies.',
};

describe('UpdatesPanel', () => {
  it('checks on demand and says when Chat is current', async () => {
    const { store: s } = store();
    render(<UpdatesPanel runActive={false} store={s} />);
    expect(screen.getByText('Chat checks for a new version when it opens.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    });
    expect(screen.getByText('Up to date')).toBeTruthy();
    expect(screen.getByText('You have the newest version, 0.0.5.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('offers the update with its notes, and restarts only on request', async () => {
    const { store: s, updater } = store({ check: vi.fn().mockResolvedValue(available) });
    await s.check();
    render(<UpdatesPanel runActive={false} store={s} />);
    expect(screen.getByText('Version 0.0.6 is available')).toBeTruthy();
    expect(screen.getByText("What's new")).toBeTruthy();
    expect(updater.install).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    });
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it('holds the restart while a reply is running', async () => {
    const { store: s } = store({ check: vi.fn().mockResolvedValue(available) });
    await s.check();
    render(<UpdatesPanel runActive={true} store={s} />);
    const restart = screen.getByRole('button', { name: 'Restart to update' }) as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    expect(
      screen.getByText('Finish or stop the current reply first. Restarting would end it.'),
    ).toBeTruthy();
  });

  it('shows a failure in plain words, with the details behind Copy', async () => {
    const { store: s } = store({
      check: vi
        .fn()
        .mockRejectedValue(
          new Error("Chat couldn't check for updates. Try again.\n\nDetails: dns error"),
        ),
    });
    render(<UpdatesPanel runActive={false} store={s} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    });
    expect(screen.getByText("Couldn't check for updates")).toBeTruthy();
    expect(screen.getByText("Chat couldn't check for updates. Try again.")).toBeTruthy();
    expect(screen.queryByText(/dns error/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy update details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
