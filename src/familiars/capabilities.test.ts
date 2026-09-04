import { describe, expect, it } from 'vitest';

import { availabilityFor, CONTROL_NAMES } from './capabilities';
import type { Capability } from './source';

const STAGE_1: ReadonlySet<Capability> = new Set([
  'familiars',
  'conversations',
  'conversation-messages',
]);
const STAGE_1_PLUS_CONTRACT: ReadonlySet<Capability> = new Set([...STAGE_1, 'familiar-contract']);
const STAGE_1_PLUS_ANALYTICS: ReadonlySet<Capability> = new Set([...STAGE_1, 'familiar-analytics']);
const EVERYTHING: ReadonlySet<Capability> = new Set([
  'familiars',
  'conversations',
  'conversation-messages',
  'familiar-contract',
  'familiar-analytics',
  'conversations-write',
  'runs',
  'conversation-participants',
  'attention',
  'rich-content',
  'attachments',
  'familiars-write',
  'screen',
]);

describe('availabilityFor', () => {
  it('covers every control the design gating table names', () => {
    expect(CONTROL_NAMES).toEqual([
      'sidebar',
      'thread',
      'overview',
      'access',
      'activity',
      'composer-send',
      'mentions',
      'held-actions',
      'reasoning-steps',
      'image-cards',
      'summon',
      'screen',
    ]);
  });

  it('enables sidebar, thread, and overview once the shipped Stage 1 reads are present', () => {
    for (const control of ['sidebar', 'thread', 'overview'] as const) {
      expect(availabilityFor(control, STAGE_1)).toEqual({ enabled: true });
      expect(availabilityFor(control, new Set())).toEqual({
        enabled: false,
        reason: expect.stringContaining('familiars'),
      });
    }
  });

  it('gates the Access tab on familiar-contract alone', () => {
    expect(availabilityFor('access', STAGE_1)).toEqual({
      enabled: false,
      reason: 'Not available yet — this instance does not advertise familiar-contract.',
    });
    expect(availabilityFor('access', STAGE_1_PLUS_CONTRACT)).toEqual({ enabled: true });
  });

  it('gates the Activity tab on familiar-analytics alone', () => {
    expect(availabilityFor('activity', STAGE_1)).toEqual({
      enabled: false,
      reason: 'Not available yet — this instance does not advertise familiar-analytics.',
    });
    expect(availabilityFor('activity', STAGE_1_PLUS_ANALYTICS)).toEqual({ enabled: true });
  });

  it('gates composer send on both conversations-write and runs, naming every missing one', () => {
    expect(availabilityFor('composer-send', STAGE_1)).toEqual({
      enabled: false,
      reason: 'Not available yet — this instance does not advertise conversations-write, runs.',
    });
    expect(availabilityFor('composer-send', new Set([...STAGE_1, 'conversations-write']))).toEqual({
      enabled: false,
      reason: 'Not available yet — this instance does not advertise runs.',
    });
  });

  it('gates mentions, held actions, reasoning steps, image cards, summon, and screen on their own capability', () => {
    expect(availabilityFor('mentions', STAGE_1)).toMatchObject({ enabled: false });
    expect(availabilityFor('mentions', new Set([...STAGE_1, 'conversation-participants']))).toEqual(
      {
        enabled: true,
      },
    );
    expect(availabilityFor('held-actions', new Set([...STAGE_1, 'attention']))).toEqual({
      enabled: true,
    });
    expect(availabilityFor('reasoning-steps', new Set([...STAGE_1, 'rich-content']))).toEqual({
      enabled: true,
    });
    expect(availabilityFor('image-cards', new Set([...STAGE_1, 'attachments']))).toEqual({
      enabled: true,
    });
    expect(availabilityFor('summon', new Set([...STAGE_1, 'familiars-write']))).toEqual({
      enabled: true,
    });
    expect(availabilityFor('screen', new Set([...STAGE_1, 'screen']))).toEqual({ enabled: true });
  });

  it('enables every control once every capability is advertised', () => {
    for (const control of CONTROL_NAMES) {
      expect(availabilityFor(control, EVERYTHING)).toEqual({ enabled: true });
    }
  });

  it('disables every control given no capabilities at all', () => {
    for (const control of CONTROL_NAMES) {
      expect(availabilityFor(control, new Set()).enabled).toBe(false);
    }
  });
});
