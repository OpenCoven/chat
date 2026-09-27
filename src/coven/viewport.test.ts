import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPACT_MAX_WIDTH, MEDIUM_MAX_WIDTH } from './viewport';

describe('viewport tiers', () => {
  it('lets the packaged desktop window shrink into every tier it lays out for', () => {
    // The compact drawers are production behaviour, not a browser-only demo:
    // the window must be allowed to get narrow enough to reach them.
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      app: { windows: { minWidth: number; minHeight: number; width: number }[] };
    };
    const [main] = config.app.windows;
    expect(main?.minWidth).toBeLessThanOrEqual(COMPACT_MAX_WIDTH);
    expect(main?.minWidth).toBeGreaterThanOrEqual(360);
    expect(main?.minHeight).toBeGreaterThanOrEqual(360);
    expect(main?.width).toBeGreaterThan(MEDIUM_MAX_WIDTH);
  });
});
