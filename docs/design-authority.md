# Design authority: which tokens rule the window

This is the one place that says where each visual role gets its value in the
OpenCoven Chat desktop app. It answers finding 3 of the
[2026-10-24 design language audit](design-audits/2026-10-24-lucian-chat-design-language-audit.md):
a contributor should be able to find the authoritative token for a role
without reading historical mockups. Line numbers are as of the commit that
added this file; the file names and token names are the contract.

## The rule in one paragraph

**`src/design/familiars-shell.css` is the authority for the mounted UI.** It
declares every colour, border, focus, radius, type and motion token on
`.fr-shell` (dark, line 10) and redeclares the colour roles for the light
scheme under `@media (prefers-color-scheme: light)` (line 60). The chat root
is `<div class="fr-shell coven-chat">` (`src/coven/chat-layout.tsx:1102`), so
everything inside the window resolves those tokens. `src/styles.css` is a
historical foundation that still ships; `src/ui/ui.css` aliases the shell's
tokens for the vendored components; `src/coven/chat-app.css` adds layout
tokens only. Nothing else may introduce a colour role.

## Roles and their tokens

Every token below is declared in `src/design/familiars-shell.css`. The dark
value lives in the `.fr-shell` block; the light value in the
`prefers-color-scheme: light` block. Tokens with one column are the same in
both schemes.

### Surfaces

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Window base | `--bg-base` | `#0c0c0e` | `#f7f7f9` |
| Panel (rails, sheets) | `--bg-panel` | `#141416` | `#f0f0f3` |
| Raised (cards, inputs, menus) | `--bg-raised` | `#1c1c1f` | `#ffffff` |
| Elevated (popovers, button fills) | `--bg-elevated` | `#232327` | `#fbfbfc` |
| Hover | `--bg-hover` | `#26262b` | `#e8e8ee` |
| Sunken (code, wells) | `--bg-sunken` | `#101012` | `#ebebef` |

### Text

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Primary | `--text-primary` | `#f0eff4` | `#17171b` |
| Secondary | `--text-secondary` | `#a2a1ab` | `#4a4955` |
| Muted | `--text-muted` | `#8e8d97` | `#62616c` |

`src/design/familiars-shell.css.test.ts` checks every text colour against
every surface at 4.5:1 in both schemes. Keep it green when a value moves.

### Accent, status and focus

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Lavender (presence and emphasis, see below) | `--accent-presence` | `#a79bf5` | `#5b45d6` |
| Text on a solid lavender fill | `--accent-presence-foreground` | `#0c0c0e` | `#ffffff` |
| Keyboard focus ring | `--ring-focus` | `#a79bf5` | `#5b45d6` |
| Danger | `--color-danger` | `oklch(0.66 0.11 24)` | `oklch(0.52 0.17 25)` |
| Warning | `--color-warning` | `oklch(0.76 0.08 78)` | `oklch(0.52 0.12 70)` |
| Success | `--color-success` | `#a2a1ab` | `#4a4955` |

Focus rings are `--ring-width` (`2px`) and `--ring-offset` (`2px`), drawn
with `outline` on `:focus-visible` only.

### Borders, radius, type and motion (both schemes)

| Role | Token | Value |
| --- | --- | --- |
| Hairline border | `--border-hairline` | `rgba(255, 255, 255, 0.08)` dark, `rgba(0, 0, 0, 0.09)` light |
| Strong border | `--border-strong` | `rgba(255, 255, 255, 0.16)` dark, `rgba(0, 0, 0, 0.18)` light |
| Control radius | `--radius-control` | `8px` |
| Interface face | `--font-inter` | `"Inter Variable"`, then the platform face |
| Technical face | `--font-jetbrains-mono` | `"JetBrains Mono Variable"`, then `ui-monospace` |
| Fast duration | `--duration-fast` | `120ms` |
| Standard easing | `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |

The audit's finding 5 stands: many radii, shadows, gaps and gradients are
still local literals (for example the Settings sheet's `20px` radius in
`src/coven/settings-dialog.css`). This document records what is tokenised;
it does not claim the rest is.

## What lavender means

The code uses `--accent-presence` in two ways, and both are intended:

1. **As a signal, at full strength.** Links under `.fr-shell`, the keyboard
   focus ring, the leading icon in a button (`.fr-btn-icon`), progress bars
   and presence indicators. Here lavender says "this is alive, or this is
   where you are".
2. **As emphasis, only as a tint.** The one leading action in a group is
   drawn as a lavender tint of the surface: `.fr-btn--primary` mixes
   `--accent-presence` at 22% into `--bg-elevated`; the vendored
   `data-variant="presence"` mixes it at 26%. Neither is a solid lavender
   fill, and `--accent-presence-foreground` is reserved for the day one is.

So lavender means **both presence and action emphasis**, distinguished by
strength: a solid stroke or glyph is presence, a tint of a surface is the
emphasized action. The rule that follows is that there is at most one
emphasized action per group, and emphasis never uses a solid fill, because
a solid lavender block would read as a presence signal rather than a button.

## Action roles across the two button families

Chat renders buttons from two components with different variant names:
`FamButton` (`src/design/familiars-ui.tsx`, classes `.fr-btn--*`) and the
vendored `Button` (`src/ui/button.tsx`, `data-variant="*"` rules in
`src/ui/ui.css`). `src/design/action-roles.ts` is the mapping and
`src/design/action-roles.test.ts` checks it against both stylesheets. This
table is a copy for readers; the module is the source.

| Role | Means | `FamButton` / `.fr-btn--` | `Button` / `data-variant` | Used by |
| --- | --- | --- | --- | --- |
| default | An ordinary action, no claim on attention | `secondary` (the default) | `outline` (the default) | most controls |
| emphasized | The one action a view leads to; a lavender tint, never a solid fill | `primary` | `presence` | Send (`src/ui/send-control.tsx`); onboarding, mission and screen-viewer submit actions |
| destructive | Removes or stops something the reader may not get back | **none** (gap) | `destructive` | Stop run; Delete chat uses its own `.coven-delete-confirm` in `src/coven/chat-lifecycle.css` |
| quiet | Present but secondary; must not compete with content | `ghost` | `ghost` | composer attach, attachment chips |

Shared-UI variants with no role in Chat, kept because the vendored component
mirrors upstream's contract: `primary` (a solid fill of the primary text
colour; `src/ui/composer.test.tsx` asserts the Send control is not this),
`secondary` (a filled neutral, near the default role) and `link`. A new use
of any of them needs a role decision first, recorded in `action-roles.ts`.

The destructive gap is recorded, not filled: adding `.fr-btn--danger` is a
design change with its own contrast check, and belongs in a change that
also decides what `.coven-delete-confirm` becomes.

## Historical layers, named

These ship but do not set the design. Read them as history.

- **`src/styles.css`** (`:root`, line 19) is the August 2026 visual
  foundation: near-black "ritual-tech" surfaces (`--surface-void`,
  `--surface-base`, `--surface-raised`), cyan circuitry and focus
  (`--accent-cyan`, line 36), violet selection (`--accent-violet`, line 40),
  `--radius-panel` and `--shadow-panel`. It implements
  `docs/superpowers/specs/2026-08-10-opencoven-chat-design.md`, which marks
  itself **superseded** (by #277, 2026-09-14). The file still sets
  `color-scheme: light dark`, the document background, the body font stack
  and reduced-motion handling, and `src/styles.test.ts` still guards its
  palette, so it cannot be deleted casually. Its `--text-primary`,
  `--text-secondary` and `--text-muted` share names with the shell's tokens
  and are shadowed inside `.fr-shell`; its other tokens are not redeclared by
  the shell.
- **The August specification itself**,
  `docs/superpowers/specs/2026-08-10-opencoven-chat-design.md`, and the
  `docs/superpowers/plans/2026-08-10-*` plans that implemented it. Historical
  record; do not execute.

Known cross-layer dependency: `src/coven/settings-dialog.css:22` reads
`var(--accent-violet, var(--accent-presence))`. The fallback means the
Settings glow degrades to lavender if `styles.css` ever drops its violet; a
future consolidation should read `--accent-presence` directly.

## The shared UI's aliases

`src/ui/ui.css` (vendored from OpenCoven/ui) styles `src/ui/*.tsx` against
the shell's tokens, each with a fallback equal to the shell's dark value so
the components stand up outside a surface that defines them. The button
block (`:where([data-slot="button"])`, line 12) defines the aliases
`--oc-presence` → `--accent-presence`, `--oc-presence-fg` →
`--accent-presence-foreground`, `--oc-danger` → `--color-danger` and
`--oc-ring` → `--ring-focus`. Every rule is at `:where()` specificity, so a
surface class such as `.coven-chat` can tune a variant without fighting
(`src/coven/chat-app.css:981` lifts the destructive label's contrast this
way). The aliases are not new roles; do not add an `--oc-*` token that has no
shell token behind it.

## Portal and top-layer scope

Tokens are inherited through the DOM, so anything rendered **inside**
`.fr-shell` resolves them, including `<dialog>` elements shown with
`showModal()` (Settings, the delete confirmation, the link review, the
companion panel, table expansion and attachment preview): the top layer
changes stacking, not inheritance.

One surface renders **outside** the shell: the composer's mention completion
is portalled to `document.body` (`src/coven/mention-completion.tsx:161`).
Its stylesheet reads `--border-strong`, `--bg-raised`, `--text-primary` and
`--font-inter` (`src/coven/mention-completion.css:1`). Outside `.fr-shell`,
only `--text-primary` exists, and with the historical `styles.css` value;
`--bg-raised` and `--border-strong` are undeclared there, which the cascade
treats as an invalid value at computed-value time. This is a source-level
finding, not a verified rendered defect: it needs a look at the panel in the
running app, and is tracked with the audit's open findings (#533). Until it is
settled, a new portal should mount inside the shell, or carry a class the
shell's palette is also applied to.

## Chat's own tokens

`src/coven/chat-app.css` declares layout tokens on `.coven-chat` (line 15):
`--coven-rail-tab-w` and the rail tabs' three fills, which the light scheme
redeclares (line 956), and it rebinds the shell's `--fr-sidebar-w` and
`--fr-inspector-w` to values `chat-layout.tsx` sets inline. These size the
chat; they do not add colour roles beyond the rail tabs, and any new one
belongs in the shell.
