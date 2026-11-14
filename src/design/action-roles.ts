/**
 * Action roles: one vocabulary for the two button families the app ships.
 *
 * Chat renders buttons from two places with two naming schemes:
 *
 * - `FamButton` (`src/design/familiars-ui.tsx`), styled by `.fr-btn--*`
 *   modifier classes in `familiars-shell.css`;
 * - the vendored `Button` (`src/ui/button.tsx`), styled by
 *   `[data-variant="*"]` rules in `src/ui/ui.css`.
 *
 * The role is what a reader is meant to understand about an action; the
 * variant is how each family draws it. This table is the contract between
 * them, and `action-roles.test.ts` checks it against the stylesheets, so a
 * variant can't be renamed in CSS without the mapping noticing. The table
 * records gaps as `null` with a reason rather than inventing a style: a gap
 * is a design decision, not a bug to fill silently.
 *
 * `docs/design-authority.md` explains the roles and the lavender rule.
 */

export type ActionRole = 'default' | 'emphasized' | 'destructive' | 'quiet';

/** Modifier suffixes of `.fr-btn--*` that exist in familiars-shell.css. */
export type ShellVariant = 'primary' | 'secondary' | 'ghost';

/** `data-variant` values the vendored Button accepts (see ButtonVariant). */
export type SharedVariant =
  | 'primary'
  | 'presence'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'link';

export type RoleMapping = Readonly<{
  /** One sentence a contributor can pick a role by. */
  means: string;
  /** `.fr-btn--<shell>` in familiars-shell.css, or null with `gap`. */
  shell: ShellVariant | null;
  /** `[data-variant="<shared>"]` in ui.css, or null with `gap`. */
  shared: SharedVariant | null;
  /** Why a family has no counterpart. Required exactly when a side is null. */
  gap?: string;
}>;

export const ACTION_ROLES: Readonly<Record<ActionRole, RoleMapping>> = {
  default: {
    means: 'An ordinary action: visible as a control, no claim on attention.',
    shell: 'secondary',
    shared: 'outline',
  },
  emphasized: {
    means:
      'The one action a view is leading to. At most one per group; drawn as a lavender tint of the surface, never a solid lavender fill.',
    shell: 'primary',
    shared: 'presence',
  },
  destructive: {
    means: 'Removes or stops something the reader may not get back: Delete chat, Stop run.',
    shell: null,
    shared: 'destructive',
    gap: 'familiars-shell.css declares no .fr-btn--danger; the delete confirmation styles its own .coven-delete-confirm in src/coven/chat-lifecycle.css. Adding a shell variant is a design change, not a mapping fix.',
  },
  quiet: {
    means: 'Present but secondary: toolbar and chip actions that should not compete with content.',
    shell: 'ghost',
    shared: 'ghost',
  },
};

/**
 * Shared-UI variants that exist in ui.css but carry no role in Chat. They
 * are kept because the vendored component mirrors upstream's contract; Chat
 * does not render them, and a new use needs a role decision first.
 */
export const UNASSIGNED_SHARED_VARIANTS: Readonly<Record<string, string>> = {
  primary:
    'A solid fill of the primary text colour. Chat renders none (composer.test.tsx asserts the Send control is not primary); the emphasized role is presence.',
  secondary:
    'A filled neutral surface, close to the default role. Chat renders none; use outline for default.',
  link: 'Inline text styled as a link. Chat renders none; prose links are <a> under .fr-shell.',
};
