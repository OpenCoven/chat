import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACTION_ROLES, type ActionRole, UNASSIGNED_SHARED_VARIANTS } from './action-roles';

/**
 * The action-role mapping is only worth having if it matches the stylesheets.
 * These checks read the two CSS families and confirm every variant the
 * mapping names is declared there, that each role is either covered on both
 * sides or carries a written reason for the gap, and that the shared family's
 * variants are all either assigned a role or listed as unassigned.
 */

const shell = readFileSync(resolve(process.cwd(), 'src/design/familiars-shell.css'), 'utf8');
const shared = readFileSync(resolve(process.cwd(), 'src/ui/ui.css'), 'utf8');
const buttonSource = readFileSync(resolve(process.cwd(), 'src/ui/button.tsx'), 'utf8');

const ROLES: readonly ActionRole[] = ['default', 'emphasized', 'destructive', 'quiet'];

function shellDeclares(variant: string): boolean {
  return new RegExp(`^\\.fr-btn--${variant}\\s*\\{`, 'm').test(shell);
}

function sharedDeclares(variant: string): boolean {
  return shared.includes(`[data-slot="button"][data-variant="${variant}"]`);
}

describe('action roles', () => {
  it('covers exactly the four roles', () => {
    expect(Object.keys(ACTION_ROLES).sort()).toEqual([...ROLES].sort());
  });

  it.each(ROLES)('%s names variants that the stylesheets declare', (role) => {
    const { shell: shellVariant, shared: sharedVariant } = ACTION_ROLES[role];

    if (shellVariant !== null) expect(shellDeclares(shellVariant)).toBe(true);
    if (sharedVariant !== null) expect(sharedDeclares(sharedVariant)).toBe(true);
  });

  it.each(ROLES)('%s is covered in both families or explains the gap', (role) => {
    const mapping = ACTION_ROLES[role];
    const hasGap = mapping.shell === null || mapping.shared === null;

    if (hasGap) {
      expect(mapping.gap, `${role} has a missing family but no reason`).toBeTruthy();
    } else {
      expect(mapping.gap, `${role} explains a gap it does not have`).toBeUndefined();
    }
  });

  it('does not assign one variant to two roles within a family', () => {
    const shellVariants = ROLES.map((r) => ACTION_ROLES[r].shell).filter((v) => v !== null);
    const sharedVariants = ROLES.map((r) => ACTION_ROLES[r].shared).filter((v) => v !== null);

    expect(new Set(shellVariants).size).toBe(shellVariants.length);
    expect(new Set(sharedVariants).size).toBe(sharedVariants.length);
  });

  it('accounts for every variant the vendored Button accepts', () => {
    const typeBlock = buttonSource.match(/export type ButtonVariant =([\s\S]*?);/)?.[1] ?? '';
    const accepted = [...typeBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1] ?? '');
    expect(accepted.length).toBeGreaterThan(0);

    const assigned = new Set(ROLES.map((r) => ACTION_ROLES[r].shared).filter((v) => v !== null));
    const unassigned = new Set(Object.keys(UNASSIGNED_SHARED_VARIANTS));

    for (const variant of accepted) {
      const covered = assigned.has(variant as never) || unassigned.has(variant);
      expect(covered, `ui variant "${variant}" has neither a role nor a reason`).toBe(true);
      expect(sharedDeclares(variant), `ui.css declares no rule for "${variant}"`).toBe(true);
    }

    for (const variant of unassigned) {
      expect(assigned.has(variant as never), `"${variant}" is both assigned and unassigned`).toBe(
        false,
      );
    }
  });

  it('accounts for every .fr-btn modifier that is a variant, not a size', () => {
    const modifiers = new Set(
      [...shell.matchAll(/^\.fr-btn--([a-z]+)\s*\{/gm)].map((m) => m[1] ?? ''),
    );
    const sizes = new Set(['xs', 'sm', 'md', 'full']);
    const assigned = new Set(ROLES.map((r) => ACTION_ROLES[r].shell).filter((v) => v !== null));

    for (const modifier of modifiers) {
      if (sizes.has(modifier)) continue;
      expect(assigned.has(modifier as never), `.fr-btn--${modifier} has no role`).toBe(true);
    }
  });
});
