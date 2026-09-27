import { useSyncExternalStore } from 'react';

/**
 * The three widths the chat lays out for.
 *
 * `wide` keeps every rail in the grid. `medium` keeps the conversation rail
 * but folds the inspector into an overlay drawer. `compact` turns both rails
 * into drawers so the transcript owns the whole viewport.
 */
export type ViewportTier = 'wide' | 'medium' | 'compact';

export const MEDIUM_MAX_WIDTH = 1100;
export const COMPACT_MAX_WIDTH = 760;

const queries: Record<Exclude<ViewportTier, 'wide'>, string> = {
  medium: `(max-width: ${MEDIUM_MAX_WIDTH}px)`,
  compact: `(max-width: ${COMPACT_MAX_WIDTH}px)`,
};

function matcher(): ((query: string) => MediaQueryList) | undefined {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia.bind(window);
}

export function readViewportTier(): ViewportTier {
  const match = matcher();
  if (!match) return 'wide';
  if (match(queries.compact).matches) return 'compact';
  if (match(queries.medium).matches) return 'medium';
  return 'wide';
}

function subscribe(listener: () => void): () => void {
  const match = matcher();
  if (!match) return () => undefined;
  const lists = [match(queries.compact), match(queries.medium)];
  for (const list of lists) list.addEventListener('change', listener);
  return () => {
    for (const list of lists) list.removeEventListener('change', listener);
  };
}

export function useViewportTier(): ViewportTier {
  return useSyncExternalStore(subscribe, readViewportTier, () => 'wide');
}
