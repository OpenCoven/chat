import type { Page } from '@opencoven/sdk-core/browser';

export const MAX_MANUAL_PAGE_WALK_PAGES = 8;

export type ManualPageWalk = Readonly<{
  reset(): void;
  acceptRootPage(page: Page<unknown>): boolean;
  canFetchNextPage(): boolean;
  acceptNextPage(requestedCursor: string, page: Page<unknown>): boolean;
}>;

export function createManualPageWalk(): ManualPageWalk {
  const seenCursors = new Set<string>();
  let fetchedPages = 0;

  function reset(): void {
    seenCursors.clear();
    fetchedPages = 0;
  }

  function acceptPage(requestedCursor: string | undefined, page: Page<unknown>): boolean {
    if (fetchedPages >= MAX_MANUAL_PAGE_WALK_PAGES) {
      return false;
    }

    const current = page.cursor?.current;
    if (requestedCursor !== undefined && current !== requestedCursor) {
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
      return acceptPage(undefined, page);
    },
    canFetchNextPage() {
      return fetchedPages < MAX_MANUAL_PAGE_WALK_PAGES;
    },
    acceptNextPage(requestedCursor, page) {
      return acceptPage(requestedCursor, page);
    },
  });
}
