# `src/design` — the design system the app actually ships

These files render the production UI. They are not a prototype, and nothing
here is optional.

They once lived in a directory named `demo`, which was untrue in a way that
nearly cost someone real work: `src/coven/chat-layout.tsx` imports
`familiars-shell.css`, and that stylesheet is the **only** definition site for
the app's design tokens — borders, accent colours, danger/warning/success,
focus rings, durations, easing — plus the ~525 `.fr-*` classes the shipped
layout is built from. Deleting it would have removed the app's entire visual
language while the type checker reported that everything was fine. The demo
shell itself has since been deleted; these files stayed because the app is
built from them.

| File | What depends on it |
| --- | --- |
| `familiars-shell.css` | `src/coven/chat-layout.tsx` — tokens + `.fr-*` |
| `familiars-ui.tsx` | `chat-layout.tsx`, `familiar-avatar.tsx` — `cx`, primitives |
| `minimal-icons.tsx` | `chat-layout.tsx` and all of `src/ui/` — `Icon` |

## The rule

Dependencies point **into** this directory, never out of it. `src/design`
imports nothing from `src/coven` or `src/ui`, and its vocabulary (`Presence`,
the inspector tab names) is declared here rather than derived from fixtures or
callers.

## Verifying that claim

The bundle is the authority, not the import graph as read by eye:

```bash
corepack pnpm build   # note the emitted index-*.js / index-*.css hashes
```

Moving a file in or out of this directory must leave those content hashes
unchanged. If a hash moves, the change was not a relocation.

## Names

The filenames are the ones these files were born with, kept so this move stays
a pure rename in `git log --follow`. `familiars-shell.css` is the design
system, not a shell for a familiars page. Renaming them is worth doing — as its
own commit, where the diff is legible.
