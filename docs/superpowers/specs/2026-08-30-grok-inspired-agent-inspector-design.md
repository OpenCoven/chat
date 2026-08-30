# Grok-Inspired Agent Inspector Design

**Status:** Approved

**Date:** 2026-08-30

**Scope:** Right-side agent inspector in the `?demo=chat` proof-of-concept surface

## Summary

Redesign the chat demo's right-side inspector as a richer agent profile that
uses its full vertical space more effectively. The information hierarchy takes
inspiration from Grok Bots: expressive identity first, useful live context
second, and progressively disclosed detail below.

The implementation keeps OpenCoven's existing Obsidian visual language rather
than copying Grok's surface styling. It reorganizes only data already available
from the mock familiar, contract, and activity models. It does not add new
backend behavior, persistence, or unsupported controls.

## Goals

- Make the attached familiar feel present and recognizable.
- Use the inspector's height intentionally instead of presenting a sparse list
  of equally weighted rows.
- Keep identity visible while moving between Overview, Access, and Activity.
- Surface the most useful familiar facts at a glance.
- Preserve App settings as a compact footer action.
- Keep the inspector responsive, keyboard accessible, and consistent with the
  current chat shell.

## Non-Goals

- Reproducing Grok's exact colors, typography, iconography, or branding.
- Adding agent actions that are not represented by the existing data model.
- Adding new mock familiar fields solely to fill the design.
- Changing conversation behavior, panel collapse behavior, or the center chat
  experience.
- Redesigning the standalone Familiars, Settings, or Minimal macOS surfaces.
- Introducing external fonts, icon libraries, animation libraries, or UI
  dependencies.

## Approved Direction

The selected direction is **Profile Stack**: a centered identity hero, a
compact row of derived metrics, and stacked context cards. This direction is
the closest to the requested Grok Bots hierarchy while remaining calm,
legible, and appropriate for a narrow utility panel.

Two alternatives were considered:

| Direction | Strength | Trade-off |
| --- | --- | --- |
| Profile Stack | Best balance of personality, scanning, and narrow-width readability | Uses more vertical space before detailed controls |
| Command Deck | Strong operational and recent-activity focus | Gives familiar identity and purpose less emphasis |
| Modular Mosaic | Uses space aggressively with dashboard tiles | Becomes dense and less readable at the panel's minimum width |

## Layout

The redesigned agent view uses a three-row grid:

```text
+----------------------------------+
| compact panel toolbar            |
+----------------------------------+
| scrollable profile content       |
|                                  |
| identity hero                    |
| purpose                          |
| quick metrics                    |
| overview/access/activity tabs    |
| selected contextual cards        |
|                                  |
+----------------------------------+
| compact App settings footer      |
+----------------------------------+
```

The profile content owns the flexible row and scrolls independently. The top
toolbar and App settings footer remain stable. The inspector stays within its
current desktop range of 300-340 pixels so the conversation
continues to own surplus width.

### Identity hero

The top of the scrolling region contains:

- the familiar's avatar mark;
- name;
- role;
- availability status;
- a concise purpose statement.

The hero is centered and more spacious than the current horizontal identity
row. It establishes the familiar before presenting operational detail.

### Quick metrics

A compact three-cell metric row appears below the purpose:

- recent completion rate from `CAVE_FAMILIAR_ANALYTICS`;
- memory entry count from `MockFamiliar.memory`;
- last activity or memory recency.

Values are derived from existing data. Missing values display an explicit
human-readable state such as `No runs`, `Off`, or `Unavailable`; the interface
must not invent zero-valued observations.

### Tabs and contextual cards

Overview, Access, and Activity remain accessible tabs with the existing arrow,
Home, and End keyboard behavior. The tabs move below the stable hero and
metrics. Switching tabs replaces only the lower contextual card stack.

- **Overview** shows purpose and chat context, project, memory, identity, and
  contract status.
- **Access** groups automatic actions, review-required actions, editable paths,
  and the Familiar Contract result.
- **Activity** presents the existing bounded seven-day analytics and empty
  state.

Rows are grouped into low-contrast cards based on meaning instead of appearing
as one undifferentiated settings list.

### App settings footer

App settings remains the final compact row at the bottom of the panel. It keeps
the existing label, keyboard shortcut, and navigation behavior. Selecting it
still replaces the agent inspector with the secondary settings view and a
visible back control.

## Visual System

### Palette

| Token | Value | Use |
| --- | --- | --- |
| Graphite | `#111216` | Window and deepest panel background |
| Charcoal | `#191a1f` | Elevated content surfaces |
| Pearl | `#f4f3f7` | Primary text |
| Fog | `#aaa7b0` | Secondary text |
| Coven violet | `#9386d0` | Identity, active state, and focus |
| Ready green | `#82b38e` | Availability and positive operational state |

The panel uses a tightly bounded violet tint behind the identity hero. It does
not add a large decorative ambient gradient. Content cards remain neutral and
low contrast.

### Typography

Continue using the native system stack:

```css
-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif
```

The familiar name increases to 20 pixels with tight tracking.
Role, purpose, metrics, labels, and values use a clear descending scale.
Section labels may remain uppercase only when they identify a compact card
group.

### Signature element: ward orbit

The avatar gains a restrained asymmetric status ring called the **ward orbit**.
The main violet arc represents familiar identity and the smaller green segment
represents current availability. The ring is semantic rather than decorative:
offline or unavailable states remove the green segment and reduce contrast.

This is the design's single expressive risk. Other surfaces remain disciplined
so the panel does not become visually noisy.

### Material and depth

The inspector shell retains its existing liquid-glass treatment. Profile cards
use subtle opaque or translucent charcoal surfaces, one-pixel borders, and
minimal inset highlights. Shadows are reserved for the identity mark and
selected controls; every card should not float independently.

## Components

`ChatInspector` remains the local state owner and continues to receive
`familiar` and `onClose`.

The presentation should be separated into focused internal components:

- `InspectorHero` renders identity, role, status, purpose, and the ward orbit.
- `InspectorMetrics` derives and renders completion, memory, and recency.
- `Overview` renders overview cards.
- `Access` renders authority and contract cards.
- `Activity` renders recent execution metrics or its empty state.
- `AppSettings` retains the existing secondary settings view.

Small shared card or value components may be introduced when they eliminate
repeated markup. They must not hide domain meaning behind a generic dashboard
abstraction.

## Data Flow

No new data source is introduced:

- identity, purpose, memory, and authority come from `MockFamiliar`;
- contract state comes from `contractReport`;
- execution metrics come from `CAVE_FAMILIAR_ANALYTICS`;
- app preference data remains owned by the existing local settings view.

Derived display values should be computed near the component that owns their
meaning. The redesign must not mutate canonical conversation or familiar data.

## Interaction and Motion

- Identity and quick metrics remain visible when the selected tab changes.
- Tab focus and selection semantics remain unchanged.
- App settings opens in place and returns to the familiar inspector.
- Card-content changes may use one short opacity/vertical transition of roughly
  160-180 milliseconds.
- The ward orbit may transition color or opacity when status changes.
- `prefers-reduced-motion: reduce` removes these transitions without hiding
  state changes.

No ambient looping animation, shimmer, floating particles, or decorative
motion is added.

## Responsive Behavior

At desktop widths, the inspector keeps the current 300-340 pixel column range.
At the existing narrow breakpoint, it continues to overlay the thread and
opening it closes the conversation panel.

On narrow windows:

- the profile remains a single column;
- metric cells may tighten but must not collapse below readable widths;
- the hero uses reduced vertical padding;
- the contextual card region scrolls;
- the footer remains pinned and reachable;
- no horizontal page scrolling is introduced.

## Empty and Error States

- An unknown or missing familiar renders a neutral `Agent unavailable` hero,
  guidance to select another conversation, and a reachable App settings footer.
- Missing memory displays `Off` and does not show a fabricated entry count.
- Missing or zero-attempt activity displays `No recent runs`.
- A missing contract result is surfaced as unavailable rather than silently
  shown as passing.
- Long names, roles, paths, and action labels wrap or truncate according to
  their meaning without pushing controls outside the panel.

## Accessibility

- Preserve the inspector's labeled region, tablist, tabs, and tabpanel
  semantics.
- Preserve arrow, Home, and End keyboard navigation.
- Keep all interactive controls in logical DOM and focus order.
- Use visible violet focus rings that remain legible on graphite and charcoal.
- Do not encode availability or contract state through color alone.
- The ward orbit is decorative to assistive technology; adjacent text carries
  the status meaning.
- Maintain readable contrast for Fog text on every card surface.

## Testing and Verification

Focused component coverage should verify:

- the profile hero renders familiar identity, role, purpose, and text status;
- quick metrics derive from the existing familiar and activity data;
- the stable hero remains while switching Overview, Access, and Activity;
- keyboard tab navigation continues to work;
- missing familiar, memory, and activity states render explicitly;
- App settings opens in place and returns to the familiar view;
- the compact footer remains present in the agent view.

Stylesheet coverage should verify:

- the inspector uses a flexible scrolling content row and compact footer row;
- narrow layouts remain single-column;
- reduced-motion rules cover the new transitions.

Rendered checks should cover at least:

- 1440 x 900 with the inspector open;
- 1024 x 768 with the inspector open;
- 760 x 900 with the inspector overlay open;
- enough Access content to require vertical scrolling;
- keyboard-only navigation through the toolbar, tabs, cards, and App settings.

## Implementation Constraint

The implementation should be a focused redesign of
`src/demo/chat-inspector.tsx` and the contextual inspector section of
`src/demo/chat-demo.css`, with corresponding focused tests. Unrelated chat
shell, mock data, production app, and native code must remain unchanged.
