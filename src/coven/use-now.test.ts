import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './use-now';

describe('useNow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks on the interval and restarts on a new one', () => {
    vi.setSystemTime(1_000_000);
    const { result, rerender, unmount } = renderHook(({ every }) => useNow(every), {
      initialProps: { every: 60_000 },
    });
    expect(result.current).toBe(1_000_000);
    act(() => vi.advanceTimersByTime(59_000));
    expect(result.current).toBe(1_000_000);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(1_060_000);
    rerender({ every: 1_000 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(1_061_000);
    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(1_061_000);
  });
});
