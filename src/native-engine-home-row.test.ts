import { join } from 'node:path';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/engine-home-row.mjs';
const { MANAGED_MODEL, engineHomes, homePlan, requestedSince, settingsFor } = await import(path);

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

test('the row works in a managed home the engine already made, and replaces nothing', () => {
  const homes = engineHomes({}, '/home/r');
  const settings = join(homes.managed, 'settings.json');
  const having =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);
  // Coven Code 0.8.0 never made it, so the row makes it and may remove it.
  expect(homePlan(homes, having())).toEqual({ settings, created: true });
  // 0.9.0 and later make it on their first run (goals.sqlite).
  expect(homePlan(homes, having(homes.managed))).toEqual({ settings, created: false });
  expect(homePlan(homes, having(homes.managed, settings))).toEqual({
    block: `${settings} already exists; the row won't replace it`,
  });
  expect(homePlan(homes, having(homes.standalone))).toEqual({
    block: `${homes.standalone} already exists; the row won't replace it`,
  });
  expect(homePlan({ reason: 'COVEN_CODE_HOME set on this runner' })).toEqual({
    block: 'COVEN_CODE_HOME set on this runner',
  });
});
