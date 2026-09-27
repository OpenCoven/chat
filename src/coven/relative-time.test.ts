import { describe, expect, it } from 'vitest';
import {
  activityTime,
  formatAbsoluteTime,
  formatElapsed,
  formatRelativeTime,
  formatUpdatedCaption,
} from './relative-time';

const now = Date.parse('2026-09-20T12:00:00Z');

describe('formatRelativeTime', () => {
  it('scales from seconds to days and then names the date', () => {
    expect(formatRelativeTime('2026-09-20T11:59:40Z', now)).toBe('now');
    expect(formatRelativeTime('2026-09-20T11:35:00Z', now)).toBe('25m');
    expect(formatRelativeTime('2026-09-20T09:00:00Z', now)).toBe('3h');
    expect(formatRelativeTime('2026-09-18T12:00:00Z', now)).toBe('2d');
    expect(formatRelativeTime('2026-09-01T12:00:00Z', now)).toBe('Sep 1');
    expect(formatRelativeTime('2025-12-31T12:00:00Z', now)).toBe('2025');
  });

  it('treats a date-only value as the CLI reports it', () => {
    expect(formatRelativeTime('2026-09-14', now)).toBe('6d');
  });

  it('shows nothing for a value that is not a date rather than a wrong caption', () => {
    expect(formatRelativeTime('today', now)).toBe('');
    expect(formatRelativeTime('', now)).toBe('');
    expect(formatRelativeTime(undefined, now)).toBe('');
  });

  it('never reports the future as elapsed time', () => {
    expect(formatRelativeTime('2026-09-20T12:05:00Z', now)).toBe('now');
  });
});

describe('formatAbsoluteTime', () => {
  it('gives a full timestamp only for a real date', () => {
    expect(formatAbsoluteTime('2026-09-14T08:30:00Z')).toMatch(/2026/);
    expect(formatAbsoluteTime('today')).toBe('');
  });
});

describe('activityTime', () => {
  it('orders unknown activity after every real timestamp', () => {
    expect(activityTime('2026-09-14')).toBeGreaterThan(activityTime('2026-09-13'));
    expect(activityTime('today')).toBe(Number.NEGATIVE_INFINITY);
    expect(activityTime(undefined)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('formatUpdatedCaption', () => {
  it('says in words how long ago the chat last moved', () => {
    expect(formatUpdatedCaption('2026-09-20T11:59:40Z', now)).toBe('Updated just now');
    expect(formatUpdatedCaption('2026-09-20T11:35:00Z', now)).toBe('Updated 25m ago');
    expect(formatUpdatedCaption('2026-09-20T09:00:00Z', now)).toBe('Updated 3h ago');
    expect(formatUpdatedCaption('2026-09-18T12:00:00Z', now)).toBe('Updated 2d ago');
    expect(formatUpdatedCaption('2026-09-01T12:00:00Z', now)).toBe('Updated Sep 1');
    expect(formatUpdatedCaption('2025-12-31T12:00:00Z', now)).toBe('Updated in 2025');
  });

  it('shows nothing for a value that is not a date', () => {
    expect(formatUpdatedCaption('today', now)).toBe('');
    expect(formatUpdatedCaption(undefined, now)).toBe('');
  });
});

describe('formatElapsed', () => {
  it('scales from seconds to minutes to hours and never goes negative', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(75_000)).toBe('1m 15s');
    expect(formatElapsed(600_000)).toBe('10m 00s');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
  });
});
