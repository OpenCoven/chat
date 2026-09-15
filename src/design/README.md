# `src/design` — the design system the app actually ships

These files render the production UI. They are not a prototype, and nothing
here is optional.

They used to live in `src/demo`, which was untrue in a way that was about to
cost someone real work: `src/coven/chat-layout.tsx` imports
`familiars-shell.css`, and that stylesheet is the **only** definition site for
the app's design tokens — borders, accent colours, danger/warning/success,
focus rings, durations, easing — plus the ~525 `.fr-*` classes the shipped
layout is built from. A reasonable person cleaning up a directory named `demo`
would have deleted the app's entire visual language and been told by the type
checker that everything was fine.

| File | What depends on it |
| --- | --- |
| `familiars-shell.css` | `src/coven/chat-layout.tsx` — tokens + `.fr-*` |
| `familiars-ui.tsx` | `chat-layout.tsx`, `familiar-avatar.tsx` — `cx`, primitives, `Presence` |
| `minimal-icons.tsx` | `chat-layout.tsx` and all of `src/ui/` — `Icon` |

## The rule

Dependencies point **into** this directory, never out of it. `src/design` must
not import from `src/demo`. It previously derived `Presence` from
`MockFamiliar['status']`, which made production typing depend on a fixture;
that is inverted now, and `mock-familiars.ts` imports `Presence` from here
instead, so the two still cannot drift.

`src/demo` is now genuinely demo-only: no file reachable from `src/main.tsx`
imports anything in it.

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
