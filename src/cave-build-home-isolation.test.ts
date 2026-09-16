import { describe, expect, test } from 'vitest';

// @ts-expect-error The executable producer intentionally has no declaration file.
import { schemaV2CaveBuildEnvironment } from '../scripts/phase1-schema-v2-producer.mjs';

describe('Cave build home isolation', () => {
  test('pins Windows Cave state to the execution home while preserving the token environment', () => {
    const environment = {
      HOME: 'C:\\owned\\execution\\home',
      USERPROFILE: 'C:\\owned\\staging\\profile',
      OPENCOVEN_WINDOWS_PROFILE_ROOT: 'C:\\Users\\isolated-token',
      COVEN_HOME: 'C:\\unrelated\\coven',
      COVEN_CAVE_HOME: 'C:\\unrelated\\cave',
    };
    const result = schemaV2CaveBuildEnvironment(environment, 'win32');
    expect(result.COVEN_HOME).toBe('C:\\owned\\execution\\home\\.coven');
    expect(result.COVEN_CAVE_HOME).toBe('C:\\owned\\execution\\home\\.coven\\cave');
    expect(result.USERPROFILE).toBe(environment.USERPROFILE);
    expect(result.OPENCOVEN_WINDOWS_PROFILE_ROOT).toBe(environment.OPENCOVEN_WINDOWS_PROFILE_ROOT);
    expect(environment.COVEN_HOME).toBe('C:\\unrelated\\coven');
    expect(result.NODE_OPTIONS).toBe('--max-old-space-size=6144');
    expect(result.CIRCLE_NODE_TOTAL).toBe('2');
  });

  test('pins Unix Cave state beneath the supplied execution home', () => {
    const result = schemaV2CaveBuildEnvironment({ HOME: '/owned/execution/home' }, 'linux');
    expect(result.COVEN_HOME).toBe('/owned/execution/home/.coven');
    expect(result.COVEN_CAVE_HOME).toBe('/owned/execution/home/.coven/cave');
  });

  test.each([undefined, '', 'relative', 'bad\0home'])(
    'rejects an invalid execution home without exposing it',
    (HOME) => {
      expect(() => schemaV2CaveBuildEnvironment({ HOME }, 'win32')).toThrow(
        /^Cave build requires an absolute execution home\.$/u,
      );
    },
  );
});
