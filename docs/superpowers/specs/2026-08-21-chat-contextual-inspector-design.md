# Chat Contextual Inspector Design

**Status:** Approved

**Date:** 2026-08-21

**Scope:** `OpenCoven/chat` proof-of-concept chat surface at `?demo=chat`

## Summary

Replace the chat demo's far-left Chat, Familiars, and Settings rail with a
contextual three-pane shell:

- a collapsible conversation list on the left;
- the active conversation in the center; and
- a collapsible agent inspector on the right.

The inspector follows the agent attached to the active conversation. It
combines the useful familiar detail and app-preference entry points without
making either a peer destination to Chat. Both side panels collapse
independently. With both closed, the transcript receives the full window and
only two compact edge controls remain in the thread header.

The visual direction is **Obsidian lens**: dark graphite surfaces, restrained
liquid-glass navigation chrome, native Apple typography, Coven violet for
identity, and minimal motion. The final palette is slightly greyer and less
black than the original direction.

## Goals

- Keep Chat as the sole primary destination.
- Remove the permanent far-left navigation rail.
- Put agent identity, authority, and recent activity beside the conversation
  they describe.
- Keep app preferences reachable without presenting a separate Settings page.
- Let either side panel collapse independently and make the both-closed state
  genuinely minimal.
- Use liquid-glass material selectively while preserving contrast, focus
  visibility, and reduced-motion behavior.
- Reuse the demo's existing mock familiar, contract, activity, and settings
  data rather than inventing unsupported controls.

## Non-Goals

- Redesigning the separate `?demo=minimal` surface.
- Changing the Phase 0 scaffold or production entry point.
- Adding Cave connectivity, persistence, network access, or model selection.
- Changing Familiar Contract authority or creating new settings APIs.
- Replacing the full familiar and settings demo components for other potential
  internal use; they simply stop being primary navigation destinations.
- Introducing an external font, icon, animation, or glass-effect dependency.

## Product Decisions

| Area | Decision |
| --- | --- |
| Primary navigation | Chat only; remove the far-left surface rail |
| Left panel | Searchable conversation list, independently collapsible |
| Right panel | Contextual inspector for the active conversation's agent |
| Inspector tabs | Overview, Access, Activity |
| App preferences | Secondary inspector view reached from a quiet footer row |
| Closed state | No residual rails; two compact header edge controls |
| Panel state | Local ephemeral React state; no persistence in the demo |
| Narrow windows | Side panels overlay the thread and only one opens at a time |
| Visual direction | Dark-grey Obsidian lens with restrained liquid glass |
| Model controls | Omitted until a canonical Cave contract exists |

## Information Architecture

### Conversation list

The left panel contains only chat navigation:

- a `Chats` label and collapse control;
- search;
- conversations with agent identity, title, preview, and recency;
- a compact new-conversation control.

Familiars and Settings do not appear as destinations in this panel or in a
separate icon rail.

### Agent inspector

The right panel header shows the active agent's mark, name, role, and status.
An agent chooser may change the mock agent attached to the active conversation.
The content has three tabs:

1. **Overview** — purpose, status, project context, memory summary, and a link
   to contract-backed identity details.
2. **Access** — actions allowed automatically, actions requiring review,
   editable paths, and Familiar Contract result.
3. **Activity** — a bounded recent summary of completion, run health, duration,
   and last activity. This is not a second analytics dashboard.

The panel renders facts already represented by `MOCK_FAMILIARS`,
`contractReport`, and the existing mock activity data. Controls must not imply
that a value is persisted or sent to Cave.

### App settings

`App settings` is the last, visually quiet row in the inspector. Selecting it
replaces the agent tabs with a secondary settings view and a visible back
control. It preserves the current demo's approved preference set:

- notifications;
- reduced motion;
- launch at login;
- global quick-chat shortcut;
- default agent and project;
- Cave connection and diagnostic information.

General preferences appear first. Connection and diagnostics are one level
deeper because they are less frequent and can contain denser information.

No Model tab or model picker is added. The repository does not currently have
a canonical model-setting contract, so such a control would make a false
product promise.

## Layout and Interaction

### Wide windows

The chat shell has three columns:

```text
+----------------------+--------------------------------+------------------------+
| conversations        | active thread                  | active agent inspector |
| search + chats       | header + transcript + composer | overview/access/activity|
+----------------------+--------------------------------+------------------------+
```

Recommended expanded widths are 280-320 pixels for conversations and 300-340
pixels for the inspector. The thread is `minmax(0, 1fr)` and remains the owner
of surplus space.

Each panel has its own collapse button. Collapsing removes its column from the
grid; it does not leave a narrow icon rail. The thread header retains one
compact control at each edge so either panel can be restored.

### Focus state

When both panels are closed:

- the transcript and composer use the full content width;
- the agent identity stays centered in the thread header;
- the left and right restore controls remain at the header edges;
- no labels, settings icons, familiar icons, or empty panel strips remain.

The controls use distinct accessible labels: `Show conversations`, `Hide
conversations`, `Show agent inspector`, and `Hide agent inspector`. They expose
`aria-expanded` and `aria-controls` for the panel they own.

### Narrow windows

Below the desktop three-column breakpoint, side panels become overlays above
the thread. Opening one closes the other. Escape closes the active overlay and
returns focus to its trigger. Clicking the dimmed thread closes the overlay.
The thread and composer never shrink into an unusable center sliver.

### Keyboard and focus

- Existing conversation and composer keyboard behavior remains unchanged.
- Panel triggers and inspector tabs are reachable in logical DOM order.
- Arrow keys move between tabs; Home and End select the first and last tab.
- Returning from App settings restores focus to its entry row.
- Focus is never moved merely because a panel closes due to a viewport change.

## Components and State

### `DemoShell`

`DemoShell` becomes a thin owner of the chat demo and no longer maintains a
`Surface` union or renders the three-item rail. `FamiliarsPage` and
`SettingsPage` stop being imported into the shell.

### `ChatDemo`

`ChatDemo` continues to own conversations, the active conversation, draft,
streaming, and reader state. It adds only shell-level view state:

- `conversationsOpen`;
- `inspectorOpen`;
- `inspectorView` (`agent` or `app`);
- the active inspector tab.

Panel state remains ephemeral. A refresh resets it with the rest of the demo.

### `ChatInspector`

A focused inspector component receives the active conversation and active
agent. It owns tab semantics and the secondary App settings navigation. Small
subcomponents may separate Overview, Access, Activity, and App settings when
that keeps each data mapping understandable.

The inspector must not own canonical conversation or agent data. Its changes
flow back through explicit callbacks to the demo owner.

### Mock conversation binding

Add a `familiarId` to each `MockConversation`. The inspector resolves that ID
through `MOCK_FAMILIARS`. Changing the agent updates only the active mock
conversation. New conversations use the selected default mock familiar.

This relationship mirrors the approved product design without creating a new
authority. All data remains fabricated and local.

## Visual System

### Palette

The final palette moves from near-black to dark neutral grey:

| Token | Value | Use |
| --- | --- | --- |
| Graphite canvas | `#111216` | Window and transcript background |
| Charcoal surface | `#191a1f` | Elevated opaque content surfaces |
| Glass material | `rgba(37, 38, 44, 0.72)` | Titlebar, panels, composer, controls |
| Pearl | `#f4f3f7` | Primary text |
| Fog | `#aaa7b0` | Secondary text |
| Coven violet | `#9a8ecd` | Agent identity, selection, focus accent |
| Ready green | `#82b38e` | Positive operational status only |

The background stays neutral graphite. There is no large purple bloom or
decorative gradient. Violet remains an identity signal, not ambient lighting.

### Material

Liquid glass is limited to:

- the native-feeling titlebar;
- expanded side panels;
- the composer shell;
- compact panel edge controls;
- segmented inspector tabs.

Glass uses translucency, `backdrop-filter`, a low-contrast border, and a single
top inset highlight. Messages and content rows remain mostly opaque. This
restraint makes the material legible and avoids stacking blur on blur.

The signature element is the pair of refractive edge controls left behind in
the both-closed state. They are compact rounded rectangles, not floating
decorative orbs, and each has one clear job.

### Typography

Use the native Apple system stack already present in the demo:

```css
-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif
```

`SF Pro Display` behavior is approximated by the same system stack for compact
headings. Titles use a slightly tighter tracking value and semibold native
weight. Body and control text stay at readable system sizes with no all-caps
utility labels except short section eyebrows.

### Motion

Panel open and close transitions run for 180-220 milliseconds with a restrained
spring-like easing curve. Opacity and transform may support the width change,
but content must not remain focusable after a panel closes.

`prefers-reduced-motion: reduce` removes panel travel, glass shimmer, streaming
caret motion, and typing animation while preserving visible state changes.

## Empty and Error States

- If no conversation is active, the center keeps the current empty-chat
  behavior and the inspector shows `Choose a conversation to see its agent`.
- If a conversation references an unknown agent, the inspector shows `Agent
  unavailable` and keeps App settings reachable. It must not crash or silently
  substitute a different agent.
- If mock activity is absent, Activity says `No recent runs` rather than
  rendering zero as an observed metric.
- If a capability is absent from the mocked Cave health response, its App
  settings control remains hidden as in the existing settings demo.
- Narrow-window overlays close safely on Escape and restore focus even if the
  underlying conversation changes while open.

## Testing and Verification

### Component tests

Add focused Testing Library coverage for:

- the far-left Familiars and Settings navigation items no longer rendering;
- independent conversation and inspector collapse/restore behavior;
- the both-closed state retaining exactly the two labeled restore controls;
- inspector content following the active conversation's `familiarId`;
- Overview, Access, and Activity tab semantics and keyboard navigation;
- App settings opening in place and returning to the agent view;
- unknown-agent and missing-activity states;
- reduced-motion behavior remaining represented in the stylesheet.

Existing chat sending, streaming, command completion, rich content, and reader
tests must continue to pass.

### Responsive and visual checks

Exercise the demo at:

- 1440 x 900 with both panels open;
- 1440 x 900 with both panels closed;
- 1024 x 768 with one panel open;
- 760 x 900 with each overlay independently open;
- keyboard-only navigation through header, tabs, settings, and composer.

Check computed contrast and focus visibility on glass against the graphite
canvas. Verify that no clipped controls or horizontal page scroll appear.

### Required commands

Before reporting implementation complete, run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
git diff --check
```

The implementation is complete only when these commands pass and the rendered
states above are visually inspected at the listed sizes.

## Scope Guard

This is a focused redesign of the mock `?demo=chat` surface. It does not alter
the production Phase 0 scaffold, expand native permissions, access Cave, or
change the separately approved Minimal macOS demo. Any pressure to add model
settings, durable preferences, or real agent mutation belongs to a later
contract-backed change.
