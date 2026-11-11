import { join } from 'node:path';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/engine-home-row.mjs';
const { MANAGED_MODEL, engineHomes, requestedSince, settingsFor } = await import(path);

test("the row compares Coven's managed engine home with the standalone one", () => {
  expect(engineHomes({}, '/home/r')).toEqual({
    managed: join('/home/r', '.coven', 'code'),
    standalone: join('/home/r', '.coven-code'),
  });
  expect(engineHomes({ COVEN_HOME: '/c' }, '/home/r').managed).toBe(join('/c', 'code'));
  expect(engineHomes({ COVEN_CODE_HOME: '/e' }, '/home/r')).toEqual({
    reason: 'COVEN_CODE_HOME set on this runner',
  });
});

test("the managed home names a model that isn't the engine's default", () => {
  // Coven Code 0.8.0's DEFAULT_MODEL.
  expect(MANAGED_MODEL).not.toBe('claude-opus-4-8');
  expect(settingsFor('claude-haiku-5-5')).toEqual({
    version: 1,
    config: { model: 'claude-haiku-5-5' },
  });
  expect(requestedSince(['claude-opus-4-8', null, 'claude-haiku-5-5'], 1)).toEqual([
    'claude-haiku-5-5',
  ]);
});
