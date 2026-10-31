# OpenCoven Chat design language audit

Author: Lucian, Visual Design / Brand Steward. Date: 2026-10-24.

## Scope and evidence

Working target: `/Users/buns/Documents/GitHub/OpenCoven/chat`, inferred from the session's primary root. The user has not yet confirmed the target in response to the scope question. This audit applies only to OpenCoven Chat; it does not establish findings about Coven Cave or another project.

Reviewed source revision: `b95a1cbce18929d65e78e69302635acb13f50bdd`. The checkout was clean before this report was added. This is a source-based assessment of the mounted desktop UI, its CSS, primitives, brand guidance, onboarding, settings, transcript, and responsive contracts. No product code was changed. No visual acceptance or native interaction acceptance is claimed.

The entrypoint in `src/main.tsx` mounts `Onboarding` and `ChatApp`; `src/coven/chat-layout.tsx` imports the live `.fr-*` design system and the Chat overrides. `README.md` is the current product contract. The August design specification explicitly marks itself superseded and was treated as history.

## Design judgment

The current source expresses a restrained familiar-centered workspace: neutral layered surfaces, lavender presence accents, Inter interface typography, mono for technical material, and a larger reading surface. The crown-and-speech-bubble mark provides a clear product signature. My recommendation is to strengthen the rules that hold these elements together while preserving this direction.

A proposed governing sentence is: “A quiet workspace for attentive conversation: clear reading, restrained depth, and lavender that signals presence and action.” This is an editorial recommendation, not an existing approved brand rule.

## What to preserve

The shell declares complete dark and light palettes with semantic surface and text roles (`src/design/familiars-shell.css:10`). The brand guide preserves the crown geometry and distinguishes platform icon treatments (`assets/brand/README.md`). Both are useful foundations for consistency.

The transcript uses a default 16px reading size with user-selectable scaling, while the interface stays denser (`src/coven/chat-app.css:385`, `src/coven/preferences.ts:77`). The source includes explicit focus treatments, reduced-motion handling, and responsive rail behavior. These are established design accommodations, not omissions to rediscover.

## Findings, ordered by recommended attention

### 1. Clarify action hierarchy across the two component families

Evidence: `.fr-btn--primary` uses a lavender-tinted surface (`src/design/familiars-shell.css:428`), while the shared UI's `data-variant="primary"` uses the primary text color as a solid fill (`src/ui/ui.css:70`). The shared UI separately calls its lavender action `presence`.

This is verified semantic drift between APIs. It is not proof that mismatched primary buttons currently appear beside each other: the actual Send control explicitly uses `presence` (`src/ui/send-control.tsx:60`), and the inspected onboarding and mission actions use `FamButton` primary. The implementations already show an effort to align visible emphasis.

Recommendation: publish one action-role mapping for default, emphasized, destructive, and quiet actions, then map both component families to it. Decide whether lavender represents presence, action emphasis, or both with clearly defined contexts. Resolve the naming contract before adding more variants. Acceptance: a reference sheet shows every state in both schemes, and an action's role has the same meaning regardless of its component family.

### 2. Validate prose measure within the intentionally wide workspace

Evidence: Chat explicitly raises the transcript and composer container to 1200px and removes the familiar message width cap (`src/coven/chat-app.css:145`). The README documents this as intentional product behavior. The reviewed formatted-message rules do not give ordinary paragraphs an independent character-based measure.

Risk, inferred from source: long prose can become difficult to track when rails are closed on a wide display. This is a review candidate, not a verified rendered readability defect. The available width also benefits tables, code, and attachments.

Recommendation: compare ordinary paragraphs at approximately 68–80ch within the existing wide content region, alongside the current treatment. Keep rich content and the composer able to use the documented width. Select any change through visual comparison rather than silently replacing the existing contract. Acceptance: compare long prose, a wide table, code, and an attachment at default and largest text sizes with rails open and closed.

### 3. Make the current design authority explicit

Evidence: `src/styles.css` still introduces cyan circuitry, violet selection, sacred geometry, and platform-first typography. The mounted `.fr-shell` declares its own neutral palette, lavender focus, and Inter-first typography. The original design document referenced by the foundation is explicitly superseded. Settings can still reference the global `--accent-violet` token (`src/coven/settings-dialog.css:22`).

This verifies layered historical definitions and cross-layer dependencies; it does not prove that the current shell visibly displays the old cyan treatment. Scoped overrides intentionally replace much of it.

Recommendation: document the active visual rules in one maintained location, including the shell's authority, global resets, shared UI aliases, and portal scope. Mark historical visual guidance clearly. Preserve both palettes and existing behavior during any later consolidation. Acceptance: a contributor can identify the authoritative token for each role without consulting historical mockups.

### 4. Give supporting text a defined hierarchy

Evidence: the reading surface scales from a 16px default, but much supporting UI uses fixed 10–12px values. Settings alone includes 10.5, 11, 11.5, 12, 12.5, 13, and 13.5px declarations (`src/coven/settings-dialog.css`). The transcript preference is explicitly a transcript scale, not an application-wide scale.

Risk: fixed small explanatory text may be harder to read even when its nominal contrast passes. This is not a finding that all interface text must scale with the transcript, nor a verified accessibility failure.

Recommendation: define a small set of roles for body, control label, supporting explanation, and metadata; reserve the smallest sizes for genuinely secondary information. Review actionable settings hints and status explanations first. Acceptance: the role table explains each size and its purpose, with narrow-window and enlarged-content review of critical instructions.

### 5. Codify depth and spacing before further embellishment

Evidence: the shell defines control radius, focus, duration, and easing tokens, but many gaps, corner radii, shadow stacks, blur strengths, and gradients are local literals. Settings uses a 20px dialog radius with layered glows; buttons use their own gradient and inset shadow recipes (`src/coven/settings-dialog.css:6`, `src/design/familiars-shell.css:428`).

This is a maintenance and consistency concern, not evidence that every local value is wrong. Distinct surface roles can justify different geometry.

Recommendation: establish a short spacing scale and named depth treatments for controls, cards, popovers, and modal surfaces. Keep atmosphere concentrated around meaningful hierarchy. Acceptance: each distinct treatment has a purpose, and representative screens remain coherent in both schemes without requiring identical radii everywhere.

## Verification receipts and limits

Verified: source findings at the revision above, mounted entrypoint trace, clean starting checkout, and successful create/remove write probe in the primary root.

Verified independently: a Python sRGB contrast calculation parsed the shell's declared hex tokens and checked primary, secondary, muted, and accent text against all six declared surfaces, plus accent foreground against accent fill. All 25 pairs per scheme passed 4.5:1. The lowest dark ratio was 4.5943:1 for muted text on hover; the lowest light ratio was 4.9941:1 for the same role pair. This covers 50 nominal token pairs, not opacity, gradients, disabled states, focus visibility, every rendered element, or full accessibility conformance.

Incomplete: the existing focused tests were attempted with `corepack pnpm exec vitest run src/design/familiars-shell.css.test.ts src/styles.test.ts src/brand-assets.test.ts`. They did not start: `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found`. No dependency installation or unrelated repair was performed.

Blocked in this session: rendered-screen inspection. Automatic approval review rejected read-only access to the running Coven Cave application with “Computer Use was not approved to use Coven Cave.” Chat itself was not running in the application inventory. No current screenshot or native interaction evidence was collected, and historical README validation claims were not adopted as fresh results.

Incomplete: confirmation that Chat is the user's intended project. If another project is named, this report remains scoped to Chat and must not be relabeled as evidence for that project.

## Visual continuation

Once the target and a viewable surface are available, inspect onboarding, empty conversation, long prose, mixed tool activity, settings, and failure/recovery states in both schemes. Include the documented 480×520 minimum, compact and medium rail layouts, and a wide view with rails closed. Review default and largest text sizes, keyboard focus, and reduced motion. Use those observations to decide whether the source risks produce visible problems before making product changes.
