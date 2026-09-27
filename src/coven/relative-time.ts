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

/**
 * The thread header's caption for a chat's last activity, in words. Empty for
 * a value that is not a date, so the header never shows a wrong caption.
 */
export function formatUpdatedCaption(value: string | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const elapsed = now - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return 'Updated just now';
  if (elapsed < hour) return `Updated ${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `Updated ${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `Updated ${Math.floor(elapsed / day)}d ago`;
  const date = new Date(time);
  const current = new Date(now);
  return date.getUTCFullYear() === current.getUTCFullYear()
    ? `Updated ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
    : `Updated in ${date.getUTCFullYear()}`;
}

/** A run's elapsed time: seconds under a minute, then minutes and seconds, then hours and minutes. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
