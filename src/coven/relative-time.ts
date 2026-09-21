/**
 * The sidebar's recency caption. The Coven CLI reports `updated_at` as a
 * string it does not promise to make parseable, so anything `Date.parse`
 * rejects yields no caption rather than a bogus one.
 */
export function formatRelativeTime(value: string | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const elapsed = now - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return 'now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  const date = new Date(time);
  const current = new Date(now);
  return date.getUTCFullYear() === current.getUTCFullYear()
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : String(date.getUTCFullYear());
}

/** The full timestamp for a tooltip, or nothing when the value is not a date. */
export function formatAbsoluteTime(value: string | undefined): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Milliseconds since the epoch for sorting, or `-Infinity` when unknown. */
export function activityTime(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}
