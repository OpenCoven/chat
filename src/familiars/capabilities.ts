import type { Capability } from './source';

/**
 * Per-control capability gating, from the integration design's table
 * (`docs/superpowers/specs/2026-09-02-familiars-integration-design.md`
 * "Capability gating"). A control whose capability the source does not
 * advertise renders disabled with a one-line reason -- never as a working
 * mock.
 */
export type ControlName =
  | 'sidebar'
  | 'thread'
  | 'overview'
  | 'access'
  | 'activity'
  | 'composer-send'
  | 'mentions'
  | 'held-actions'
  | 'reasoning-steps'
  | 'image-cards'
  | 'summon'
  | 'screen';

export type ControlAvailability = Readonly<{ enabled: boolean; reason?: string }>;

const CONTROL_REQUIREMENTS: Readonly<Record<ControlName, readonly Capability[]>> = {
  sidebar: ['familiars', 'conversations', 'conversation-messages'],
  thread: ['familiars', 'conversations', 'conversation-messages'],
  overview: ['familiars', 'conversations', 'conversation-messages'],
  access: ['familiar-contract'],
  activity: ['familiar-analytics'],
  'composer-send': ['conversations-write', 'runs'],
  mentions: ['conversation-participants'],
  'held-actions': ['attention'],
  'reasoning-steps': ['rich-content'],
  'image-cards': ['attachments'],
  summon: ['familiars-write'],
  screen: ['screen'],
};

/** The controls every `FamiliarsSource` must be gated on. Order is stable for tests. */
export const CONTROL_NAMES: readonly ControlName[] = Object.keys(
  CONTROL_REQUIREMENTS,
) as ControlName[];

function reasonFor(missing: readonly Capability[]): string {
  return missing.length === 1
    ? `Not available yet — this instance does not advertise ${missing[0]}.`
    : `Not available yet — this instance does not advertise ${missing.join(', ')}.`;
}

/** Whether `control` is enabled given the capabilities a source advertises. */
export function availabilityFor(
  control: ControlName,
  capabilities: ReadonlySet<Capability>,
): ControlAvailability {
  const missing = CONTROL_REQUIREMENTS[control].filter(
    (capability) => !capabilities.has(capability),
  );

  if (missing.length === 0) {
    return { enabled: true };
  }

  return { enabled: false, reason: reasonFor(missing) };
}
