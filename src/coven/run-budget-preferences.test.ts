import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  readPreferences,
  runOptions,
  sendOptions,
} from './preferences';

describe('finite model-round requests', () => {
  beforeEach(() => localStorage.clear());

  it('requests fifty finite rounds for a new Coven Code reply', () => {
    expect(sendOptions(runOptions(readPreferences()))).toMatchObject({ maxTurns: 50 });
  });

  it('preserves deliberate positive integer budgets through stored settings and send', () => {
    for (const maxTurns of [1, 12, 4294967295]) {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ maxTurns }));
      expect(sendOptions(runOptions(readPreferences()))).toMatchObject({ maxTurns });
    }
  });

  it('recovers malformed stored limits to the finite default without an unlimited mode', () => {
    for (const maxTurns of [0, -1, 1.5, 4294967296, null, '12', Number.POSITIVE_INFINITY]) {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ maxTurns }));
      expect(sendOptions(runOptions(readPreferences()))).toMatchObject({ maxTurns: 50 });
    }
  });

  it('rejects malformed explicit send options instead of silently substituting a limit', () => {
    for (const maxTurns of [0, -1, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sendOptions({ ...runOptions(DEFAULT_PREFERENCES), maxTurns })).toThrow();
    }
  });

  it('does not put engine budget flags on an existing unsupported harness', () => {
    for (const harness of ['codex', 'claude'] as const) {
      expect(sendOptions(runOptions(DEFAULT_PREFERENCES, harness), harness)).not.toHaveProperty(
        'maxTurns',
      );
    }
  });
});
