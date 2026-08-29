import type { Page } from '@opencoven/sdk-core/browser';
import { describe, expect, it } from 'vitest';

import { createManualPageWalk } from './manual-page-walk';

function pageWithCurrent(current: unknown): Page<unknown> {
  return {
    data: [],
    cursor: {
      current,
      hasMore: false,
    },
  } as Page<unknown>;
}

describe('createManualPageWalk', () => {
  it('accepts absent, null, and nonempty server-issued root current cursors', () => {
    const walk = createManualPageWalk();

    expect(walk.acceptRootPage({ data: [], cursor: { hasMore: false } })).toBe(true);
    expect(walk.acceptRootPage(pageWithCurrent(null))).toBe(true);
    expect(walk.acceptRootPage(pageWithCurrent('cm9vdC1jdXJyZW50'))).toBe(true);
  });

  it('rejects an empty root current cursor', () => {
    const walk = createManualPageWalk();

    expect(walk.acceptRootPage(pageWithCurrent(''))).toBe(false);
  });
});
