import { describe, expect, it } from 'vitest';
import { activityTime, formatAbsoluteTime, formatRelativeTime } from './relative-time';

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
