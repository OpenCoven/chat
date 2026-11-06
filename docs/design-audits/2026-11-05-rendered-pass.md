# Rendered-screen pass for the design-language audit, 2026-11-05

Successor to the [2026-10-24 audit](2026-10-24-lucian-chat-design-language-audit.md), which
read source only. This pass renders the mounted UI and measures it. It covers the audit's
open findings 2, 4 and 5 and the mention-completion portal question in
[`design-authority.md`](../design-authority.md#portal-and-top-layer-scope). Tracking issue:
#533.

**Outcome.** The portal question is settled: the panel renders correctly, and the authority
doc said otherwise, so this change corrects it. Findings 2, 4 and 5 are confirmed in the
rendered window. Each now has measurements and a concrete candidate, and each needs a
decision before any product change. The pass also found a defect outside the audit: path
rows lose both ends in WebKit. It is fixed separately in #540. No product CSS or behavior
changes here.

## Method

- **What rendered:** the production build (`pnpm build`, served by `vite preview`) of `main`
  at `a8c76390` (v0.0.8), in Playwright 1.62.1 WebKit. WebKit is the engine of the macOS
  window. Keyboard focus was also walked in Chromium, for the reason given under *Other
  checks*.
- **Data:** a Tauri IPC fixture of the same kind as `e2e/app.tauri-mock.spec.ts`. It holds
  one saved chat (three long paragraphs, a heading, a list, an eight-column table, a code
  block with a long line, an attachment, and a Bash tool call with its result), a run held
  open on a running tool, and a failed run. The failure includes the `chat-diagnostic` notice
  that `record_run_failure` appends on the host (`src-tauri/src/coven_runtime.rs`).
- **Matrix:** dark and light; 480×520, 960×700 and 1680×1000; the **Default** and **Larger**
  text sizes; rails open and closed; reduced motion on and off.
- **Screens:** onboarding, empty chat, disconnected, long conversation (top and bottom),
  running tools, failed run, every Settings section, mention completion, keyboard focus.
- **Font:** Inter Variable is bundled (`src/main.tsx:1`), so measurements use the app's own
  font.
- **Rerun:** `corepack pnpm exec playwright test --config e2e/design-review/playwright.config.ts`.
  It writes about 300 screenshots and JSON measurements to `.artifacts/design-review/out/`
  (gitignored) in under a minute. It is not part of `test:e2e`.

**Not verified:** the packaged app's own WKWebView, WebView2 on Windows, WebKitGTK on Linux,
and real Coven output. The fixture reproduces the host's event shapes, not its timing.

## Mention-completion portal

**Settled: no defect.** The panel is portalled to `document.body`, outside `.fr-shell`, where
`--bg-raised` and `--border-strong` are unset and `--text-primary` is the historical
`#f4f1fa`. But `src/coven/mention-completion.tsx:66` copies six theme properties from the
composer onto the panel when it mounts. The panel's computed colours match the shell's
exactly:

| Scheme | Background | Border | Text | Same as the shell |
| --- | --- | --- | --- | --- |
| Dark | `#1c1c1f` | `#ffffff29` | `#f0eff4` | yes |
| Light | `#ffffff` | `#0000002e` | `#17171b` | yes |

`design-authority.md` claimed the panel fell back to initial values. That section now
describes the copy instead, and asks that a new portal either mount inside the shell or copy
its tokens the same way. Residual edge: the copy runs once per mount, so a scheme change
while the panel is open keeps the old colours until it next opens. No action proposed.

## Finding 2: prose measure

**Confirmed.** Characters per line in ordinary reply paragraphs, by window and rails. In Inter,
`1ch` (the width of "0") is about 1.33 characters of English prose, so both units are
given.

| Window | Rails | Default | Larger |
| --- | --- | --- | --- |
| 1680 wide | closed | **150–155 chars** (113ch) | 123–127 chars (93ch) |
| 1680 wide | open | 122–126 chars (92ch) | 100–103 chars (75ch) |
| 960 compact | closed | 107–110 chars (80ch) | 88–91 chars (66ch) |
| 960 compact | open | 76–79 chars (57ch) | 63–65 chars (47ch) |
| 480 narrow | (drawers) | 44–46 chars (33ch) | 36–37 chars (27ch) |

Only the compact window with rails open, or Larger text, lands in the conventional 45–75
range. With rails closed on a wide display, a paragraph line is about twice that long.

**Candidates rendered.** Both cap only ordinary prose blocks, and leave tables, code, tool
rows, attachments and the composer on the documented 1200px column:

```css
.coven-chat .coven-formatted > :is(p, ul:not(.coven-tools), ol, blockquote, h1, h2, h3, h4, h5, h6) {
  max-width: 72ch; /* or 60ch */
}
```

| Candidate | Chars per line where it binds | Binds when |
| --- | --- | --- |
| Current | up to 155 | never |
| `72ch` (inside the audit's 68–80ch band) | 96–99 | compact rails closed; wide either way |
| `60ch` | 80–82 | as above, plus wide and compact at Larger |

With either cap, code blocks keep the full column (1140px with rails closed), and the
eight-column table keeps its own horizontal scroll. The `.coven-tools` exclusion matters:
tool activity is a `ul` inside the formatted reply, and an unqualified `ul` cap shrinks the
tool rows too. The visible cost is empty space inside the reply card. At 1680 with rails
closed, the right ~40% of a prose-only card is empty.

The audit's 68–80ch band is about 90–106 characters per line in this font, which is wider
than the usual guidance. `60ch` is the candidate that reaches about 80.

**Decision needed (Val):** keep the current treatment, adopt `72ch`, or adopt `60ch`. Either
cap changes the README's reading-column paragraph, which should then say that prose holds a
measure inside the 1200px column. Compare
`cand-<scheme>-<window>-<size>-<rails>-<candidate>-{top,bottom}.png` from a run.

## Finding 4: supporting-text hierarchy

**Confirmed, and broader than the audit said.** The **Text size** setting scales message
bubbles only (`--coven-text-scale`). Everything else is fixed, including text the reader must
act on.

| Surface | Distinct sizes | Range | Follows Text size |
| --- | --- | --- | --- |
| Shell around the conversation | 11 | 8–16px | no |
| Settings (all seven sections) | 20 | 10.5–21px | only the preview sentence |
| Message bubbles | 1 | 16px × scale | yes |

At **Larger** (×1.22), measured at 480×520:

- The user's sent message is 19.52px. The failure banner that tells them what to do ("The run
  failed. Coven's report is the last line of the chat, and Try again resends your message.")
  is 12px.
- The run-failure **notice line** is transcript content (it is the "last line of the chat"
  the banner points to), yet it stays at 12px and ignores the text-size setting.
- The composer field stays 13px, so typed text grows by half once it is sent. This also holds
  at **Default**: 13px in the composer becomes 16px in the bubble.
- Settings hints that carry instructions ("Drag the inspector's left edge, or focus its
  Resize inspector handle…", "Leave it empty to use the engine's default…") are 12px at every
  text size.
- Smallest text on screen: the attachment type badge (`MD`) at 8px, and the Settings eyebrow
  at 10.5px.

Nothing was cut off at 480×520 at Larger. The Settings section list scrolls sideways there
("Devi…" at the edge), which is a working scroller, not lost content.

**Proposed role table (for decision):**

| Role | Covers | Today | Proposed | Follows Text size |
| --- | --- | --- | --- | --- |
| Body | Messages, transcript notice lines | 16px (notices 12px) | 16px; notices join it | yes, notices included |
| Instruction | Error banners, empty-state guidance, Settings hints, onboarding step text | 12–13px | 13.5px floor | yes |
| Control label | Buttons, nav items, segmented options, field text | 11–13.5px | 13px; composer field matches Body | composer field only |
| Metadata | Timestamps, eyebrows, counts, Copy labels, badges | 8–11px | 11px floor; badge 10px | no |

**Decision needed (Val):** whether Instruction text and the composer field should follow the
Text size setting. Today the setting is described as a transcript scale. Then whether to
adopt the floors above. The notice line ignoring the scale looks like an oversight, not a
choice, so a change PR can make it follow the scale if you agree.

## Finding 5: depth and spacing tokens

**Confirmed.** Distinct computed values across four screens (conversation with both rails,
mention completion, Settings, onboarding). The counts are the same in both schemes.

| Treatment | Distinct values | Values |
| --- | --- | --- |
| Corner radius | 13 | 3, 4, 5, 6, 8, 9, 11, 12, 14, 20, 24px, 50%, 999px |
| Box shadow | 22 | raised (bubble, card, button), inset rail hairlines, popover, presence and selection rings |
| Backdrop blur | 2 | `blur(8px)`, `blur(10px) saturate(1.4)`, both on `.fr-btn` |
| Flex and grid gap | 14 | 1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 16, 18, 20, 22px |
| Gradient fill | 14 | mostly 2–5% white top sheens, plus three lavender radial glows |

Both schemes looked coherent in every capture. The variety reads as local tuning, not as
visible inconsistency. The cost is maintenance: a new surface has no named treatment to
pick.

**Proposed scale (for decision):**

- **Radius:** 4 (inline: code, badges), 6 (small controls, rows), 8 (fields, code blocks,
  tool rows), 12 (cards, bubbles, popovers), 20 (dialogs, composer), pill. Today's 3, 5, 9,
  11, 14 and 24 map to their nearest step.
- **Depth:** *inset* (rail hairlines), *raised* (bubbles, cards, buttons), *floating*
  (popovers such as mention completion), *modal* (dialogs). Focus, presence and selection
  rings are state, not depth, and keep their own tokens.
- **Gap:** 2, 4, 6, 8, 12, 16, 20, 24. Today's 1px list separator stays as a hairline. 10px
  is the second most used gap (61 elements), so moving it is the largest visible change.

**Decision needed (Val):** adopt the scale, adjust it, or record that local values stay. An
adoption PR should change one treatment family at a time, with before-and-after captures from
this harness.

## Defect found: path rows lose both ends in WebKit

Not one of the audit's findings. `.coven-row-value--path` is meant to keep the end of a long
path and give way at the start. In WebKit it showed an ellipsis at the start *and* clipped the
end: the inspector's Workspace row read `…fixture/familiars/0/worl`. Chromium truncated the
end like any other value. Cause: `unicode-bidi: plaintext` undid the box's right-to-left
overflow. Fixed in #540, which wraps the six affected values in an isolated `<bdi>`. It renders
`…e/familiars/0/workspace` in both engines and adds an e2e regression test.

## Other checks

- **Reduced motion:** honoured. During a run, three animations play normally
  (`coven-tool-pip-pulse`, and `fr-thinking-bounce` on three dots). With `reduce`, none run.
- **Keyboard focus:** in Chromium, all 17 Tab stops in the main window show a visible
  indicator in both schemes. The composer and search fields draw theirs on the wrapper. In
  WebKit, Tab reaches only six stops and skips buttons, which is Safari's default unless the
  system keyboard-navigation setting is on. macOS WKWebView follows the same setting, so this
  is platform behavior, not an app defect.
- **Narrow window (480×520):** onboarding, empty chat, failure and Settings fit without page
  overflow in both schemes at Default and Larger.

## What closes #533

- **Portal question:** closed by this record and the authority-doc correction.
- **Findings 2, 4 and 5:** each closes on either a change PR or a recorded decision to keep
  the current treatment, after Val's decision above. Each change PR should attach
  before-and-after captures from `e2e/design-review/`.
