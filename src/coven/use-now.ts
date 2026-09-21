import { useEffect, useState } from 'react';

/**
 * The current time, refreshed on an interval, for captions that age while the
 * window sits open: a row that said "now" an hour ago, or a run's elapsed time.
 * The interval can change between renders; the clock restarts on the new one.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
