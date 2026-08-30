import type { Page } from '@opencoven/sdk-core/browser';

export const MAX_MANUAL_PAGE_WALK_PAGES = 8;

export type ManualPageWalk = Readonly<{
  reset(): void;
  acceptRootPage(page: Page<unknown>): boolean;
  canFetchNextPage(): boolean;
  acceptNextPage(requestedCursor: string, page: Page<unknown>): boolean;
}>;

type RequestedCursor = Readonly<{ kind: 'root' }> | Readonly<{ kind: 'cursor'; value: string }>;

export function createManualPageWalk(): ManualPageWalk {
  const seenCursors = new Set<string>();
  let fetchedPages = 0;

  function reset(): void {
    seenCursors.clear();
    fetchedPages = 0;
  }

  function acceptPage(requestedCursor: RequestedCursor, page: Page<unknown>): boolean {
    if (fetchedPages >= MAX_MANUAL_PAGE_WALK_PAGES) {
      return false;
    }

    const current: unknown = page.cursor?.current;
    const matchesRequestedCursor =
      requestedCursor.kind === 'root'
        ? current === undefined ||
          current === null ||
          (typeof current === 'string' && current.length > 0)
        : current === requestedCursor.value;
    if (!matchesRequestedCursor) {
      return false;
    }

    const hasMore = page.cursor?.hasMore ?? false;
    const next = page.cursor?.next;
    if (
      hasMore &&
      (typeof next !== 'string' || next.length === 0 || next === current || seenCursors.has(next))
    ) {
      return false;
    }

    fetchedPages += 1;
    if (typeof current === 'string' && current.length > 0) {
      seenCursors.add(current);
    }
    if (hasMore && next !== undefined) {
      seenCursors.add(next);
    }
    return true;
  }

  return Object.freeze({
    reset,
    acceptRootPage(page) {
      reset();
      return acceptPage({ kind: 'root' }, page);
    },
    canFetchNextPage() {
      return fetchedPages < MAX_MANUAL_PAGE_WALK_PAGES;
    },
    acceptNextPage(requestedCursor, page) {
      return acceptPage({ kind: 'cursor', value: requestedCursor }, page);
    },
  });
}
