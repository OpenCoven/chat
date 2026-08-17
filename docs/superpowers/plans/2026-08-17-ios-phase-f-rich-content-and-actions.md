# iOS Phase F: Rich Content and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every rich block a familiar can emit as a native SwiftUI view, upload and display attachments, and execute privileged actions — all without a web view, without a render-time network request, and without an action ever firing from anything but a direct human gesture.

**Architecture:** `cave-core` gains a `markup` module: a total, allocation-bounded parser that turns untrusted turn text into a `Block` AST carrying no executable anything. The grammar is not invented here — Cave already emits it, and this is a port with a vector file proving the two agree. `cave-core` also gains typed action and conversation mutations. `chat-ios-ffi` mirrors the AST across the FFI boundary, stages and uploads attachments from disk, and keeps a durable action journal so a confirmed action carries one idempotency key for its whole life. Swift renders blocks with native views and owns every confirmation gesture.

**Tech Stack:** Swift 6, SwiftUI, iOS 17, ImageIO, UniformTypeIdentifiers, PhotosUI, SafariServices, UniFFI 0.32, Rust 1.95.0, tokio.

**Depends on:** `2026-08-16-ios-phase-e-send-stream-recovery.md`.

**Boundary:** No push, no background refresh, no doorbell relay, no accessibility audit sweep, no device matrix. Those are Phase G. This phase renders content and executes actions; it does not notify.

---

## Contract Grounding

The marker grammar is **already implemented and shipping in Cave**. Nothing in this phase gets to invent syntax. The authorities, in the Cave repository:

| Concern | Cave source |
|---|---|
| What familiars are taught to emit | `src/lib/coven-marker-directive.ts` |
| Code-range exclusion, GitHub cards and actions | `src/lib/github-blocks.ts` |
| Image markers and carousel merging | `src/lib/image-blocks.ts` |
| Skill stage markers | `src/lib/skill-blocks.ts` |
| `/auto` mission status markers | `src/lib/auto-status-blocks.ts` |
| Attention markers | `src/lib/chat-attention-marker.ts` |
| `spec` and `handoff` fenced documents | `src/lib/spec-blocks.ts` |
| Footnote citations | `src/lib/citations.ts` |

The catalog, as `buildCovenMarkersDirective` teaches it:

```
<coven:github kind="pr|issue|commit|run" repo="owner/repo" number="123" sha="…" run="…" title="…" />
<coven:github-action kind="comment|reply|resolve|unresolve|issue-create|issue-state|review|merge|rerun|dispatch" repo="owner/repo" … />
<coven:image src="https://…" alt="…" caption="…" group="…" />
<coven:skill name="…" stage="loaded|running|done|error" note="…" />
<coven:auto-status state="clarifying|working|blocked|failed|done" note="…" />
<coven:attention reason="input|approval|credentials|decision" />

```coven:attachment
{"path":"/absolute/path","name":"file.png"}
```

````spec title="Short title"
# Short title
````

````handoff title="Short handoff title"
# Short handoff title
````

[^1] inline, defined as: [^1]: https://example.com "Title" — one-sentence summary
```

Rules that come with the grammar and are not negotiable here:

- Attribute values are always double-quoted. A `>` inside a quoted value does not terminate the marker.
- Markers inside code fences and inline code stay literal example text.
- A repeated `skill` marker with the same `name` updates that card; the **last** stage per name wins.
- A repeated `auto-status` marker updates in place; the last state wins.
- Adjacent `image` markers, or markers sharing a `group`, collapse into one carousel, capped at 24 (`MAX_CAROUSEL_IMAGES`).
- `image/svg+xml` is not a renderable image source. Neither is any `/api/` path other than the read-only attachment route.

- [ ] **Before starting Task 1, re-read the directive**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
cat src/lib/coven-marker-directive.ts
git log --oneline -5 -- src/lib/coven-marker-directive.ts src/lib/github-blocks.ts
```

If the directive has gained a marker family since this plan was written, add it to Task 2 and to the vector file in Task 5. If a family here no longer exists, it still must parse — old transcripts contain it — but it renders through the same path.

### The Action Contract

From the desktop program's `2026-08-15-phase-4-rich-content-attachments-actions.md`:

```ts
export const CLIENT_V1_ATTACHMENT_LIMITS = {
  maxFiles: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxRequestBytes: 25 * 1024 * 1024,
} as const;

export type GitHubActionInput =
  | { kind: "comment"; repo: string; number: number; body: string }
  | { kind: "reply"; repo: string; number: number; body: string }
  | { kind: "resolve"; repo: string; number: number; threadId: string }
  | { kind: "unresolve"; repo: string; number: number; threadId: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string }
  | { kind: "issue-state"; repo: string; number: number; state: "open" | "closed" }
  | { kind: "review"; repo: string; number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }
  | { kind: "merge"; repo: string; number: number; method: "squash" | "merge" | "rebase" }
  | { kind: "rerun"; repo: string; runId: string }
  | { kind: "dispatch"; repo: string; workflow: string; ref: string };
```

Supported upload MIME types: PNG, JPEG, WebP, GIF, PDF, UTF-8 plain text, MP3, WAV, M4A. SVG, archives, executables, and any extension/MIME disagreement are rejected.

- [ ] **Before starting Task 7, verify the routes exist**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
ls src/app/api/client/v1/attachments src/app/api/client/v1/attention \
   src/app/api/client/v1/tasks src/app/api/client/v1/github 2>/dev/null
```

If these are absent, Cave's Phase 4 has not landed. Tasks 1 through 6 and 12 are pure client work and proceed regardless; Tasks 7 through 11 and 13 through 15 are written against the contract above and cannot be live-tested until Cave has it. Cave is the authority. If a shape differs, change this plan, never Cave.

---

## Working Directories

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git worktree add -b feat/ios-phase-f-sdk .worktrees/ios-phase-f-sdk feat/ios-phase-e-sdk

cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-f
```

---

## Critical Rules

- **No web view. Ever.** Not `WKWebView`, not `import WebKit`, not an `AttributedString(markdown:)` path that renders HTML. Task 16 adds a CI grep that fails the build on any WebKit symbol. `SFSafariViewController` is permitted and is not a rendering surface — it opens a URL the user explicitly tapped, in a process the app cannot script.
- **Rendering never performs a network request.** Remote images and citation previews display a domain and a placeholder until the user asks for them. A transcript that silently contacts a third party is the failure this rule exists to prevent.
- **Unknown or malformed markers become `Unsupported`.** Never dropped silently, never rendered as interactive UI, never rendered as raw HTML.
- **Every action requires a distinct human gesture.** Rendering a proposal card performs zero calls. One confirmation authorizes exactly one mutation.
- **An action is `Completed` only from a successful Cave response.** Not from optimism, not from a timeout, not from a 202 with an unread body.
- **An ambiguous action outcome is never automatically retried.** Same rule as Phase E's outbox, extended to actions. Reconcile, then let the user decide.
- **The bearer never appears in a URL, a log, an error, or an image request that any framework could cache.**
- **Attachment type comes from sniffed content, not the file extension.**
- **No GPL dependency.** D1's CI check still runs. Use system ImageIO for HEIC; do not add `libheif`, ImageMagick, or a GPL image crate.
- **Every commit signed.** Pass `-S`. **Do not push.**
- **No emojis** in commits or code.
- **Swift 6 strict concurrency**; views touching `CaveStore` or `ThreadModel` are `@MainActor`.
- **Generated symbol names are authoritative.** Read `app/Sources/Generated/*.swift` after the first build and adjust the Swift here, never the Rust.

---

## File Map

### SDK `crates/coven-transport`
- Create `src/multipart.rs` — streaming multipart upload from a file path.
- Modify `src/fetch.rs` — download to a file, bounded.
- Modify `src/lib.rs`.

### SDK `crates/cave-core`
- Create `src/markup/mod.rs` — public parse entry point.
- Create `src/markup/scan.rs` — code ranges and the marker scanner.
- Create `src/markup/blocks.rs` — the `Block` AST and marker-to-block mapping.
- Create `src/markup/action.rs` — the action grammar: markers to typed requests.
- Create `src/markup/document.rs` — `spec`/`handoff` fences.
- Create `src/markup/citation.rs` — footnote citations.
- Create `src/markup/inline.rs` — markdown to spans.
- Create `fixtures/markup-vectors.json` — shared parity vectors.
- Create `src/actions.rs` — action requests, results, and conversation mutations.
- Modify `src/lib.rs`.

### chat-ios
- Create `rust/ffi/src/content.rs` — the FFI AST mirror and per-message parse cache.
- Create `rust/ffi/src/attachments.rs` — staging, upload, and the media cache.
- Create `rust/ffi/src/journal.rs` — the durable action journal.
- Modify `rust/ffi/src/session.rs`, `lib.rs`, `types.rs`.
- Create `app/Sources/Content/BlockView.swift`, `MarkdownView.swift`, `CodeBlockView.swift`, `ImageCarouselView.swift`, `CitationView.swift`, `DocumentCardView.swift`, `DocumentReaderView.swift`, `StatusCardView.swift`, `ToolCardView.swift`, `GitHubCardView.swift`, `UnsupportedBlockView.swift`.
- Create `app/Sources/Actions/ActionCardView.swift`, `ConfirmationSheet.swift`, `AttentionCardView.swift`.
- Create `app/Sources/Support/MediaLoader.swift`, `AttachmentStager.swift`, `SafariLink.swift`.
- Create `app/Sources/Views/AttachmentTrayView.swift`, `ConversationMenu.swift`.
- Modify `app/Sources/Views/ThreadView.swift`, `ComposerView.swift`, `ConversationListView.swift`, `app/Sources/Support/ThreadModel.swift`, `CaveStore.swift`, `project.yml`.
- Create `app/Tests/BlockRenderingTests.swift`, `ActionGestureTests.swift`, `AttachmentStagerTests.swift`.
- Modify `.github/workflows/ci.yml`.

---

## Task 1: Code Ranges and the Marker Scanner

Everything downstream depends on knowing which byte offsets are inside code. Cave's `markdownCodeRanges` is the reference implementation, and it handles the cases a naive fence scanner gets wrong: backtick runs of arbitrary length, inline spans that must be matched by delimiter length, and inline scanning that skips over fenced regions rather than tripping on their backticks.

**Files:** Create `crates/cave-core/src/markup/scan.rs`, `crates/cave-core/src/markup/mod.rs`; modify `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/cave-core/src/markup/scan.rs` with the tests only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn covered(text: &str, needle: &str) -> bool {
        let at = text.find(needle).expect("needle present");
        code_ranges(text).iter().any(|r| at >= r.start && at < r.end)
    }

    #[test]
    fn fenced_marker_is_inside_code() {
        let text = "before\n```\n<coven:attention reason=\"input\" />\n```\nafter";
        assert!(covered(text, "<coven:attention"));
    }

    #[test]
    fn inline_code_marker_is_inside_code() {
        assert!(covered("say `<coven:skill name=\"x\" />` here", "<coven:skill"));
    }

    #[test]
    fn a_marker_outside_code_is_not_covered() {
        assert!(!covered("plain <coven:skill name=\"x\" /> text", "<coven:skill"));
    }

    #[test]
    fn a_double_backtick_span_survives_a_single_backtick_inside() {
        let text = "``a ` b <coven:skill name=\"x\" />``";
        assert!(covered(text, "<coven:skill"));
    }

    #[test]
    fn backticks_inside_a_fence_do_not_open_an_inline_span() {
        let text = "```\n`\n```\n<coven:skill name=\"x\" />";
        assert!(!covered(text, "<coven:skill"));
    }

    #[test]
    fn an_unterminated_fence_covers_the_rest_of_the_text() {
        let text = "```\n<coven:skill name=\"x\" />";
        assert!(covered(text, "<coven:skill"));
    }

    #[test]
    fn an_unterminated_inline_span_covers_nothing() {
        // A lone backtick is ordinary prose, not an open span. Treating it as
        // one would silently swallow every marker after any stray backtick.
        assert!(!covered("a ` b <coven:skill name=\"x\" />", "<coven:skill"));
    }

    #[test]
    fn scans_a_well_formed_marker() {
        let found = scan_markers("x <coven:skill name=\"a\" stage=\"done\" /> y");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "skill");
        assert_eq!(found[0].attr("name"), Some("a"));
        assert_eq!(found[0].attr("stage"), Some("done"));
    }

    #[test]
    fn a_quoted_angle_bracket_does_not_end_the_marker() {
        let found = scan_markers("<coven:skill name=\"a\" note=\"x > y\" />");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].attr("note"), Some("x > y"));
    }

    #[test]
    fn a_duplicate_attribute_is_malformed() {
        let found = scan_markers("<coven:skill name=\"a\" name=\"b\" />");
        assert_eq!(found.len(), 1);
        assert!(found[0].malformed);
    }

    #[test]
    fn an_unquoted_value_is_malformed() {
        let found = scan_markers("<coven:skill name=a />");
        assert_eq!(found.len(), 1);
        assert!(found[0].malformed);
    }

    #[test]
    fn a_control_character_in_a_value_is_malformed() {
        let found = scan_markers("<coven:image src=\"java\u{0a}script:x\" />");
        assert_eq!(found.len(), 1);
        assert!(found[0].malformed);
    }

    #[test]
    fn an_unterminated_marker_is_not_scanned() {
        assert!(scan_markers("<coven:skill name=\"a\"").is_empty());
    }

    #[test]
    fn markers_inside_code_are_not_scanned() {
        assert!(scan_markers("`<coven:skill name=\"a\" />`").is_empty());
    }

    #[test]
    fn does_not_panic_on_arbitrary_input() {
        for text in ["", "`", "```", "<coven:", "<coven: />", "\u{fffd}<coven:x />"] {
            let _ = code_ranges(text);
            let _ = scan_markers(text);
        }
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup::scan 2>&1 | tail -20
```

Expected: FAIL to compile — `code_ranges` and `scan_markers` do not exist.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/markup/scan.rs`:

```rust
//! Byte-offset scanning over untrusted turn text.
//!
//! Two jobs, in order: find the regions that are code (a marker inside a code
//! fence is example text and must stay literal), then find the markers that
//! are not in those regions.
//!
//! This is a port of Cave's `markdownCodeRanges` and the per-family marker
//! regexes in `github-blocks.ts`, `image-blocks.ts`, `skill-blocks.ts`,
//! `auto-status-blocks.ts`, and `chat-attention-marker.ts`. Behaviour
//! differences from those files are bugs here, not improvements. The vector
//! file in `fixtures/markup-vectors.json` is what keeps that honest.

use std::collections::BTreeMap;
use std::ops::Range;

/// Longest turn text this module will scan.
///
/// Past this the text is treated as code-free prose and rendered as plain
/// text. A transcript is not a place to spend unbounded time on a quadratic
/// worst case supplied by a model.
pub const MAX_SCAN_BYTES: usize = 512 * 1024;

/// Largest number of markers taken from one turn.
pub const MAX_MARKERS: usize = 256;

/// A scanned marker, before any family-specific meaning is applied.
#[derive(Debug, Clone)]
pub struct ScannedMarker {
    /// Family name after the `coven:` prefix, lowercased.
    pub name: String,
    /// Byte range of the whole marker, including the delimiters.
    pub span: Range<usize>,
    /// The literal source, for an unsupported card.
    pub source: String,
    /// Attributes in source order. Empty when `malformed`.
    attrs: BTreeMap<String, String>,
    /// Set when the marker matched the family prefix but not the grammar.
    pub malformed: bool,
}

impl ScannedMarker {
    /// One attribute value.
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).map(String::as_str)
    }

    /// Whether an attribute was supplied at all.
    pub fn has(&self, key: &str) -> bool {
        self.attrs.contains_key(key)
    }
}

/// Byte ranges of fenced and inline code.
pub fn code_ranges(text: &str) -> Vec<Range<usize>> {
    if text.len() > MAX_SCAN_BYTES {
        return Vec::new();
    }
    let fences = fenced_ranges(text);
    let bytes = text.as_bytes();
    let mut out = fences.clone();
    let mut cursor = 0usize;
    let mut fence_index = 0usize;

    while cursor < bytes.len() {
        while fence_index < fences.len() && cursor >= fences[fence_index].end {
            fence_index += 1;
        }
        if let Some(fence) = fences.get(fence_index) {
            if cursor >= fence.start {
                cursor = fence.end;
                continue;
            }
        }
        if bytes[cursor] != b'`' {
            cursor += 1;
            continue;
        }

        let start = cursor;
        while cursor < bytes.len() && bytes[cursor] == b'`' {
            cursor += 1;
        }
        let delimiter = cursor - start;

        // Find a run of exactly the same length that is not inside a fence.
        let mut search = cursor;
        let mut search_fence = fence_index;
        let mut closing_end = None;
        while search < bytes.len() {
            while search_fence < fences.len() && search >= fences[search_fence].end {
                search_fence += 1;
            }
            if let Some(fence) = fences.get(search_fence) {
                if search >= fence.start {
                    search = fence.end;
                    continue;
                }
            }
            if bytes[search] != b'`' {
                search += 1;
                continue;
            }
            let run_start = search;
            while search < bytes.len() && bytes[search] == b'`' {
                search += 1;
            }
            if search - run_start == delimiter {
                closing_end = Some(search);
                break;
            }
        }

        match closing_end {
            Some(end) => {
                out.push(start..end);
                cursor = end;
            }
            // An unterminated inline span is a stray backtick in prose. It
            // covers nothing; the alternative swallows the rest of the turn.
            None => cursor = start + delimiter,
        }
    }

    out.sort_by_key(|r| r.start);
    out
}

/// Byte ranges of fenced code blocks, including their delimiter lines.
fn fenced_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut open: Option<(usize, u8, usize)> = None;

    for line in line_spans(text) {
        let content = &text[line.start..line.content_end];
        let trimmed = content.trim_start_matches(' ');
        let indent = content.len() - trimmed.len();
        if indent > 3 {
            continue;
        }
        let marker = trimmed.as_bytes().first().copied();
        let Some(marker) = marker.filter(|b| *b == b'`' || *b == b'~') else {
            continue;
        };
        let run = trimmed.bytes().take_while(|b| *b == marker).count();
        if run < 3 {
            continue;
        }

        match open {
            None => open = Some((line.start, marker, run)),
            Some((start, open_marker, open_run)) => {
                // A closing fence matches the opener's character and is at
                // least as long. Anything else is content.
                let rest = trimmed[run..].trim();
                if marker == open_marker && run >= open_run && rest.is_empty() {
                    out.push(start..line.end);
                    open = None;
                }
            }
        }
    }

    // An unterminated fence runs to the end of the text. A model that is mid
    // fence has not produced prose we should be scanning for markers.
    if let Some((start, _, _)) = open {
        out.push(start..text.len());
    }
    out
}

/// One source line with its offsets.
pub(crate) struct LineSpan {
    pub start: usize,
    pub content_end: usize,
    pub end: usize,
}

/// Line spans, carriage returns excluded from the content.
pub(crate) fn line_spans(text: &str) -> Vec<LineSpan> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while start <= text.len() {
        let rest = &text[start..];
        let (content_end, end) = match rest.find('\n') {
            Some(offset) => (start + offset, start + offset + 1),
            None => (text.len(), text.len() + 1),
        };
        let content_end = if content_end > start && text.as_bytes()[content_end - 1] == b'\r' {
            content_end - 1
        } else {
            content_end
        };
        out.push(LineSpan { start, content_end, end: end.min(text.len()) });
        if end > text.len() {
            break;
        }
        start = end;
    }
    out
}

/// Markers outside code, in source order.
pub fn scan_markers(text: &str) -> Vec<ScannedMarker> {
    if text.len() > MAX_SCAN_BYTES {
        return Vec::new();
    }
    let ranges = code_ranges(text);
    let in_code = |at: usize| ranges.iter().any(|r| at >= r.start && at < r.end);

    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("<coven:") {
        let start = cursor + offset;
        cursor = start + "<coven:".len();
        if in_code(start) {
            continue;
        }
        let Some(marker) = scan_one(text, start) else {
            continue;
        };
        cursor = marker.span.end;
        out.push(marker);
        if out.len() >= MAX_MARKERS {
            break;
        }
    }
    out
}

/// Scan a single marker beginning at `start`.
///
/// Returns `None` only when there is no terminator at all — an incomplete
/// marker at the tail of a streaming turn. A complete-but-wrong marker returns
/// `Some` with `malformed` set, because the user must see that something was
/// there rather than watch it vanish.
fn scan_one(text: &str, start: usize) -> Option<ScannedMarker> {
    let bytes = text.as_bytes();
    let mut at = start + "<coven:".len();

    let name_start = at;
    while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'-') {
        at += 1;
    }
    let name = text.get(name_start..at)?.to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }

    // Walk to the terminator, treating quoted runs as atomic.
    let attrs_start = at;
    let mut in_quotes = false;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => in_quotes = !in_quotes,
            b'>' if !in_quotes => break,
            _ => {}
        }
        at += 1;
    }
    if at >= bytes.len() || in_quotes {
        return None;
    }
    let end = at + 1;
    let raw = &text[attrs_start..at];
    let source = text[start..end].to_string();
    let (attrs, malformed) = parse_attrs(raw);

    Some(ScannedMarker {
        name,
        span: start..end,
        source,
        attrs: if malformed { BTreeMap::new() } else { attrs },
        malformed,
    })
}

/// Parse the attribute segment. Anything but `key="value"` pairs separated by
/// whitespace, optionally ending in `/`, is malformed.
fn parse_attrs(raw: &str) -> (BTreeMap<String, String>, bool) {
    let mut out = BTreeMap::new();
    let mut rest = raw.trim_end().trim_end_matches('/').trim();

    while !rest.is_empty() {
        let Some(equals) = rest.find('=') else {
            return (BTreeMap::new(), true);
        };
        let key = rest[..equals].trim();
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return (BTreeMap::new(), true);
        }
        let after = rest[equals + 1..].trim_start();
        if !after.starts_with('"') {
            return (BTreeMap::new(), true);
        }
        let Some(close) = after[1..].find('"') else {
            return (BTreeMap::new(), true);
        };
        let value = &after[1..1 + close];
        if value.chars().any(|c| c.is_control()) {
            return (BTreeMap::new(), true);
        }
        if out.insert(key.to_ascii_lowercase(), value.to_string()).is_some() {
            return (BTreeMap::new(), true);
        }
        rest = after[1 + close + 1..].trim_start();
    }

    (out, false)
}
```

Create `crates/cave-core/src/markup/mod.rs`:

```rust
//! Untrusted turn text to a safe, non-executable block tree.

pub mod scan;

pub use scan::{code_ranges, scan_markers, ScannedMarker, MAX_MARKERS, MAX_SCAN_BYTES};
```

Add `pub mod markup;` to `crates/cave-core/src/lib.rs`.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup::scan
cargo clippy -p cave-core --all-targets -- -D warnings
git add crates/cave-core
git commit -S -m "Add code-range and marker scanning to cave-core

Ported from Cave's markdownCodeRanges and the per-family marker regexes.
An unterminated inline span covers nothing, which is the difference
between one stray backtick and a swallowed transcript."
```

---

## Task 2: The Block AST

The scanner says what is there. This task says what it means, and — more importantly — refuses to say anything about input it does not understand.

**Files:** Create `crates/cave-core/src/markup/blocks.rs`; modify `crates/cave-core/src/markup/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/cave-core/src/markup/blocks.rs` with tests only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(text: &str) -> Vec<Block> {
        parse_blocks(text, ParseMode::Final)
    }

    #[test]
    fn plain_text_is_one_text_block() {
        let out = blocks("hello there");
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Block::Text { .. }));
    }

    #[test]
    fn a_github_marker_becomes_a_card_between_text() {
        let out = blocks("see <coven:github kind=\"pr\" repo=\"o/r\" number=\"7\" /> now");
        assert_eq!(out.len(), 3);
        assert!(matches!(&out[1], Block::GitHubCard(card) if card.number == Some(7)));
    }

    #[test]
    fn a_bad_repo_is_unsupported_not_a_card() {
        let out = blocks("<coven:github kind=\"pr\" repo=\"../etc\" number=\"7\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn a_malformed_marker_is_unsupported_and_keeps_its_source() {
        let out = blocks("<coven:skill name=a />");
        match &out[0] {
            Block::Unsupported { source, .. } => assert!(source.contains("coven:skill")),
            other => panic!("expected unsupported, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_family_is_unsupported() {
        let out = blocks("<coven:hologram src=\"x\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn adjacent_images_merge_into_one_carousel() {
        let out = blocks(
            "<coven:image src=\"https://a/1.png\" />\n<coven:image src=\"https://a/2.png\" />",
        );
        match &out[0] {
            Block::Carousel(deck) => assert_eq!(deck.images.len(), 2),
            other => panic!("expected carousel, got {other:?}"),
        }
    }

    #[test]
    fn separated_images_sharing_a_group_merge() {
        let out = blocks(
            "<coven:image src=\"https://a/1.png\" group=\"g\" />\nprose\n<coven:image src=\"https://a/2.png\" group=\"g\" />",
        );
        let decks: Vec<_> = out.iter().filter(|b| matches!(b, Block::Carousel(_))).collect();
        assert_eq!(decks.len(), 1);
    }

    #[test]
    fn a_deck_is_capped() {
        let one = "<coven:image src=\"https://a/x.png\" group=\"g\" />";
        let out = blocks(&one.repeat(40));
        match out.iter().find(|b| matches!(b, Block::Carousel(_))) {
            Some(Block::Carousel(deck)) => assert_eq!(deck.images.len(), MAX_CAROUSEL_IMAGES),
            _ => panic!("expected carousel"),
        }
    }

    #[test]
    fn an_svg_source_is_rejected() {
        let out = blocks("<coven:image src=\"data:image/svg+xml;base64,PHN2Zz4=\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn an_arbitrary_api_path_is_rejected() {
        let out = blocks("<coven:image src=\"/api/client/v1/credentials\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn the_attachment_route_is_accepted() {
        let out = blocks("<coven:image src=\"/api/chat/attachment?id=abc\" />");
        assert!(matches!(&out[0], Block::Carousel(_)));
    }

    #[test]
    fn a_javascript_url_is_rejected_even_with_a_smuggled_newline() {
        let out = blocks("<coven:image src=\"java\nscript:alert(1)\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn the_last_skill_stage_per_name_wins() {
        let out = blocks(
            "<coven:skill name=\"a\" stage=\"running\" /><coven:skill name=\"a\" stage=\"done\" />",
        );
        let cards: Vec<_> = out.iter().filter(|b| matches!(b, Block::SkillStage(_))).collect();
        assert_eq!(cards.len(), 1);
        match cards[0] {
            Block::SkillStage(card) => assert_eq!(card.stage, SkillStage::Done),
            _ => unreachable!(),
        }
    }

    #[test]
    fn auto_status_accepts_the_documented_aliases() {
        let out = blocks("<coven:auto-status state=\"complete\" note=\"n\" />");
        match &out[0] {
            Block::AutoStatus(card) => assert_eq!(card.state, AutoState::Done),
            other => panic!("expected auto status, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_auto_state_is_unsupported() {
        let out = blocks("<coven:auto-status state=\"vibing\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn attention_carries_its_reason() {
        let out = blocks("Choose one.\n<coven:attention reason=\"decision\" />");
        assert!(out.iter().any(|b| matches!(b, Block::Attention(a) if a.reason == AttentionReason::Decision)));
    }

    #[test]
    fn a_github_action_is_a_proposal_never_a_result() {
        let out = blocks(
            "<coven:github-action kind=\"merge\" repo=\"o/r\" number=\"7\" method=\"squash\" />",
        );
        match &out[0] {
            Block::ActionProposal(p) => {
                assert!(matches!(p.action, ActionRequestKind::GitHub(_)));
                assert!(p.idempotency_hint.is_none());
            }
            other => panic!("expected proposal, got {other:?}"),
        }
    }

    #[test]
    fn an_action_missing_a_required_field_is_unsupported() {
        let out = blocks("<coven:github-action kind=\"merge\" repo=\"o/r\" number=\"7\" />");
        assert!(matches!(&out[0], Block::Unsupported { .. }));
    }

    #[test]
    fn a_marker_in_a_fence_stays_text() {
        let out = blocks("```\n<coven:attention reason=\"input\" />\n```");
        assert!(out.iter().all(|b| !matches!(b, Block::Attention(_))));
    }

    #[test]
    fn a_partial_trailing_marker_is_withheld_while_streaming() {
        let out = parse_blocks("answer <coven:atten", ParseMode::Streaming);
        match &out[0] {
            Block::Text { text, .. } => assert_eq!(text.trim(), "answer"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_partial_trailing_marker_is_literal_once_final() {
        let out = parse_blocks("answer <coven:atten", ParseMode::Final);
        match &out[0] {
            Block::Text { text, .. } => assert!(text.contains("<coven:atten")),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn every_prefix_of_a_marker_parses_without_panicking() {
        let full = "text <coven:image src=\"https://a/1.png\" alt=\"a\" /> tail";
        for end in 0..=full.len() {
            if full.is_char_boundary(end) {
                let _ = parse_blocks(&full[..end], ParseMode::Streaming);
            }
        }
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup::blocks 2>&1 | tail -20
```

Expected: FAIL to compile.

- [ ] **Step 3: Implement the AST**

Prepend to `crates/cave-core/src/markup/blocks.rs`:

```rust
//! The block tree. Data only: nothing here can execute, navigate, or fetch.

use super::scan::{scan_markers, ScannedMarker};
use std::collections::HashMap;

/// Hard cap per carousel, matching Cave's `MAX_CAROUSEL_IMAGES`.
pub const MAX_CAROUSEL_IMAGES: usize = 24;

/// Whether the text is still arriving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseMode {
    /// Mid-stream. A trailing marker prefix is withheld rather than shown.
    Streaming,
    /// The turn is complete. What is there is what there is.
    Final,
}

/// Why something could not be rendered as itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsupportedReason {
    /// The family is not one this client knows.
    UnknownFamily,
    /// The family is known; the attributes are not valid for it.
    Malformed,
    /// A URL or path this client will not render.
    RejectedSource,
    /// Refers to a file on the machine running Cave, which this device has no
    /// access to. Rendering it as an image would be a lie.
    WorkspaceLocal,
}

/// One renderable block.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// Prose. `spans` is the parsed inline tree; `text` is the source.
    Text { text: String, spans: Vec<super::inline::Span> },
    /// A fenced code block.
    Code { language: Option<String>, source: String },
    /// One or more images browsed together.
    Carousel(Carousel),
    /// A GitHub item card.
    GitHubCard(GitHubCard),
    /// A proposed mutation. Renders as an offer, never as a result.
    ActionProposal(ActionProposal),
    /// A skill's current stage.
    SkillStage(SkillCard),
    /// An `/auto` mission's current state.
    AutoStatus(AutoStatusCard),
    /// The familiar cannot continue without a person.
    Attention(AttentionCard),
    /// A `spec` or `handoff` fenced document.
    Document(DocumentCard),
    /// Footnote sources collected from the turn.
    Citations(Vec<Citation>),
    /// Present, understood to be a marker, not rendered as one.
    Unsupported { source: String, reason: UnsupportedReason },
}

/// A deck of pictures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Carousel {
    pub images: Vec<ImageRef>,
    pub group: Option<String>,
}

/// One picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// Validated before construction; see `renderable_source`.
    pub source: ImageSource,
    pub alt: Option<String>,
    pub caption: Option<String>,
}

/// Where a picture's bytes come from. The variants exist so the renderer
/// cannot accidentally hand a remote URL to something that auto-loads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageSource {
    /// An `https:` URL. Loaded only on an explicit user gesture.
    Remote { url: String, host: String },
    /// A Cave attachment, fetched through the authenticated transport.
    Attachment { id: String },
    /// A bounded inline `data:image/...;base64` payload.
    Inline { mime: String, base64: String },
}

/// A GitHub item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubCard {
    pub kind: GitHubCardKind,
    pub repo: String,
    pub number: Option<u64>,
    pub sha: Option<String>,
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub title: Option<String>,
}

/// Item kinds a card can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubCardKind {
    Pr,
    Issue,
    ReviewThread,
    Commit,
    Run,
}

/// A mutation a familiar has proposed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionProposal {
    pub action: ActionRequestKind,
    /// Human-readable summary shown on the confirmation sheet.
    pub summary: String,
    /// Always `None` from parsing. A key is minted by the journal at
    /// confirmation time, never taken from model output.
    pub idempotency_hint: Option<String>,
}

/// The action families a proposal can carry. Defined in `super::action`,
/// beside the grammar that produces them — `crate::actions` owns executing
/// one, which is a separate concern from recognising one.
pub use super::action::ActionRequestKind;

/// A skill's stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCard {
    pub name: String,
    pub stage: SkillStage,
    pub note: Option<String>,
}

/// Skill lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillStage {
    Loaded,
    Running,
    Done,
    Error,
}

/// An `/auto` mission's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoStatusCard {
    pub state: AutoState,
    pub note: Option<String>,
}

/// Mission states. `timed-out` is deliberately absent: it is what the client
/// concludes when the model says nothing, so accepting it from the model
/// would defeat the point. Cave's `auto-status-blocks.ts` says the same.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoState {
    Clarifying,
    Working,
    Blocked,
    Failed,
    Done,
}

/// A request for a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionCard {
    pub reason: AttentionReason,
}

/// Why the familiar stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionReason {
    Input,
    Approval,
    Credentials,
    Decision,
}

/// A `spec` or `handoff` document. Defined in `super::document`.
pub use super::document::DocumentCard;

/// A footnote source. Defined in `super::citation`.
pub use super::citation::Citation;
```

- [ ] **Step 4: Implement the parser**

Append to `crates/cave-core/src/markup/blocks.rs`:

```rust
/// Parse one turn's text into blocks.
///
/// Total: every input produces a block list, and text that means nothing to
/// this client survives as text or as `Unsupported`. Nothing is dropped.
pub fn parse_blocks(text: &str, mode: ParseMode) -> Vec<Block> {
    let (body, citations) = super::citation::split_citations(text);
    let (body, documents) = super::document::extract_documents(&body);

    let visible = match mode {
        ParseMode::Streaming => withhold_trailing_prefix(&body),
        ParseMode::Final => body.clone(),
    };

    let markers = scan_markers(&visible);
    let mut out: Vec<Block> = Vec::new();
    let mut cursor = 0usize;
    let mut skill_slots: HashMap<String, usize> = HashMap::new();
    let mut auto_slot: Option<usize> = None;
    let mut group_slots: HashMap<String, usize> = HashMap::new();

    for marker in &markers {
        push_text(&mut out, &visible[cursor..marker.span.start]);
        cursor = marker.span.end;

        match block_for(marker) {
            Some(Block::Carousel(deck)) => merge_carousel(&mut out, &mut group_slots, deck),
            Some(Block::SkillStage(card)) => {
                // Re-emitting the same name updates that card in place.
                match skill_slots.get(&card.name) {
                    Some(index) => out[*index] = Block::SkillStage(card),
                    None => {
                        skill_slots.insert(card.name.clone(), out.len());
                        out.push(Block::SkillStage(card));
                    }
                }
            }
            Some(Block::AutoStatus(card)) => match auto_slot {
                Some(index) => out[index] = Block::AutoStatus(card),
                None => {
                    auto_slot = Some(out.len());
                    out.push(Block::AutoStatus(card));
                }
            },
            Some(block) => out.push(block),
            None => out.push(Block::Unsupported {
                source: marker.source.clone(),
                reason: if marker.malformed {
                    UnsupportedReason::Malformed
                } else {
                    UnsupportedReason::UnknownFamily
                },
            }),
        }
    }
    push_text(&mut out, &visible[cursor..]);

    out.extend(documents);
    if !citations.is_empty() {
        out.push(Block::Citations(citations));
    }
    out
}

/// Withhold an incomplete trailing marker so a half-arrived `<coven:atten`
/// never flashes in the transcript. Only the tail, and only outside code.
fn withhold_trailing_prefix(text: &str) -> String {
    let Some(at) = text.rfind("<coven:") else {
        return text.to_string();
    };
    if text[at..].contains('>') {
        return text.to_string();
    }
    if super::scan::code_ranges(text).iter().any(|r| at >= r.start && at < r.end) {
        return text.to_string();
    }
    text[..at].to_string()
}

/// Push prose, parsing it into spans and lifting fenced code out.
fn push_text(out: &mut Vec<Block>, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    out.extend(super::inline::parse_prose(text));
}

/// Merge a one-image deck into an adjacent or same-group deck.
fn merge_carousel(
    out: &mut Vec<Block>,
    group_slots: &mut HashMap<String, usize>,
    deck: Carousel,
) {
    if let Some(group) = deck.group.clone() {
        if let Some(index) = group_slots.get(&group) {
            if let Block::Carousel(existing) = &mut out[*index] {
                if existing.images.len() < MAX_CAROUSEL_IMAGES {
                    existing.images.extend(deck.images);
                }
                return;
            }
        }
        group_slots.insert(group, out.len());
        out.push(Block::Carousel(deck));
        return;
    }

    // Adjacency: only whitespace may separate two markers, and `push_text`
    // has already skipped whitespace-only runs, so "adjacent" is "last block".
    if let Some(Block::Carousel(existing)) = out.last_mut() {
        if existing.group.is_none() {
            if existing.images.len() < MAX_CAROUSEL_IMAGES {
                existing.images.extend(deck.images);
            }
            return;
        }
    }
    out.push(Block::Carousel(deck));
}

/// Map one scanned marker to a block, or `None` when it is not usable.
fn block_for(marker: &ScannedMarker) -> Option<Block> {
    if marker.malformed {
        return None;
    }
    match marker.name.as_str() {
        "github" => github_card(marker).map(Block::GitHubCard),
        "github-action" => super::action::proposal_from_marker(marker).map(Block::ActionProposal),
        "image" => image_ref(marker).map(|image| {
            Block::Carousel(Carousel {
                images: vec![image],
                group: marker.attr("group").map(str::to_string).filter(|g| !g.is_empty()),
            })
        }),
        "skill" => skill_card(marker).map(Block::SkillStage),
        "auto-status" => auto_status(marker).map(Block::AutoStatus),
        "attention" => attention(marker).map(Block::Attention),
        _ => None,
    }
}

/// `owner/name`, conservative on purpose.
fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
            && s != "."
            && s != ".."
    };
    ok(owner) && ok(name)
}

fn github_card(marker: &ScannedMarker) -> Option<GitHubCard> {
    let repo = marker.attr("repo")?.to_string();
    if !valid_repo(&repo) {
        return None;
    }
    let number = marker.attr("number").and_then(|n| n.parse::<u64>().ok());
    let kind = match marker.attr("kind")? {
        "pr" => GitHubCardKind::Pr,
        "issue" => GitHubCardKind::Issue,
        "review-thread" => GitHubCardKind::ReviewThread,
        "commit" => GitHubCardKind::Commit,
        "run" => GitHubCardKind::Run,
        _ => return None,
    };
    let sha = marker.attr("sha").map(str::to_string);
    let run_id = marker.attr("run").map(str::to_string);
    match kind {
        GitHubCardKind::Pr | GitHubCardKind::Issue if number.is_none() => return None,
        GitHubCardKind::ReviewThread if number.is_none() || !marker.has("threadid") => return None,
        GitHubCardKind::Commit if sha.is_none() => return None,
        GitHubCardKind::Run if run_id.is_none() => return None,
        _ => {}
    }
    Some(GitHubCard {
        kind,
        repo,
        number,
        sha,
        run_id,
        thread_id: marker.attr("threadid").map(str::to_string),
        title: marker.attr("title").map(str::to_string),
    })
}

/// Validate an image source. Port of Cave's `isRenderableImageSrc`, with the
/// remote/attachment/inline distinction made explicit in the type so a
/// renderer cannot confuse them.
fn renderable_source(raw: &str) -> Option<ImageSource> {
    if raw.chars().any(|c| c.is_control()) {
        return None;
    }
    let value = raw.trim();
    if value.starts_with("//") {
        return None;
    }
    if let Some(rest) = value.strip_prefix("/api/chat/attachment") {
        if !rest.is_empty() && !rest.starts_with('?') && !rest.starts_with('#') {
            return None;
        }
        let id = rest
            .trim_start_matches(['?', '#'])
            .split('&')
            .find_map(|pair| pair.strip_prefix("id="))?;
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return None;
        }
        return Some(ImageSource::Attachment { id: id.to_string() });
    }
    if value.starts_with("/api/") {
        return None;
    }
    if let Some(rest) = value.strip_prefix("data:") {
        // svg is absent deliberately: an inline SVG can carry script.
        let (mime, payload) = rest.split_once(";base64,")?;
        let allowed = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
        if !allowed.contains(&mime.to_ascii_lowercase().as_str()) {
            return None;
        }
        if payload.len() > 2 * 1024 * 1024 || payload.is_empty() {
            return None;
        }
        if !payload.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
        {
            return None;
        }
        return Some(ImageSource::Inline {
            mime: mime.to_ascii_lowercase(),
            base64: payload.to_string(),
        });
    }
    let rest = value.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(ImageSource::Remote {
        url: value.to_string(),
        host: host.trim_start_matches("www.").to_ascii_lowercase(),
    })
}

fn image_ref(marker: &ScannedMarker) -> Option<ImageRef> {
    Some(ImageRef {
        source: renderable_source(marker.attr("src")?)?,
        alt: marker.attr("alt").map(str::to_string).filter(|s| !s.is_empty()),
        caption: marker.attr("caption").map(str::to_string).filter(|s| !s.is_empty()),
    })
}

fn skill_card(marker: &ScannedMarker) -> Option<SkillCard> {
    let name = marker.attr("name")?.trim().to_string();
    if name.is_empty() || name.len() > 120 {
        return None;
    }
    let stage = match marker.attr("stage")?.to_ascii_lowercase().as_str() {
        "loaded" => SkillStage::Loaded,
        "running" => SkillStage::Running,
        "done" => SkillStage::Done,
        "error" => SkillStage::Error,
        _ => return None,
    };
    Some(SkillCard { name, stage, note: marker.attr("note").map(str::to_string) })
}

fn auto_status(marker: &ScannedMarker) -> Option<AutoStatusCard> {
    // Cave accepts synonyms here on purpose: dropping a mission marker on a
    // string mismatch strands the mission with no ping, which is worse than
    // being lenient about the spelling.
    let state = match marker.attr("state")?.trim().to_ascii_lowercase().as_str() {
        "clarifying" | "clarify" | "questions" => AutoState::Clarifying,
        "working" | "work" | "in-progress" | "running" => AutoState::Working,
        "blocked" | "block" | "waiting" => AutoState::Blocked,
        "failed" | "fail" | "error" => AutoState::Failed,
        "done" | "complete" | "completed" | "finished" => AutoState::Done,
        _ => return None,
    };
    Some(AutoStatusCard { state, note: marker.attr("note").map(str::to_string) })
}

fn attention(marker: &ScannedMarker) -> Option<AttentionCard> {
    let reason = match marker.attr("reason")?.trim().to_ascii_lowercase().as_str() {
        "input" => AttentionReason::Input,
        "approval" => AttentionReason::Approval,
        "credentials" => AttentionReason::Credentials,
        "decision" => AttentionReason::Decision,
        _ => return None,
    };
    Some(AttentionCard { reason })
}
```

- [ ] **Step 5: Implement the action grammar**

`markup/action.rs` recognises a proposal. `crate::actions` (Task 10) executes one. The split matters: recognising is parsing untrusted text and must be total; executing is a network mutation and must be gated on a gesture. Nothing in this file may perform either.

Create `crates/cave-core/src/markup/action.rs`:

```rust
//! Action markers to typed requests.
//!
//! Everything here is recognition. A value produced by this module is a
//! proposal — an offer to be shown to a person — and carries no authority to
//! do anything. `crate::actions` is where a confirmed proposal becomes a
//! request, and it is the only place a mutation is sent.

use super::scan::ScannedMarker;
use serde::{Deserialize, Serialize};

/// A GitHub mutation, mirroring the desktop program's `GitHubActionInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitHubAction {
    Comment { repo: String, number: u64, body: String },
    Reply { repo: String, number: u64, body: String },
    Resolve { repo: String, number: u64, thread_id: String },
    Unresolve { repo: String, number: u64, thread_id: String },
    IssueCreate { repo: String, title: String, body: Option<String> },
    IssueState { repo: String, number: u64, state: IssueState },
    Review { repo: String, number: u64, event: ReviewEvent, body: Option<String> },
    Merge { repo: String, number: u64, method: MergeMethod },
    Rerun { repo: String, run_id: String },
    Dispatch { repo: String, workflow: String, git_ref: String },
}

/// Issue open state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

/// Review verdicts, spelled as GitHub spells them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

/// Merge strategies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

/// Every family of mutation a client can request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "kebab-case")]
pub enum ActionRequestKind {
    /// A GitHub write.
    GitHub(GitHubAction),
    /// An answer to an attention request.
    AttentionResponse { conversation_id: String, response: String },
    /// A task handed to another agent or a future session.
    TaskHandoff { conversation_id: String, title: String, markdown: String },
}

impl ActionRequestKind {
    /// Family name, for the FFI mirror and the journal.
    pub fn family(&self) -> &'static str {
        match self {
            Self::GitHub(_) => "github",
            Self::AttentionResponse { .. } => "attention",
            Self::TaskHandoff { .. } => "handoff",
        }
    }

    /// Specific kind within the family.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::GitHub(action) => match action {
                GitHubAction::Comment { .. } => "comment",
                GitHubAction::Reply { .. } => "reply",
                GitHubAction::Resolve { .. } => "resolve",
                GitHubAction::Unresolve { .. } => "unresolve",
                GitHubAction::IssueCreate { .. } => "issue-create",
                GitHubAction::IssueState { .. } => "issue-state",
                GitHubAction::Review { .. } => "review",
                GitHubAction::Merge { .. } => "merge",
                GitHubAction::Rerun { .. } => "rerun",
                GitHubAction::Dispatch { .. } => "dispatch",
            },
            Self::AttentionResponse { .. } => "respond",
            Self::TaskHandoff { .. } => "handoff",
        }
    }

    /// Serialized body, opaque to Swift.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Recognise a `<coven:github-action …>` marker.
///
/// Missing or unparseable required fields yield `None`, which the caller
/// renders as `Unsupported`. Guessing a default for a merge method, an issue
/// state, or a review verdict would propose an action the familiar did not.
pub fn proposal_from_marker(marker: &ScannedMarker) -> Option<super::blocks::ActionProposal> {
    let repo = marker.attr("repo")?.to_string();
    if !super::blocks::valid_repo(&repo) {
        return None;
    }
    let number = || marker.attr("number").and_then(|n| n.parse::<u64>().ok());
    let body = || marker.attr("body").map(str::to_string).filter(|b| !b.is_empty());

    let action = match marker.attr("kind")? {
        "comment" => GitHubAction::Comment { repo: repo.clone(), number: number()?, body: body()? },
        "reply" => GitHubAction::Reply { repo: repo.clone(), number: number()?, body: body()? },
        "resolve" => GitHubAction::Resolve {
            repo: repo.clone(),
            number: number()?,
            thread_id: marker.attr("threadid")?.to_string(),
        },
        "unresolve" => GitHubAction::Unresolve {
            repo: repo.clone(),
            number: number()?,
            thread_id: marker.attr("threadid")?.to_string(),
        },
        "issue-create" => GitHubAction::IssueCreate {
            repo: repo.clone(),
            title: marker.attr("title").filter(|t| !t.is_empty())?.to_string(),
            body: body(),
        },
        "issue-state" => GitHubAction::IssueState {
            repo: repo.clone(),
            number: number()?,
            state: match marker.attr("state")? {
                "open" => IssueState::Open,
                "closed" => IssueState::Closed,
                _ => return None,
            },
        },
        "review" => GitHubAction::Review {
            repo: repo.clone(),
            number: number()?,
            event: match marker.attr("event")? {
                "APPROVE" => ReviewEvent::Approve,
                "REQUEST_CHANGES" => ReviewEvent::RequestChanges,
                "COMMENT" => ReviewEvent::Comment,
                _ => return None,
            },
            body: body(),
        },
        "merge" => GitHubAction::Merge {
            repo: repo.clone(),
            number: number()?,
            method: match marker.attr("method")? {
                "squash" => MergeMethod::Squash,
                "merge" => MergeMethod::Merge,
                "rebase" => MergeMethod::Rebase,
                _ => return None,
            },
        },
        "rerun" => GitHubAction::Rerun {
            repo: repo.clone(),
            run_id: marker.attr("run").filter(|r| !r.is_empty())?.to_string(),
        },
        "dispatch" => GitHubAction::Dispatch {
            repo: repo.clone(),
            workflow: marker.attr("workflow").filter(|w| !w.is_empty())?.to_string(),
            git_ref: marker.attr("ref").filter(|r| !r.is_empty())?.to_string(),
        },
        _ => return None,
    };

    let summary = summarize(&action);
    Some(super::blocks::ActionProposal {
        action: ActionRequestKind::GitHub(action),
        summary,
        idempotency_hint: None,
    })
}

/// The exact sentence shown on the confirmation sheet. It names the mutation
/// and the target and nothing else, because a summary that paraphrases is a
/// summary a person can be misled by.
fn summarize(action: &GitHubAction) -> String {
    match action {
        GitHubAction::Comment { repo, number, .. } => format!("Comment on {repo} #{number}"),
        GitHubAction::Reply { repo, number, .. } => format!("Reply on {repo} #{number}"),
        GitHubAction::Resolve { repo, number, .. } => format!("Resolve a thread on {repo} #{number}"),
        GitHubAction::Unresolve { repo, number, .. } => format!("Unresolve a thread on {repo} #{number}"),
        GitHubAction::IssueCreate { repo, title, .. } => format!("Create issue \"{title}\" in {repo}"),
        GitHubAction::IssueState { repo, number, state } => match state {
            IssueState::Open => format!("Reopen {repo} #{number}"),
            IssueState::Closed => format!("Close {repo} #{number}"),
        },
        GitHubAction::Review { repo, number, event, .. } => match event {
            ReviewEvent::Approve => format!("Approve {repo} #{number}"),
            ReviewEvent::RequestChanges => format!("Request changes on {repo} #{number}"),
            ReviewEvent::Comment => format!("Leave a review comment on {repo} #{number}"),
        },
        GitHubAction::Merge { repo, number, method } => {
            format!("Merge {repo} #{number} using {}", format!("{method:?}").to_lowercase())
        }
        GitHubAction::Rerun { repo, run_id } => format!("Re-run workflow {run_id} in {repo}"),
        GitHubAction::Dispatch { repo, workflow, git_ref } => {
            format!("Dispatch {workflow} on {git_ref} in {repo}")
        }
    }
}
```

Make `valid_repo` in `blocks.rs` `pub(super)` so this module can use it.

Export from `crates/cave-core/src/markup/mod.rs`:

```rust
pub mod action;
pub mod blocks;
pub mod citation;
pub mod document;
pub mod inline;
pub mod scan;

pub use blocks::{parse_blocks, Block, ParseMode, UnsupportedReason};
```

- [ ] **Step 6: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup
cargo clippy -p cave-core --all-targets -- -D warnings
git add crates/cave-core
git commit -S -m "Add the block AST and marker parser to cave-core

Unknown and malformed markers become Unsupported carrying their source.
Nothing is dropped silently, and no variant in the tree can execute or
fetch anything by itself."
```

---

## Task 3: Fenced Documents and Citations

Two producers that are not markers: `spec`/`handoff` fenced documents, and footnote citations at the end of a turn.

**Files:** Create `crates/cave-core/src/markup/document.rs`, `crates/cave-core/src/markup/citation.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/cave-core/src/markup/document.rs` with tests only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_spec_with_a_title() {
        let text = "before\n```spec title=\"Rollout\"\n# Rollout\n\nBody.\n```\nafter";
        let (rest, docs) = extract_documents(text);
        assert_eq!(docs.len(), 1);
        assert!(!rest.contains("# Rollout"));
    }

    #[test]
    fn a_four_backtick_document_may_contain_a_three_backtick_fence() {
        let text = "````handoff title=\"Next\"\n# Next\n\n```sh\nls\n```\n````";
        let (_, docs) = extract_documents(text);
        assert_eq!(docs.len(), 1);
        match &docs[0] {
            crate::markup::Block::Document(doc) => {
                assert!(doc.markdown.contains("```sh"));
                assert_eq!(doc.kind, DocumentKind::Handoff);
            }
            other => panic!("expected document, got {other:?}"),
        }
    }

    #[test]
    fn an_unterminated_document_is_not_extracted_while_streaming() {
        let (rest, docs) = extract_documents("```spec title=\"x\"\n# x\n");
        assert!(docs.is_empty());
        assert!(rest.contains("# x"));
    }

    #[test]
    fn an_untitled_document_gets_its_first_heading() {
        let (_, docs) = extract_documents("```spec\n# Derived\n\nBody.\n```");
        match &docs[0] {
            crate::markup::Block::Document(doc) => assert_eq!(doc.title, "Derived"),
            other => panic!("expected document, got {other:?}"),
        }
    }

    #[test]
    fn a_workspace_attachment_marker_is_unsupported_not_an_image() {
        // The phone has no access to a path on Cave's machine. Rendering this
        // as an image would be a lie about what the user is looking at.
        let (_, docs) = extract_documents(
            "```coven:attachment\n{\"path\":\"/tmp/a.png\",\"name\":\"a.png\"}\n```",
        );
        assert!(matches!(
            &docs[0],
            crate::markup::Block::Unsupported { reason, .. }
                if *reason == crate::markup::UnsupportedReason::WorkspaceLocal
        ));
    }

    #[test]
    fn an_ordinary_code_fence_is_left_alone() {
        let (rest, docs) = extract_documents("```rust\nfn main() {}\n```");
        assert!(docs.is_empty());
        assert!(rest.contains("fn main"));
    }
}
```

Create `crates/cave-core/src/markup/citation.rs` with tests only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifts_definitions_off_the_body() {
        let text = "Claim[^1].\n\n[^1]: https://example.com/p \"Title\" — Supports the claim.";
        let (body, cites) = split_citations(text);
        assert!(!body.contains("https://example.com"));
        assert_eq!(cites.len(), 1);
        assert_eq!(cites[0].domain.as_deref(), Some("example.com"));
        assert_eq!(cites[0].title, "Title");
    }

    #[test]
    fn numbers_in_first_reference_order() {
        let text = "a[^2] b[^1]\n\n[^1]: https://a.test \"A\"\n[^2]: https://b.test \"B\"";
        let (_, cites) = split_citations(text);
        assert_eq!(cites[0].title, "B");
        assert_eq!(cites[0].n, 1);
    }

    #[test]
    fn a_file_reference_has_no_domain() {
        let (_, cites) = split_citations("a[^1]\n\n[^1]: src/lib/foo.ts#L12-L18");
        assert!(cites[0].url.is_none());
        let file = cites[0].file.as_ref().expect("file ref");
        assert_eq!(file.path, "src/lib/foo.ts");
        assert_eq!(file.line_start, Some(12));
        assert_eq!(file.line_end, Some(18));
    }

    #[test]
    fn a_non_http_scheme_is_not_a_citation_url() {
        let (_, cites) = split_citations("a[^1]\n\n[^1]: javascript:alert(1) \"X\"");
        assert!(cites[0].url.is_none());
    }

    #[test]
    fn an_undefined_reference_produces_no_citation() {
        let (_, cites) = split_citations("a[^9] with no definition");
        assert!(cites.is_empty());
    }

    #[test]
    fn definitions_inside_code_are_ignored() {
        let (_, cites) = split_citations("```\n[^1]: https://a.test \"A\"\n```");
        assert!(cites.is_empty());
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup::document markup::citation 2>&1 | tail -20
```

- [ ] **Step 3: Implement documents**

Prepend to `crates/cave-core/src/markup/document.rs`:

```rust
//! `spec` and `handoff` fenced documents, plus the workspace-local attachment
//! marker this device deliberately cannot honour.
//!
//! Ported from Cave's `spec-blocks.ts`. The fence-length rule matters: a
//! four-backtick document may contain ordinary three-backtick code, so the
//! closing fence must be at least as long as the opener and nothing shorter
//! may close it.

use super::blocks::Block;
use super::scan::line_spans;
use super::UnsupportedReason;

/// Which document a fence opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Spec,
    Handoff,
}

/// A document card. The body stays markdown; the reader parses it on open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentCard {
    pub kind: DocumentKind,
    pub title: String,
    pub markdown: String,
    pub section_count: usize,
    pub reading_minutes: usize,
}

/// Longest document body accepted. Beyond this the fence is left as code.
const MAX_DOCUMENT_BYTES: usize = 256 * 1024;

/// Pull documents out of the text, returning the remaining prose and the
/// blocks they became.
pub fn extract_documents(text: &str) -> (String, Vec<Block>) {
    let lines = line_spans(text);
    let mut out = Vec::new();
    let mut kept = String::with_capacity(text.len());
    let mut index = 0usize;

    while index < lines.len() {
        let line = &lines[index];
        let content = &text[line.start..line.content_end];
        let Some(open) = parse_open(content) else {
            kept.push_str(&text[line.start..line.end]);
            index += 1;
            continue;
        };

        let Some(close) = find_close(text, &lines, index, open.run) else {
            // Unterminated: the document is still arriving. Leave every line
            // as prose so nothing half-formed renders as a card.
            kept.push_str(&text[line.start..line.end]);
            index += 1;
            continue;
        };

        let body_start = lines[index + 1].start.min(text.len());
        let body_end = lines[close].start;
        let body = &text[body_start..body_end];

        if body.len() > MAX_DOCUMENT_BYTES {
            kept.push_str(&text[line.start..lines[close].end]);
        } else {
            out.push(document_block(open.kind, open.title.as_deref(), body, &text[line.start..lines[close].end]));
        }
        index = close + 1;
    }

    (kept, out)
}

struct Opening {
    kind: OpeningKind,
    title: Option<String>,
    run: usize,
}

enum OpeningKind {
    Document(DocumentKind),
    WorkspaceAttachment,
}

fn parse_open(content: &str) -> Option<Opening> {
    let trimmed = content.trim_start_matches(' ');
    if content.len() - trimmed.len() > 3 {
        return None;
    }
    let run = trimmed.bytes().take_while(|b| *b == b'`').count();
    if run < 3 {
        return None;
    }
    let info = trimmed[run..].trim();
    if info == "coven:attachment" {
        return Some(Opening { kind: OpeningKind::WorkspaceAttachment, title: None, run });
    }
    let (word, rest) = match info.split_once(char::is_whitespace) {
        Some((word, rest)) => (word, rest.trim()),
        None => (info, ""),
    };
    let kind = match word {
        "spec" => DocumentKind::Spec,
        "handoff" => DocumentKind::Handoff,
        _ => return None,
    };
    let title = rest
        .strip_prefix("title=\"")
        .and_then(|r| r.strip_suffix('"'))
        .map(str::to_string)
        .filter(|t| !t.contains(['\r', '\n']));
    if !rest.is_empty() && title.is_none() {
        return None;
    }
    Some(Opening { kind: OpeningKind::Document(kind), title, run })
}

fn find_close(text: &str, lines: &[super::scan::LineSpan], open: usize, run: usize) -> Option<usize> {
    for (offset, line) in lines.iter().enumerate().skip(open + 1) {
        let content = text[line.start..line.content_end].trim();
        if content.bytes().all(|b| b == b'`') && content.len() >= run {
            return Some(offset);
        }
    }
    None
}

fn document_block(kind: OpeningKind, title: Option<&str>, body: &str, source: &str) -> Block {
    match kind {
        OpeningKind::WorkspaceAttachment => Block::Unsupported {
            source: source.to_string(),
            reason: UnsupportedReason::WorkspaceLocal,
        },
        OpeningKind::Document(kind) => {
            let derived = body
                .lines()
                .find_map(|l| l.trim().strip_prefix("# ").map(str::trim))
                .unwrap_or("Untitled");
            let title = title.filter(|t| !t.trim().is_empty()).unwrap_or(derived);
            let words = body.split_whitespace().count();
            Block::Document(DocumentCard {
                kind,
                title: title.to_string(),
                markdown: body.to_string(),
                section_count: body.lines().filter(|l| l.trim_start().starts_with("##")).count(),
                reading_minutes: (words / 200).max(1),
            })
        }
    }
}
```

- [ ] **Step 4: Implement citations**

Prepend to `crates/cave-core/src/markup/citation.rs`:

```rust
//! Footnote citations. Ported from Cave's `citations.ts`.
//!
//! Definitions live at the end of a turn and are lifted off the body so the
//! transcript shows prose, not a wall of URLs. A citation carries a domain and
//! never a loaded preview: naming a host is attribution, fetching it is
//! surveillance the reader did not ask for.

use super::scan::code_ranges;

/// A reference to a file rather than a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    pub path: String,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
}

/// One source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    /// 1-based, in first-reference order.
    pub n: u32,
    pub title: String,
    /// `https:` or `http:` only.
    pub url: Option<String>,
    /// Bare host without `www.`, when there is a URL.
    pub domain: Option<String>,
    pub snippet: Option<String>,
    pub file: Option<FileRef>,
}

/// Split a turn into prose and its citations.
pub fn split_citations(text: &str) -> (String, Vec<Citation>) {
    let ranges = code_ranges(text);
    let in_code = |at: usize| ranges.iter().any(|r| at >= r.start && at < r.end);

    let mut definitions: Vec<(String, String)> = Vec::new();
    let mut body = String::with_capacity(text.len());

    for line in super::scan::line_spans(text) {
        let raw = &text[line.start..line.content_end];
        let parsed = raw
            .strip_prefix("[^")
            .and_then(|rest| rest.split_once("]: "))
            .filter(|(label, _)| !label.is_empty() && !label.contains(']'));
        match parsed {
            Some((label, value)) if !in_code(line.start) => {
                definitions.push((label.to_string(), value.trim().to_string()));
            }
            _ => body.push_str(&text[line.start..line.end]),
        }
    }

    if definitions.is_empty() {
        return (body, Vec::new());
    }

    // Order by first reference in the prose, matching Cave.
    let mut ordered: Vec<&(String, String)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = body[cursor..].find("[^") {
        let at = cursor + offset;
        cursor = at + 2;
        let Some(close) = body[cursor..].find(']') else { break };
        let label = &body[cursor..cursor + close];
        cursor += close + 1;
        if in_code(at) {
            continue;
        }
        if let Some(found) = definitions.iter().find(|(l, _)| l == label) {
            if !ordered.iter().any(|(l, _)| l == label) {
                ordered.push(found);
            }
        }
    }

    let citations = ordered
        .into_iter()
        .enumerate()
        .map(|(index, (_, value))| citation_from(index as u32 + 1, value))
        .collect();

    (body, citations)
}

fn citation_from(n: u32, value: &str) -> Citation {
    let (url_part, rest) = match value.split_once(" — ") {
        Some((url, snippet)) => (url.trim(), Some(snippet.trim().to_string())),
        None => (value.trim(), None),
    };
    let (raw_url, title) = match url_part.split_once(" \"") {
        Some((url, title)) => (url.trim(), title.trim_end_matches('"').to_string()),
        None => (url_part, String::new()),
    };
    let raw_url = raw_url.trim_matches(['<', '>']);

    let is_web = raw_url.starts_with("https://") || raw_url.starts_with("http://");
    if is_web {
        let host = raw_url
            .split_once("//")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
            .unwrap_or_default()
            .trim_start_matches("www.")
            .to_ascii_lowercase();
        return Citation {
            n,
            title: if title.is_empty() { host.clone() } else { title },
            url: Some(raw_url.to_string()),
            domain: Some(host),
            snippet: rest,
            file: None,
        };
    }

    // Not a web URL. It may be a repo path with a line range, or nothing we
    // can attribute — either way there is no URL and no domain, and the
    // renderer must not turn it into a tappable link.
    let (path, lines) = match raw_url.split_once("#L") {
        Some((path, lines)) => (path, Some(lines)),
        None => (raw_url, None),
    };
    let (start, end) = match lines {
        Some(range) => {
            let mut parts = range.split("-L");
            (
                parts.next().and_then(|s| s.parse().ok()),
                parts.next().and_then(|s| s.parse().ok()),
            )
        }
        None => (None, None),
    };
    let looks_like_path = !path.is_empty() && !path.contains(' ') && !path.contains(':');
    Citation {
        n,
        title: if title.is_empty() { path.to_string() } else { title },
        url: None,
        domain: None,
        snippet: rest,
        file: looks_like_path.then(|| FileRef {
            path: path.to_string(),
            line_start: start,
            line_end: end,
        }),
    }
}
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup
cargo clippy -p cave-core --all-targets -- -D warnings
git add crates/cave-core
git commit -S -m "Add spec/handoff documents and footnote citations to cave-core

A workspace-local attachment marker becomes Unsupported rather than a
broken image: the phone has no access to a path on Cave's machine, and
pretending otherwise would misrepresent what the reader is seeing."
```

---

## Task 4: Inline Markdown to Spans

The last piece of parsing. This is deliberately a small markdown subset — headings, lists, tables, blockquotes, fenced code, inline code, emphasis, and links — because every construct added here is a construct the renderer must handle safely on a phone. HTML is not in the subset. There is no "fall back to raw" path.

**Files:** Create `crates/cave-core/src/markup/inline.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/cave-core/src/markup/inline.rs` with tests only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::markup::Block;

    fn spans(text: &str) -> Vec<Span> {
        match parse_prose(text).into_iter().next() {
            Some(Block::Text { spans, .. }) => spans,
            other => panic!("expected text block, got {other:?}"),
        }
    }

    #[test]
    fn a_fence_becomes_a_code_block_with_its_language() {
        let out = parse_prose("intro\n```rust\nfn main() {}\n```\n");
        match out.iter().find(|b| matches!(b, Block::Code { .. })) {
            Some(Block::Code { language, source }) => {
                assert_eq!(language.as_deref(), Some("rust"));
                assert!(source.contains("fn main"));
            }
            _ => panic!("expected a code block"),
        }
    }

    #[test]
    fn a_heading_carries_its_level() {
        assert!(matches!(spans("## Title").first(), Some(Span::Heading { level: 2, .. })));
    }

    #[test]
    fn a_bullet_list_groups_its_items() {
        match spans("- one\n- two").first() {
            Some(Span::List { items, ordered }) => {
                assert_eq!(items.len(), 2);
                assert!(!ordered);
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[test]
    fn a_table_keeps_its_header_and_rows() {
        match spans("| a | b |\n| --- | --- |\n| 1 | 2 |").first() {
            Some(Span::Table { header, rows }) => {
                assert_eq!(header.len(), 2);
                assert_eq!(rows.len(), 1);
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[test]
    fn an_https_link_keeps_its_host_for_display() {
        let out = spans("see [docs](https://example.com/a/b)");
        assert!(out.iter().any(|s| matches!(s,
            Span::Paragraph { runs } if runs.iter().any(|r| matches!(r,
                Run::Link { host, .. } if host == "example.com")))));
    }

    #[test]
    fn a_javascript_link_renders_as_text_not_a_link() {
        let out = spans("[x](javascript:alert(1))");
        assert!(!has_link(&out));
    }

    #[test]
    fn a_data_link_renders_as_text_not_a_link() {
        assert!(!has_link(&spans("[x](data:text/html;base64,PHNjcmlwdD4=)")));
    }

    #[test]
    fn raw_html_is_text_not_markup() {
        let out = spans("<script>alert(1)</script>");
        match out.first() {
            Some(Span::Paragraph { runs }) => {
                assert!(matches!(&runs[0], Run::Text { text } if text.contains("<script>")));
            }
            other => panic!("expected a paragraph, got {other:?}"),
        }
    }

    #[test]
    fn nesting_is_bounded() {
        let deep = "> ".repeat(500) + "text";
        let out = parse_prose(&deep);
        assert!(!out.is_empty());
    }

    #[test]
    fn does_not_panic_on_any_prefix_of_a_mixed_document() {
        let doc = "# H\n\n- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`c` **d** [e](https://f.test)";
        for end in 0..=doc.len() {
            if doc.is_char_boundary(end) {
                let _ = parse_prose(&doc[..end]);
            }
        }
    }

    fn has_link(spans: &[Span]) -> bool {
        spans.iter().any(|s| match s {
            Span::Paragraph { runs } => runs.iter().any(|r| matches!(r, Run::Link { .. })),
            _ => false,
        })
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup::inline 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/markup/inline.rs`:

```rust
//! A small, total markdown subset.
//!
//! Every construct here is one the native renderer knows how to draw. There is
//! no HTML path and no raw-passthrough escape hatch: text that is not one of
//! these constructs is text, which is the only fallback that cannot become a
//! rendering surface.

use super::blocks::Block;

/// Deepest block nesting accepted before the rest is treated as flat text.
const MAX_DEPTH: usize = 8;

/// Longest single run of inline text kept as one run.
const MAX_RUN_BYTES: usize = 16 * 1024;

/// A block-level span of prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Span {
    Heading { level: u8, runs: Vec<Run> },
    Paragraph { runs: Vec<Run> },
    List { ordered: bool, items: Vec<Vec<Run>> },
    Quote { runs: Vec<Run> },
    Table { header: Vec<String>, rows: Vec<Vec<String>> },
    Divider,
}

/// An inline run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Run {
    Text { text: String },
    Emphasis { text: String },
    Strong { text: String },
    Code { text: String },
    /// A link the user may tap. `host` is what the UI displays before the tap.
    Link { text: String, url: String, host: String },
    /// A footnote reference, resolved against the turn's citation list.
    CitationRef { n: u32 },
}

/// Parse prose into blocks, lifting fenced code out as its own block.
pub fn parse_prose(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut spans: Vec<Span> = Vec::new();
    let mut source = String::new();
    let mut lines = text.lines().peekable();

    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if let Some(rest) = fence_open(trimmed) {
            flush(&mut out, &mut spans, &mut source);
            let mut body = String::new();
            for inner in lines.by_ref() {
                let candidate = inner.trim();
                if candidate.bytes().all(|b| b == b'`') && candidate.len() >= rest.run {
                    break;
                }
                body.push_str(inner);
                body.push('\n');
            }
            out.push(Block::Code { language: rest.language, source: body });
            continue;
        }

        source.push_str(line);
        source.push('\n');

        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().all(|c| c == '-') && trimmed.len() >= 3 {
            spans.push(Span::Divider);
            continue;
        }
        if let Some(span) = heading(trimmed) {
            spans.push(span);
            continue;
        }
        if trimmed.starts_with("| ") {
            let mut table = vec![line.to_string()];
            while let Some(next) = lines.peek() {
                if next.trim_start().starts_with('|') {
                    table.push(lines.next().unwrap_or_default().to_string());
                } else {
                    break;
                }
            }
            for row in &table {
                source.push_str(row);
                source.push('\n');
            }
            if let Some(span) = table_span(&table) {
                spans.push(span);
                continue;
            }
            spans.push(Span::Paragraph { runs: runs_of(&table.join("\n")) });
            continue;
        }
        if let Some((ordered, item)) = list_item(trimmed) {
            match spans.last_mut() {
                Some(Span::List { ordered: existing, items }) if *existing == ordered => {
                    items.push(runs_of(&item));
                }
                _ => spans.push(Span::List { ordered, items: vec![runs_of(&item)] }),
            }
            continue;
        }
        if let Some(rest) = quote_body(trimmed) {
            spans.push(Span::Quote { runs: runs_of(&rest) });
            continue;
        }
        match spans.last_mut() {
            Some(Span::Paragraph { runs }) => {
                runs.push(Run::Text { text: format!("\n{trimmed}") });
            }
            _ => spans.push(Span::Paragraph { runs: runs_of(trimmed) }),
        }
    }

    flush(&mut out, &mut spans, &mut source);
    out
}

fn flush(out: &mut Vec<Block>, spans: &mut Vec<Span>, source: &mut String) {
    if spans.is_empty() {
        source.clear();
        return;
    }
    out.push(Block::Text { text: std::mem::take(source), spans: std::mem::take(spans) });
}

struct FenceOpen {
    run: usize,
    language: Option<String>,
}

fn fence_open(trimmed: &str) -> Option<FenceOpen> {
    let run = trimmed.bytes().take_while(|b| *b == b'`').count();
    if run < 3 {
        return None;
    }
    let info = trimmed[run..].trim();
    Some(FenceOpen {
        run,
        language: (!info.is_empty()).then(|| info.split_whitespace().next().unwrap_or(info).to_string()),
    })
}

fn heading(trimmed: &str) -> Option<Span> {
    let level = trimmed.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = trimmed[level..].strip_prefix(' ')?;
    Some(Span::Heading { level: level as u8, runs: runs_of(rest.trim()) })
}

fn list_item(trimmed: &str) -> Option<(bool, String)> {
    if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        return Some((false, rest.to_string()));
    }
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        if let Some(rest) = trimmed[digits..].strip_prefix(". ") {
            return Some((true, rest.to_string()));
        }
    }
    None
}

fn quote_body(trimmed: &str) -> Option<String> {
    let mut depth = 0usize;
    let mut rest = trimmed;
    while let Some(next) = rest.strip_prefix("> ").or_else(|| rest.strip_prefix('>')) {
        depth += 1;
        rest = next;
        if depth >= MAX_DEPTH {
            break;
        }
    }
    (depth > 0).then(|| rest.trim().to_string())
}

fn table_span(rows: &[String]) -> Option<Span> {
    let cells = |row: &str| -> Vec<String> {
        row.trim().trim_matches('|').split('|').map(|c| c.trim().to_string()).collect()
    };
    let header = cells(rows.first()?);
    let divider = rows.get(1)?;
    if !divider.contains("---") {
        return None;
    }
    let body: Vec<Vec<String>> = rows
        .iter()
        .skip(2)
        .map(|row| cells(row))
        .filter(|row| row.len() == header.len())
        .collect();
    Some(Span::Table { header, rows: body })
}

/// Inline parsing. One pass, no backtracking, no construct that could become
/// markup on the other side.
fn runs_of(text: &str) -> Vec<Run> {
    let mut out = Vec::new();
    let mut buffer = String::new();
    let bytes = text.as_bytes();
    let mut at = 0usize;

    let flush_buffer = |out: &mut Vec<Run>, buffer: &mut String| {
        if !buffer.is_empty() {
            out.push(Run::Text { text: std::mem::take(buffer) });
        }
    };

    while at < bytes.len() {
        if buffer.len() > MAX_RUN_BYTES {
            flush_buffer(&mut out, &mut buffer);
        }
        let rest = &text[at..];

        if let Some(end) = rest.strip_prefix('`').and_then(|r| r.find('`')) {
            flush_buffer(&mut out, &mut buffer);
            out.push(Run::Code { text: rest[1..1 + end].to_string() });
            at += end + 2;
            continue;
        }
        if let Some(end) = rest.strip_prefix("**").and_then(|r| r.find("**")) {
            flush_buffer(&mut out, &mut buffer);
            out.push(Run::Strong { text: rest[2..2 + end].to_string() });
            at += end + 4;
            continue;
        }
        if rest.starts_with('*') && !rest.starts_with("**") {
            if let Some(end) = rest[1..].find('*') {
                flush_buffer(&mut out, &mut buffer);
                out.push(Run::Emphasis { text: rest[1..1 + end].to_string() });
                at += end + 2;
                continue;
            }
        }
        if let Some(reference) = citation_ref(rest) {
            flush_buffer(&mut out, &mut buffer);
            out.push(Run::CitationRef { n: reference.0 });
            at += reference.1;
            continue;
        }
        if let Some((run, width)) = link(rest) {
            flush_buffer(&mut out, &mut buffer);
            out.push(run);
            at += width;
            continue;
        }

        let ch = text[at..].chars().next().unwrap_or_default();
        buffer.push(ch);
        at += ch.len_utf8();
    }

    flush_buffer(&mut out, &mut buffer);
    out
}

fn citation_ref(rest: &str) -> Option<(u32, usize)> {
    let body = rest.strip_prefix("[^")?;
    let close = body.find(']')?;
    let n: u32 = body[..close].parse().ok()?;
    (!body[close + 1..].starts_with(':')).then_some((n, close + 3))
}

fn link(rest: &str) -> Option<(Run, usize)> {
    let body = rest.strip_prefix('[')?;
    let text_end = body.find(']')?;
    let after = body[text_end + 1..].strip_prefix('(')?;
    let url_end = after.find(')')?;
    let url = after[..url_end].trim();
    let label = &body[..text_end];
    let width = 1 + text_end + 2 + url_end + 1;

    // Anything but https/http/mailto renders as the literal text. A link the
    // renderer will not open must not look like one it will.
    let host = match url {
        u if u.starts_with("https://") || u.starts_with("http://") => u
            .split_once("//")
            .map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or_default())
            .unwrap_or_default()
            .trim_start_matches("www.")
            .to_ascii_lowercase(),
        u if u.starts_with("mailto:") => u.trim_start_matches("mailto:").to_string(),
        _ => {
            return Some((Run::Text { text: rest[..width].to_string() }, width));
        }
    };
    if host.is_empty() || url.chars().any(|c| c.is_control()) {
        return Some((Run::Text { text: rest[..width].to_string() }, width));
    }
    Some((Run::Link { text: label.to_string(), url: url.to_string(), host }, width))
}
```

- [ ] **Step 4: Add a fuzz-shaped property test**

Append to the tests module:

```rust
    #[test]
    fn arbitrary_byte_soup_never_panics_and_never_loses_everything() {
        let seeds = [
            "*", "**", "`", "[", "](", "[a](", "> > >", "| |", "#######",
            "[^", "[^1]", "[^1]:", "```", "```` ", "- ", "1. ", "\u{0}",
        ];
        for a in seeds {
            for b in seeds {
                let text = format!("{a}{b}{a}");
                let out = parse_prose(&text);
                if !text.trim().is_empty() {
                    assert!(!out.is_empty(), "lost everything for {text:?}");
                }
            }
        }
    }
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core markup
cargo clippy -p cave-core --all-targets -- -D warnings
git add crates/cave-core
git commit -S -m "Add the inline markdown subset to cave-core

A link whose scheme the renderer will not open stays literal text, so
nothing can look tappable that is not. Raw HTML is text, with no
passthrough path that could reach a rendering surface."
```

---

## Task 5: The Parity Vector File

`cave-core` and Cave's TypeScript now parse the same grammar in two languages. The vector file is what makes disagreement a test failure rather than a support ticket six months from now.

**Files:** Create `crates/cave-core/fixtures/markup-vectors.json`, `crates/cave-core/tests/markup_vectors.rs`

- [ ] **Step 1: Author the vectors**

Create `crates/cave-core/fixtures/markup-vectors.json`. Each entry is an input and the block kinds it must produce, in order. Kinds only — the vector file pins the classification decisions, which is where the two implementations can actually drift; exact field values are pinned by the unit tests in each language.

```json
{
  "version": 1,
  "note": "Shared parity vectors for the coven: marker grammar. Cave's TypeScript parsers and cave-core must agree on every entry. See docs/superpowers/plans/2026-08-17-ios-phase-f-rich-content-and-actions.md Task 5.",
  "vectors": [
    { "name": "plain-prose", "input": "hello", "mode": "final", "kinds": ["text"] },
    { "name": "github-pr-card", "input": "see <coven:github kind=\"pr\" repo=\"o/r\" number=\"7\" /> ok", "mode": "final", "kinds": ["text", "github-card", "text"] },
    { "name": "github-bad-repo", "input": "<coven:github kind=\"pr\" repo=\"../x\" number=\"7\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "github-action-merge", "input": "<coven:github-action kind=\"merge\" repo=\"o/r\" number=\"7\" method=\"squash\" />", "mode": "final", "kinds": ["action-proposal"] },
    { "name": "github-action-missing-method", "input": "<coven:github-action kind=\"merge\" repo=\"o/r\" number=\"7\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "image-single", "input": "<coven:image src=\"https://a.test/1.png\" />", "mode": "final", "kinds": ["carousel"] },
    { "name": "image-adjacent-merge", "input": "<coven:image src=\"https://a.test/1.png\" />\n<coven:image src=\"https://a.test/2.png\" />", "mode": "final", "kinds": ["carousel"] },
    { "name": "image-group-merge", "input": "<coven:image src=\"https://a.test/1.png\" group=\"g\" />\nprose\n<coven:image src=\"https://a.test/2.png\" group=\"g\" />", "mode": "final", "kinds": ["carousel", "text"] },
    { "name": "image-svg-rejected", "input": "<coven:image src=\"data:image/svg+xml;base64,PHN2Zz4=\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "image-api-path-rejected", "input": "<coven:image src=\"/api/client/v1/credentials\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "image-attachment-route", "input": "<coven:image src=\"/api/chat/attachment?id=abc\" />", "mode": "final", "kinds": ["carousel"] },
    { "name": "skill-last-stage-wins", "input": "<coven:skill name=\"a\" stage=\"running\" /><coven:skill name=\"a\" stage=\"done\" />", "mode": "final", "kinds": ["skill-stage"] },
    { "name": "skill-two-names", "input": "<coven:skill name=\"a\" stage=\"done\" /><coven:skill name=\"b\" stage=\"error\" />", "mode": "final", "kinds": ["skill-stage", "skill-stage"] },
    { "name": "auto-status-alias", "input": "<coven:auto-status state=\"complete\" />", "mode": "final", "kinds": ["auto-status"] },
    { "name": "auto-status-unknown", "input": "<coven:auto-status state=\"vibing\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "attention", "input": "Pick one.\n<coven:attention reason=\"decision\" />", "mode": "final", "kinds": ["text", "attention"] },
    { "name": "marker-in-fence-is-literal", "input": "```\n<coven:attention reason=\"input\" />\n```", "mode": "final", "kinds": ["code"] },
    { "name": "marker-in-inline-code-is-literal", "input": "use `<coven:attention reason=\"input\" />` here", "mode": "final", "kinds": ["text"] },
    { "name": "malformed-unquoted", "input": "<coven:skill name=a />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "malformed-duplicate-attr", "input": "<coven:skill name=\"a\" name=\"b\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "unknown-family", "input": "<coven:hologram x=\"1\" />", "mode": "final", "kinds": ["unsupported"] },
    { "name": "quoted-angle-bracket", "input": "<coven:skill name=\"a\" stage=\"done\" note=\"x > y\" />", "mode": "final", "kinds": ["skill-stage"] },
    { "name": "streaming-partial-withheld", "input": "answer <coven:atten", "mode": "streaming", "kinds": ["text"] },
    { "name": "final-partial-is-literal", "input": "answer <coven:atten", "mode": "final", "kinds": ["text"] },
    { "name": "spec-document", "input": "```spec title=\"T\"\n# T\n\nBody.\n```", "mode": "final", "kinds": ["document"] },
    { "name": "handoff-with-inner-fence", "input": "````handoff title=\"T\"\n# T\n\n```sh\nls\n```\n````", "mode": "final", "kinds": ["document"] },
    { "name": "workspace-attachment-unsupported", "input": "```coven:attachment\n{\"path\":\"/tmp/a.png\",\"name\":\"a.png\"}\n```", "mode": "final", "kinds": ["unsupported"] },
    { "name": "citations", "input": "Claim[^1].\n\n[^1]: https://example.com/p \"Title\" — Supports it.", "mode": "final", "kinds": ["text", "citations"] },
    { "name": "citation-file-ref", "input": "Claim[^1].\n\n[^1]: src/lib/foo.ts#L12-L18", "mode": "final", "kinds": ["text", "citations"] },
    { "name": "undefined-citation-ref", "input": "Claim[^9] with nothing defined.", "mode": "final", "kinds": ["text"] },
    { "name": "javascript-link-is-text", "input": "[x](javascript:alert(1))", "mode": "final", "kinds": ["text"] },
    { "name": "raw-html-is-text", "input": "<script>alert(1)</script>", "mode": "final", "kinds": ["text"] }
  ]
}
```

- [ ] **Step 2: Write the vector test**

Create `crates/cave-core/tests/markup_vectors.rs`:

```rust
//! The vector file is the contract between this parser and Cave's TypeScript
//! one. A failure here means the two clients would show a user different
//! things for identical canonical text, which is the defect the whole
//! conformance-then-differential approach exists to catch.

use cave_core::markup::{parse_blocks, Block, ParseMode};
use serde::Deserialize;

#[derive(Deserialize)]
struct File {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: String,
    mode: String,
    kinds: Vec<String>,
}

fn kind_of(block: &Block) -> &'static str {
    match block {
        Block::Text { .. } => "text",
        Block::Code { .. } => "code",
        Block::Carousel(_) => "carousel",
        Block::GitHubCard(_) => "github-card",
        Block::ActionProposal(_) => "action-proposal",
        Block::SkillStage(_) => "skill-stage",
        Block::AutoStatus(_) => "auto-status",
        Block::Attention(_) => "attention",
        Block::Document(_) => "document",
        Block::Citations(_) => "citations",
        Block::Unsupported { .. } => "unsupported",
    }
}

#[test]
fn every_vector_classifies_identically() {
    let raw = include_str!("../fixtures/markup-vectors.json");
    let file: File = serde_json::from_str(raw).expect("vector file parses");
    assert!(file.vectors.len() >= 30, "the vector file lost entries");

    let mut failures = Vec::new();
    for vector in &file.vectors {
        let mode = match vector.mode.as_str() {
            "streaming" => ParseMode::Streaming,
            _ => ParseMode::Final,
        };
        let actual: Vec<&str> = parse_blocks(&vector.input, mode).iter().map(kind_of).collect();
        if actual != vector.kinds {
            failures.push(format!("{}: expected {:?}, got {:?}", vector.name, vector.kinds, actual));
        }
    }
    assert!(failures.is_empty(), "vector mismatches:\n{}", failures.join("\n"));
}

#[test]
fn no_vector_produces_an_empty_tree() {
    let raw = include_str!("../fixtures/markup-vectors.json");
    let file: File = serde_json::from_str(raw).expect("vector file parses");
    for vector in &file.vectors {
        let mode = if vector.mode == "streaming" { ParseMode::Streaming } else { ParseMode::Final };
        assert!(
            !parse_blocks(&vector.input, mode).is_empty(),
            "{} produced nothing at all",
            vector.name
        );
    }
}
```

- [ ] **Step 3: Run**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core --test markup_vectors
```

Expected: PASS. If an entry fails, fix the Rust to match Cave's behaviour — Cave's parsers ship today and the transcripts already exist.

- [ ] **Step 4: Record the desktop obligation**

The desktop Chat parser (`chat`, `src/lib/rich-content/`, desktop Phase 4 Task 7) must consume this same file. Add to the SDK's `crates/cave-core/fixtures/README.md`:

```markdown
# markup-vectors.json

Shared parity vectors for the `coven:` marker grammar.

Consumers:
- `cave-core` (`tests/markup_vectors.rs`) — enforced.
- Desktop Chat `src/lib/rich-content/parser.test.ts` — obligation. Copy this
  file verbatim; do not fork it. A vector that only one implementation passes
  is a defect in that implementation, not a reason to branch the file.

The grammar's authority is Cave's `src/lib/coven-marker-directive.ts` and the
per-family parsers beside it. When that directive changes, add vectors here in
the same change.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
git add crates/cave-core
git commit -S -m "Add shared markup parity vectors

Classification decisions are pinned in one file both implementations
read, so a divergence between the phone and the desktop shows up as a
failing test instead of two clients disagreeing about a transcript."
```

---

## Task 6: The FFI Content Surface

`cave-core` carries no UniFFI derives, by the same rule Phase B set for `coven-transport`. The mirror lives here, in `chat-ios-ffi`, and converts at the boundary.

Parsing runs on demand and is cached per message id: a transcript scrolled back and forth must not reparse every turn on every frame.

**Files:** Create `rust/ffi/src/content.rs`; modify `rust/ffi/src/lib.rs`, `types.rs`

- [ ] **Step 1: Write the failing test**

Add to `rust/ffi/src/content.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_caches_by_message_id() {
        let cache = ContentCache::new();
        let text = "<coven:attention reason=\"input\" />";
        let first = cache.blocks("m1".into(), text.into(), false);
        let second = cache.blocks("m1".into(), text.into(), false);
        assert_eq!(first, second);
        assert_eq!(cache.parses(), 1, "the second call reparsed");
    }

    #[test]
    fn changed_text_for_the_same_id_reparses() {
        let cache = ContentCache::new();
        let _ = cache.blocks("m1".into(), "a".into(), false);
        let _ = cache.blocks("m1".into(), "b".into(), false);
        assert_eq!(cache.parses(), 2);
    }

    #[test]
    fn streaming_text_is_not_cached() {
        // Streaming text changes on every frame; caching it would only grow
        // the map and never hit.
        let cache = ContentCache::new();
        let _ = cache.blocks("run1".into(), "partial".into(), true);
        let _ = cache.blocks("run1".into(), "partial".into(), true);
        assert_eq!(cache.parses(), 2);
    }

    #[test]
    fn the_cache_is_bounded() {
        let cache = ContentCache::new();
        for index in 0..(MAX_CACHED_MESSAGES + 50) {
            let _ = cache.blocks(format!("m{index}"), "text".into(), false);
        }
        assert!(cache.len() <= MAX_CACHED_MESSAGES);
    }
}
```

- [ ] **Step 2: Verify the test fails**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
cargo test -p chat-ios-ffi content 2>&1 | tail -20
```

- [ ] **Step 3: Implement the mirror**

Prepend to `rust/ffi/src/content.rs`:

```rust
//! The Swift-facing mirror of `cave_core::markup`.
//!
//! `cave-core` stays UniFFI-free so a future desktop host can consume it
//! without FFI scaffolding. That means the enum below is written by hand and
//! must stay in step with the core's. The conversion is exhaustive on purpose:
//! adding a `Block` variant in the core breaks this file, which is exactly the
//! reminder the renderer needs.

use cave_core::markup::{self, Block, ParseMode};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Cached parses retained. A long transcript scrolls; it does not need every
/// turn it has ever shown.
pub const MAX_CACHED_MESSAGES: usize = 400;

/// One renderable block, as Swift sees it.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum BlockFfi {
    Text { spans: Vec<SpanFfi> },
    Code { language: Option<String>, source: String },
    Carousel { images: Vec<ImageFfi> },
    GitHubCard { card: GitHubCardFfi },
    ActionProposal { proposal: ActionProposalFfi },
    SkillStage { name: String, stage: String, note: Option<String> },
    AutoStatus { state: String, note: Option<String> },
    Attention { reason: String },
    Document { kind: String, title: String, markdown: String, section_count: u32, reading_minutes: u32 },
    Citations { citations: Vec<CitationFfi> },
    Unsupported { source: String, reason: String },
}

/// A block-level piece of prose.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum SpanFfi {
    Heading { level: u8, runs: Vec<RunFfi> },
    Paragraph { runs: Vec<RunFfi> },
    List { ordered: bool, items: Vec<RunListFfi> },
    Quote { runs: Vec<RunFfi> },
    Table { header: Vec<String>, rows: Vec<RowFfi> },
    Divider,
}

/// UniFFI records cannot nest a bare `Vec<Vec<T>>`, so list items and table
/// rows get a named wrapper each.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RunListFfi {
    pub runs: Vec<RunFfi>,
}

/// One table row.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RowFfi {
    pub cells: Vec<String>,
}

/// An inline run.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum RunFfi {
    Text { text: String },
    Emphasis { text: String },
    Strong { text: String },
    Code { text: String },
    /// `host` is what the UI shows. `url` is opened only on an explicit tap.
    Link { text: String, url: String, host: String },
    CitationRef { n: u32 },
}

/// One picture, with its source kind made explicit so the renderer cannot
/// hand a remote URL to something that loads eagerly.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ImageFfi {
    /// `remote`, `attachment`, or `inline`.
    pub kind: String,
    /// Set for `remote`.
    pub url: Option<String>,
    /// Set for `remote` — the display host, shown before any load.
    pub host: Option<String>,
    /// Set for `attachment`.
    pub attachment_id: Option<String>,
    /// Set for `inline`.
    pub mime: Option<String>,
    /// Set for `inline`.
    pub base64: Option<String>,
    pub alt: Option<String>,
    pub caption: Option<String>,
}

/// A GitHub item card.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct GitHubCardFfi {
    pub kind: String,
    pub repo: String,
    pub number: Option<u64>,
    pub sha: Option<String>,
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub title: Option<String>,
}

/// A proposed mutation, as data. Confirming it is Swift's job; performing it
/// is the journal's.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ActionProposalFfi {
    /// Stable within one parse of one message, used to key the journal.
    pub proposal_id: String,
    /// `github`, `attention`, or `handoff`.
    pub family: String,
    /// The specific action, e.g. `merge`.
    pub kind: String,
    /// One-line summary rendered verbatim on the confirmation sheet.
    pub summary: String,
    /// The serialized request body, opaque to Swift.
    pub payload_json: String,
}

/// A source.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CitationFfi {
    pub n: u32,
    pub title: String,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub snippet: Option<String>,
    pub file_path: Option<String>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
}
```

- [ ] **Step 4: Implement conversion and the cache**

Append to `rust/ffi/src/content.rs`:

```rust
/// Parse-on-demand with a bounded cache.
#[derive(uniffi::Object)]
pub struct ContentCache {
    entries: Mutex<HashMap<String, (String, Vec<BlockFfi>)>>,
    order: Mutex<Vec<String>>,
    parses: AtomicUsize,
}

#[uniffi::export]
impl ContentCache {
    /// A fresh cache.
    #[uniffi::constructor]
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            parses: AtomicUsize::new(0),
        })
    }

    /// Blocks for one message.
    ///
    /// `streaming` selects the parse mode and disables caching: mid-stream
    /// text changes every frame, so a cache entry for it would never hit.
    pub fn blocks(&self, message_id: String, text: String, streaming: bool) -> Vec<BlockFfi> {
        if !streaming {
            if let Ok(entries) = self.entries.lock() {
                if let Some((cached_text, blocks)) = entries.get(&message_id) {
                    if cached_text == &text {
                        return blocks.clone();
                    }
                }
            }
        }

        self.parses.fetch_add(1, Ordering::Relaxed);
        let mode = if streaming { ParseMode::Streaming } else { ParseMode::Final };
        let blocks: Vec<BlockFfi> = markup::parse_blocks(&text, mode)
            .into_iter()
            .enumerate()
            .map(|(index, block)| convert(&message_id, index, block))
            .collect();

        if !streaming {
            if let (Ok(mut entries), Ok(mut order)) = (self.entries.lock(), self.order.lock()) {
                if entries.insert(message_id.clone(), (text, blocks.clone())).is_none() {
                    order.push(message_id);
                }
                while order.len() > MAX_CACHED_MESSAGES {
                    let oldest = order.remove(0);
                    entries.remove(&oldest);
                }
            }
        }
        blocks
    }

    /// Cached message count.
    pub fn len(&self) -> u32 {
        self.entries.lock().map(|e| e.len() as u32).unwrap_or(0)
    }

    /// Whether anything is cached.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Parses performed. Test observability only.
    pub fn parses(&self) -> u32 {
        self.parses.load(Ordering::Relaxed) as u32
    }

    /// Drop everything. Called on sign-out with the read cache.
    pub fn clear(&self) {
        if let (Ok(mut entries), Ok(mut order)) = (self.entries.lock(), self.order.lock()) {
            entries.clear();
            order.clear();
        }
    }
}

fn convert(message_id: &str, index: usize, block: Block) -> BlockFfi {
    match block {
        Block::Text { spans, .. } => BlockFfi::Text { spans: spans.into_iter().map(span).collect() },
        Block::Code { language, source } => BlockFfi::Code { language, source },
        Block::Carousel(deck) => BlockFfi::Carousel {
            images: deck.images.into_iter().map(image).collect(),
        },
        Block::GitHubCard(card) => BlockFfi::GitHubCard {
            card: GitHubCardFfi {
                kind: match card.kind {
                    markup::blocks::GitHubCardKind::Pr => "pr",
                    markup::blocks::GitHubCardKind::Issue => "issue",
                    markup::blocks::GitHubCardKind::ReviewThread => "review-thread",
                    markup::blocks::GitHubCardKind::Commit => "commit",
                    markup::blocks::GitHubCardKind::Run => "run",
                }
                .to_string(),
                repo: card.repo,
                number: card.number,
                sha: card.sha,
                run_id: card.run_id,
                thread_id: card.thread_id,
                title: card.title,
            },
        },
        Block::ActionProposal(proposal) => BlockFfi::ActionProposal {
            proposal: ActionProposalFfi {
                // Stable for this message and position, so re-rendering the
                // same turn addresses the same journal entry rather than
                // minting a second one.
                proposal_id: format!("{message_id}:{index}"),
                family: proposal.action.family().to_string(),
                kind: proposal.action.kind().to_string(),
                summary: proposal.summary,
                payload_json: proposal.action.to_json(),
            },
        },
        Block::SkillStage(card) => BlockFfi::SkillStage {
            name: card.name,
            stage: format!("{:?}", card.stage).to_lowercase(),
            note: card.note,
        },
        Block::AutoStatus(card) => BlockFfi::AutoStatus {
            state: format!("{:?}", card.state).to_lowercase(),
            note: card.note,
        },
        Block::Attention(card) => BlockFfi::Attention {
            reason: format!("{:?}", card.reason).to_lowercase(),
        },
        Block::Document(doc) => BlockFfi::Document {
            kind: format!("{:?}", doc.kind).to_lowercase(),
            title: doc.title,
            markdown: doc.markdown,
            section_count: doc.section_count as u32,
            reading_minutes: doc.reading_minutes as u32,
        },
        Block::Citations(list) => BlockFfi::Citations {
            citations: list
                .into_iter()
                .map(|c| CitationFfi {
                    n: c.n,
                    title: c.title,
                    url: c.url,
                    domain: c.domain,
                    snippet: c.snippet,
                    file_path: c.file.as_ref().map(|f| f.path.clone()),
                    line_start: c.file.as_ref().and_then(|f| f.line_start),
                    line_end: c.file.as_ref().and_then(|f| f.line_end),
                })
                .collect(),
        },
        Block::Unsupported { source, reason } => BlockFfi::Unsupported {
            source,
            reason: match reason {
                markup::UnsupportedReason::UnknownFamily => "unknown",
                markup::UnsupportedReason::Malformed => "malformed",
                markup::UnsupportedReason::RejectedSource => "rejected-source",
                markup::UnsupportedReason::WorkspaceLocal => "workspace-local",
            }
            .to_string(),
        },
    }
}

fn span(span: markup::inline::Span) -> SpanFfi {
    use markup::inline::Span as S;
    match span {
        S::Heading { level, runs } => SpanFfi::Heading { level, runs: runs.into_iter().map(run).collect() },
        S::Paragraph { runs } => SpanFfi::Paragraph { runs: runs.into_iter().map(run).collect() },
        S::List { ordered, items } => SpanFfi::List {
            ordered,
            items: items
                .into_iter()
                .map(|item| RunListFfi { runs: item.into_iter().map(run).collect() })
                .collect(),
        },
        S::Quote { runs } => SpanFfi::Quote { runs: runs.into_iter().map(run).collect() },
        S::Table { header, rows } => SpanFfi::Table {
            header,
            rows: rows.into_iter().map(|cells| RowFfi { cells }).collect(),
        },
        S::Divider => SpanFfi::Divider,
    }
}

fn run(run: markup::inline::Run) -> RunFfi {
    use markup::inline::Run as R;
    match run {
        R::Text { text } => RunFfi::Text { text },
        R::Emphasis { text } => RunFfi::Emphasis { text },
        R::Strong { text } => RunFfi::Strong { text },
        R::Code { text } => RunFfi::Code { text },
        R::Link { text, url, host } => RunFfi::Link { text, url, host },
        R::CitationRef { n } => RunFfi::CitationRef { n },
    }
}

fn image(image: markup::blocks::ImageRef) -> ImageFfi {
    use markup::blocks::ImageSource as Source;
    let (kind, url, host, attachment_id, mime, base64) = match image.source {
        Source::Remote { url, host } => ("remote", Some(url), Some(host), None, None, None),
        Source::Attachment { id } => ("attachment", None, None, Some(id), None, None),
        Source::Inline { mime, base64 } => ("inline", None, None, None, Some(mime), Some(base64)),
    };
    ImageFfi {
        kind: kind.to_string(),
        url,
        host,
        attachment_id,
        mime,
        base64,
        alt: image.alt,
        caption: image.caption,
    }
}
```

- [ ] **Step 5: Run, build, and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml content
./scripts/build-xcframework.sh
grep -n "enum BlockFfi\|case attention" app/Sources/Generated/*.swift | head
```

Read the generated names before writing any Swift against them.

```bash
git add rust/ffi
git commit -S -m "Add the FFI content surface and a bounded parse cache

The conversion is exhaustive, so a new block variant in cave-core fails
this file to compile rather than silently rendering as nothing."
```

---

## Task 7: Streaming Uploads From Disk

An attachment must never exist as a base64 string in memory. A 10 MB photo held as base64 is 13 MB of string plus the original, on a device that will kill the app for less.

**Files:** Create `crates/coven-transport/src/multipart.rs`; modify `crates/coven-transport/src/fetch.rs`, `src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to `crates/coven-transport/src/multipart.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn temp_file(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("upload-{}.bin", bytes.len()));
        tokio::fs::write(&path, bytes).await.expect("write");
        path
    }

    #[tokio::test]
    async fn streams_the_file_body_without_reading_it_whole() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut seen = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            seen.extend_from_slice(&buf[..n]);
                            if seen.len() > 2048 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 24\r\n\r\n{\"ok\":true,\"id\":\"a1\"}")
                    .await;
                let _ = tx.send(seen);
            }
        });

        let path = temp_file(&vec![7u8; 1500]).await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        let part = FilePart {
            field: "file".into(),
            filename: "a.bin".into(),
            mime: "application/octet-stream".into(),
            path: path.to_string_lossy().into_owned(),
            byte_count: 1500,
        };
        let result = post_multipart(&endpoint, "/upload", vec![], vec![part], None).await;
        assert!(result.is_ok(), "upload failed: {result:?}");

        let seen = rx.await.expect("request captured");
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains("multipart/form-data; boundary="));
        assert!(text.contains("filename=\"a.bin\""));
        assert!(text.contains("Content-Length:"));
    }

    #[tokio::test]
    async fn refuses_a_part_larger_than_the_limit() {
        let path = temp_file(&vec![0u8; 64]).await;
        let endpoint = Endpoint::plaintext("127.0.0.1", 1);
        let part = FilePart {
            field: "file".into(),
            filename: "a.bin".into(),
            mime: "application/octet-stream".into(),
            path: path.to_string_lossy().into_owned(),
            byte_count: MAX_PART_BYTES + 1,
        };
        assert!(matches!(
            post_multipart(&endpoint, "/upload", vec![], vec![part], None).await,
            Err(TransportError::TooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn refuses_when_the_file_size_disagrees_with_the_declared_count() {
        // A size that changed between staging and upload means something else
        // is writing the file. Sending it anyway would upload bytes nobody
        // inspected.
        let path = temp_file(&vec![0u8; 64]).await;
        let endpoint = Endpoint::plaintext("127.0.0.1", 1);
        let part = FilePart {
            field: "file".into(),
            filename: "a.bin".into(),
            mime: "application/octet-stream".into(),
            path: path.to_string_lossy().into_owned(),
            byte_count: 65,
        };
        assert!(matches!(
            post_multipart(&endpoint, "/upload", vec![], vec![part], None).await,
            Err(TransportError::Protocol { .. })
        ));
    }

    #[tokio::test]
    async fn a_filename_cannot_inject_a_header() {
        let path = temp_file(&[1, 2, 3]).await;
        let endpoint = Endpoint::plaintext("127.0.0.1", 1);
        let part = FilePart {
            field: "file".into(),
            filename: "a\"\r\nX-Evil: 1\r\n\r\n.bin".into(),
            mime: "application/octet-stream".into(),
            path: path.to_string_lossy().into_owned(),
            byte_count: 3,
        };
        assert!(matches!(
            post_multipart(&endpoint, "/upload", vec![], vec![part], None).await,
            Err(TransportError::Protocol { .. })
        ));
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p coven-transport multipart 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Prepend to `crates/coven-transport/src/multipart.rs`:

```rust
//! Multipart upload that streams from a file path.
//!
//! The body is written to the socket in chunks read from disk. Nothing here
//! ever holds a whole attachment in memory, and nothing here base64-encodes:
//! a phone that must not be killed mid-upload cannot afford either.

use crate::{Endpoint, TransportError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Largest single part accepted, matching Cave's `maxFileBytes`.
pub const MAX_PART_BYTES: u64 = 10 * 1024 * 1024;

/// Largest whole request accepted, matching Cave's `maxRequestBytes`.
pub const MAX_REQUEST_BYTES: u64 = 25 * 1024 * 1024;

/// Bytes moved from disk to socket per read.
const CHUNK_BYTES: usize = 64 * 1024;

/// One file to upload.
#[derive(Debug, Clone)]
pub struct FilePart {
    /// Form field name.
    pub field: String,
    /// Filename sent to the server. Validated; never interpolated blindly.
    pub filename: String,
    /// Content type, as sniffed by the caller.
    pub mime: String,
    /// Absolute path on this device.
    pub path: String,
    /// Expected size. Disagreement with the file on disk is an error.
    pub byte_count: u64,
}

/// Called with bytes sent so far. Returns `false` to cancel the upload.
pub type ProgressFn = Box<dyn Fn(u64, u64) -> bool + Send + Sync>;

/// POST a multipart body, streaming each part from disk.
pub async fn post_multipart(
    endpoint: &Endpoint,
    path: &str,
    headers: Vec<(String, String)>,
    parts: Vec<FilePart>,
    progress: Option<ProgressFn>,
) -> Result<String, TransportError> {
    if parts.is_empty() {
        return Err(TransportError::Protocol { detail: "no parts to upload".into() });
    }
    for part in &parts {
        if part.byte_count > MAX_PART_BYTES {
            return Err(TransportError::TooLarge { limit: MAX_PART_BYTES });
        }
        if !is_header_safe(&part.filename) || !is_header_safe(&part.mime) || !is_header_safe(&part.field) {
            return Err(TransportError::Protocol {
                detail: "attachment metadata contains characters that cannot be sent".into(),
            });
        }
        let actual = tokio::fs::metadata(&part.path)
            .await
            .map_err(|error| TransportError::Protocol { detail: format!("staged file unreadable: {error}") })?
            .len();
        if actual != part.byte_count {
            return Err(TransportError::Protocol {
                detail: "staged file changed size after preparation".into(),
            });
        }
    }

    // A fixed boundary derived from the parts would be guessable from content;
    // a random one is not, and multipart requires only that it not appear in
    // the body. The transport's existing RNG is reused rather than adding a
    // dependency.
    let boundary = format!("covenboundary{}", crate::random_token(24));
    let mut preambles = Vec::new();
    let mut total = 0u64;
    for part in &parts {
        let preamble = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            part.field, part.filename, part.mime
        );
        total += preamble.len() as u64 + part.byte_count + 2;
        preambles.push(preamble);
    }
    let closing = format!("--{boundary}--\r\n");
    total += closing.len() as u64;

    if total > MAX_REQUEST_BYTES {
        return Err(TransportError::TooLarge { limit: MAX_REQUEST_BYTES });
    }

    let mut stream = crate::connect(endpoint).await?;
    let mut head = format!("POST {path} HTTP/1.1\r\nHost: {}\r\n", endpoint.host_header());
    for (name, value) in &headers {
        if !is_header_safe(name) || !is_header_safe(value) {
            return Err(TransportError::Protocol { detail: "unsendable header".into() });
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
    ));
    stream.write_all(head.as_bytes()).await.map_err(TransportError::from_io)?;

    let mut sent = 0u64;
    for (part, preamble) in parts.iter().zip(preambles) {
        stream.write_all(preamble.as_bytes()).await.map_err(TransportError::from_io)?;
        sent += preamble.len() as u64;

        let mut file = tokio::fs::File::open(&part.path)
            .await
            .map_err(|error| TransportError::Protocol { detail: format!("staged file unreadable: {error}") })?;
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let mut written = 0u64;
        loop {
            let read = file.read(&mut buffer).await.map_err(TransportError::from_io)?;
            if read == 0 {
                break;
            }
            written += read as u64;
            if written > part.byte_count {
                return Err(TransportError::Protocol {
                    detail: "staged file grew during upload".into(),
                });
            }
            stream.write_all(&buffer[..read]).await.map_err(TransportError::from_io)?;
            sent += read as u64;
            if let Some(report) = &progress {
                if !report(sent, total) {
                    return Err(TransportError::Cancelled);
                }
            }
        }
        if written != part.byte_count {
            return Err(TransportError::Protocol { detail: "staged file shrank during upload".into() });
        }
        stream.write_all(b"\r\n").await.map_err(TransportError::from_io)?;
        sent += 2;
    }
    stream.write_all(closing.as_bytes()).await.map_err(TransportError::from_io)?;
    stream.flush().await.map_err(TransportError::from_io)?;

    crate::read_response_body(&mut stream).await
}

/// Header and disposition values must not carry CR, LF, NUL, or a quote.
fn is_header_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.chars().any(|c| c.is_control() || c == '"')
}
```

Add `TransportError::TooLarge { limit: u64 }` and `TransportError::Cancelled` to `crates/coven-transport/src/lib.rs`, and export `multipart`.

- [ ] **Step 4: Add bounded download-to-file**

Add to `crates/coven-transport/src/fetch.rs`:

```rust
/// GET a response body straight to a file, refusing anything over `limit`.
///
/// Attachment bytes never become a `String` and never sit in memory whole. The
/// destination is created with owner-only permissions because a downloaded
/// attachment is as sensitive as the conversation it came from.
pub async fn get_to_file(
    endpoint: &Endpoint,
    request: &GetRequest,
    destination: &str,
    limit: u64,
) -> Result<u64, TransportError> {
    let mut stream = crate::connect(endpoint).await?;
    write_get_head(&mut stream, endpoint, request).await?;

    let (status, mut body) = crate::read_response_head(&mut stream).await?;
    if status != 200 {
        return Err(TransportError::Status { status });
    }

    let mut file = create_private_file(destination).await?;
    let mut written = 0u64;
    loop {
        if body.is_empty() {
            let mut buffer = vec![0u8; 64 * 1024];
            let read = stream.read(&mut buffer).await.map_err(TransportError::from_io)?;
            if read == 0 {
                break;
            }
            body = buffer[..read].to_vec();
        }
        written += body.len() as u64;
        if written > limit {
            let _ = tokio::fs::remove_file(destination).await;
            return Err(TransportError::TooLarge { limit });
        }
        file.write_all(&body).await.map_err(TransportError::from_io)?;
        body.clear();
    }
    file.flush().await.map_err(TransportError::from_io)?;
    Ok(written)
}

#[cfg(unix)]
async fn create_private_file(path: &str) -> Result<tokio::fs::File, TransportError> {
    use std::os::unix::fs::OpenOptionsExt;
    tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .await
        .map_err(TransportError::from_io)
}
```

- [ ] **Step 5: Run everything, including Pocket**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi
```

Expected: PASS. `coven-transport` gained variants on `TransportError`; Pocket matches on it.

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
git add crates/coven-transport
git commit -S -m "Add streaming multipart upload and download-to-file

Attachment bytes move disk to socket in chunks and never become a
String. A filename that could inject a header is refused rather than
escaped, and a file whose size changed after staging is not sent."
```

---

## Task 8: Attachment Preparation on the Device

Cave re-validates everything authoritatively. That is not a reason to send it junk: the client checks so the user learns a file is unacceptable before waiting for an upload, and so a photo does not carry the user's home coordinates to a server that never asked for them.

Type comes from sniffed bytes. An extension is a claim, not evidence.

**Files:** Create `app/Sources/Support/AttachmentStager.swift`, `app/Tests/AttachmentStagerTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `app/Tests/AttachmentStagerTests.swift`:

```swift
import XCTest
@testable import ChatIOS

final class AttachmentStagerTests: XCTestCase {
    private var stager: AttachmentStager!

    override func setUpWithError() throws {
        stager = try AttachmentStager(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString))
    }

    override func tearDownWithError() throws {
        try stager.discardAll()
    }

    func testSniffsPngRegardlessOfExtension() throws {
        let staged = try stager.stage(data: Self.pngBytes, suggestedName: "photo.txt")
        XCTAssertEqual(staged.mime, "image/png")
        XCTAssertEqual(staged.name, "photo.png", "the name follows the sniffed type")
    }

    func testRejectsSvgEvenWhenNamedPng() throws {
        let svg = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".utf8)
        XCTAssertThrowsError(try stager.stage(data: svg, suggestedName: "a.png")) { error in
            XCTAssertEqual(error as? AttachmentError, .unsupportedType)
        }
    }

    func testRejectsAZipNamedPdf() throws {
        var zip = Data([0x50, 0x4B, 0x03, 0x04])
        zip.append(Data(repeating: 0, count: 64))
        XCTAssertThrowsError(try stager.stage(data: zip, suggestedName: "a.pdf")) { error in
            XCTAssertEqual(error as? AttachmentError, .unsupportedType)
        }
    }

    func testRejectsNonUtf8Text() throws {
        let invalid = Data([0xFF, 0xFE, 0x00, 0x41])
        XCTAssertThrowsError(try stager.stage(data: invalid, suggestedName: "a.txt"))
    }

    func testRejectsAFileOverTheLimit() throws {
        var big = Self.pngBytes
        big.append(Data(repeating: 0, count: AttachmentLimits.maxFileBytes))
        XCTAssertThrowsError(try stager.stage(data: big, suggestedName: "big.png")) { error in
            XCTAssertEqual(error as? AttachmentError, .fileTooLarge)
        }
    }

    func testRejectsMoreThanFourFiles() throws {
        for index in 0..<AttachmentLimits.maxFiles {
            _ = try stager.stage(data: Self.pngBytes, suggestedName: "a\(index).png")
        }
        XCTAssertThrowsError(try stager.stage(data: Self.pngBytes, suggestedName: "extra.png")) { error in
            XCTAssertEqual(error as? AttachmentError, .tooManyFiles)
        }
    }

    func testRejectsWhenTheBatchExceedsTheRequestLimit() throws {
        let chunk = Self.pngBytes + Data(repeating: 0, count: 9 * 1024 * 1024)
        _ = try stager.stage(data: chunk, suggestedName: "a.png")
        _ = try stager.stage(data: chunk, suggestedName: "b.png")
        XCTAssertThrowsError(try stager.stage(data: chunk, suggestedName: "c.png")) { error in
            XCTAssertEqual(error as? AttachmentError, .batchTooLarge)
        }
    }

    func testStripsLocationMetadata() throws {
        let staged = try stager.stage(data: Self.jpegWithGPS, suggestedName: "trip.jpg")
        let source = CGImageSourceCreateWithURL(staged.url as CFURL, nil)
        let properties = CGImageSourceCopyPropertiesAtIndex(source!, 0, nil) as? [CFString: Any]
        XCTAssertNil(properties?[kCGImagePropertyGPSDictionary], "GPS survived staging")
    }

    func testSanitizesTheFilename() throws {
        let staged = try stager.stage(data: Self.pngBytes, suggestedName: "../../etc/passwd\u{0}.png")
        XCTAssertFalse(staged.name.contains("/"))
        XCTAssertFalse(staged.name.contains(".."))
        XCTAssertFalse(staged.name.unicodeScalars.contains { $0.properties.generalCategory == .control })
    }

    func testStagedFilesAreExcludedFromBackup() throws {
        let staged = try stager.stage(data: Self.pngBytes, suggestedName: "a.png")
        let values = try staged.url.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testDiscardRemovesTheFile() throws {
        let staged = try stager.stage(data: Self.pngBytes, suggestedName: "a.png")
        try stager.discard(id: staged.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.url.path))
    }
}
```

Add `pngBytes` and `jpegWithGPS` fixtures as static properties, generated with `ImageIO` in the test file so no binary lands in git.

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test 2>&1 | tail -20
```

Expected: FAIL to compile — `AttachmentStager` does not exist.

- [ ] **Step 3: Implement**

Create `app/Sources/Support/AttachmentStager.swift`:

```swift
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Limits, mirroring Cave's `CLIENT_V1_ATTACHMENT_LIMITS`. Cave re-validates
/// authoritatively; these exist so a person is told before the upload, not
/// after it.
enum AttachmentLimits {
    static let maxFiles = 4
    static let maxFileBytes = 10 * 1024 * 1024
    static let maxRequestBytes = 25 * 1024 * 1024
}

/// Why a file was not staged.
enum AttachmentError: Error, Equatable {
    case unsupportedType
    case fileTooLarge
    case batchTooLarge
    case tooManyFiles
    case unreadable
    case transcodeFailed
}

/// A file prepared for upload, on disk.
struct StagedAttachment: Identifiable, Equatable {
    let id: String
    let name: String
    let mime: String
    let byteCount: Int
    let url: URL
}

/// Prepares files for upload: sniffs the type, transcodes what iOS produces
/// and servers do not want, strips location, and stages the result on disk.
///
/// Nothing here keeps original bytes past the write. The composer holds
/// `StagedAttachment` values, which are paths.
final class AttachmentStager {
    private let directory: URL
    private var staged: [StagedAttachment] = []

    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]
        )
    }

    /// Everything staged, in the order it was added.
    var current: [StagedAttachment] { staged }

    /// Prepare one file.
    func stage(data: Data, suggestedName: String) throws -> StagedAttachment {
        guard staged.count < AttachmentLimits.maxFiles else { throw AttachmentError.tooManyFiles }

        let sniffed = try Self.sniff(data)
        let prepared = try Self.prepare(data: data, sniffed: sniffed)

        guard prepared.data.count <= AttachmentLimits.maxFileBytes else {
            throw AttachmentError.fileTooLarge
        }
        let total = staged.reduce(0) { $0 + $1.byteCount } + prepared.data.count
        guard total <= AttachmentLimits.maxRequestBytes else { throw AttachmentError.batchTooLarge }

        let id = UUID().uuidString
        let name = Self.sanitize(suggestedName, extension: prepared.fileExtension)
        let url = directory.appendingPathComponent(id).appendingPathExtension(prepared.fileExtension)
        try prepared.data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])

        // A staged attachment is conversation content. It must not travel to
        // another device through a backup.
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutable.setResourceValues(values)

        let attachment = StagedAttachment(
            id: id,
            name: name,
            mime: prepared.mime,
            byteCount: prepared.data.count,
            url: url
        )
        staged.append(attachment)
        return attachment
    }

    /// Remove one staged file.
    func discard(id: String) throws {
        guard let index = staged.firstIndex(where: { $0.id == id }) else { return }
        try? FileManager.default.removeItem(at: staged[index].url)
        staged.remove(at: index)
    }

    /// Remove everything. Called on send completion, conversation switch, and
    /// teardown; a staged file that outlives its composer is a leak of content.
    func discardAll() throws {
        for attachment in staged {
            try? FileManager.default.removeItem(at: attachment.url)
        }
        staged.removeAll()
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: - Type detection

    private struct Sniffed {
        let mime: String
        let fileExtension: String
    }

    private struct Prepared {
        let data: Data
        let mime: String
        let fileExtension: String
    }

    /// Identify a file by its leading bytes.
    ///
    /// The extension is not consulted. A `.png` that is a zip is a zip, and
    /// an allowlist keyed on the name would wave it through.
    private static func sniff(_ data: Data) throws -> Sniffed {
        guard data.count >= 12 else { throw AttachmentError.unsupportedType }
        let bytes = [UInt8](data.prefix(16))

        func matches(_ signature: [UInt8], at offset: Int = 0) -> Bool {
            guard bytes.count >= offset + signature.count else { return false }
            return Array(bytes[offset..<offset + signature.count]) == signature
        }

        if matches([0x89, 0x50, 0x4E, 0x47]) { return Sniffed(mime: "image/png", fileExtension: "png") }
        if matches([0xFF, 0xD8, 0xFF]) { return Sniffed(mime: "image/jpeg", fileExtension: "jpg") }
        if matches([0x47, 0x49, 0x46, 0x38]) { return Sniffed(mime: "image/gif", fileExtension: "gif") }
        if matches([0x52, 0x49, 0x46, 0x46]), matches([0x57, 0x45, 0x42, 0x50], at: 8) {
            return Sniffed(mime: "image/webp", fileExtension: "webp")
        }
        if matches([0x52, 0x49, 0x46, 0x46]), matches([0x57, 0x41, 0x56, 0x45], at: 8) {
            return Sniffed(mime: "audio/wav", fileExtension: "wav")
        }
        if matches([0x25, 0x50, 0x44, 0x46]) { return Sniffed(mime: "application/pdf", fileExtension: "pdf") }
        if matches([0x49, 0x44, 0x33]) || matches([0xFF, 0xFB]) {
            return Sniffed(mime: "audio/mpeg", fileExtension: "mp3")
        }
        if matches([0x66, 0x74, 0x79, 0x70], at: 4) {
            let brand = String(decoding: bytes[8..<12], as: UTF8.self)
            // HEIC is what the camera produces and what servers reject.
            if brand.hasPrefix("hei") || brand.hasPrefix("mif") {
                return Sniffed(mime: "image/heic", fileExtension: "heic")
            }
            if brand.hasPrefix("M4A") { return Sniffed(mime: "audio/mp4", fileExtension: "m4a") }
            throw AttachmentError.unsupportedType
        }
        if let text = String(data: data, encoding: .utf8),
           !text.contains("\u{0}"),
           !text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("<svg"),
           !text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("<?xml") {
            return Sniffed(mime: "text/plain", fileExtension: "txt")
        }
        throw AttachmentError.unsupportedType
    }

    /// Transcode HEIC and strip metadata from anything ImageIO understands.
    private static func prepare(data: Data, sniffed: Sniffed) throws -> Prepared {
        let imageTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]
        guard imageTypes.contains(sniffed.mime) else {
            return Prepared(data: data, mime: sniffed.mime, fileExtension: sniffed.fileExtension)
        }

        let target: (utType: UTType, mime: String, ext: String) = sniffed.mime == "image/heic"
            ? (.jpeg, "image/jpeg", "jpg")
            : (UTType(mimeType: sniffed.mime) ?? .png, sniffed.mime, sniffed.fileExtension)

        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let output = CFDataCreateMutable(nil, 0),
              let destination = CGImageDestinationCreateWithData(
                  output, target.utType.identifier as CFString, 1, nil
              )
        else {
            throw AttachmentError.transcodeFailed
        }

        // Copy the image, not the metadata. GPS, and every other EXIF field
        // that carries where and when, is dropped by omission rather than by
        // deletion — there is no field to forget to clear.
        let options: [CFString: Any] = [
            kCGImageDestinationMetadata: [:] as CFDictionary,
            kCGImageDestinationMergeMetadata: false,
            kCGImageDestinationLossyCompressionQuality: 0.9,
        ]
        CGImageDestinationAddImageFromSource(destination, source, 0, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw AttachmentError.transcodeFailed }

        return Prepared(data: output as Data, mime: target.mime, fileExtension: target.ext)
    }

    /// A filename safe to send and safe to show.
    private static func sanitize(_ name: String, extension fileExtension: String) -> String {
        let base = (name as NSString).deletingPathExtension
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: " -_."))
        let cleaned = base.unicodeScalars
            .filter { allowed.contains($0) }
            .map(String.init)
            .joined()
            .replacingOccurrences(of: "..", with: "")
            .trimmingCharacters(in: .whitespaces)
        let stem = cleaned.isEmpty ? "attachment" : String(cleaned.prefix(64))
        return "\(stem).\(fileExtension)"
    }
}
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --strict
git add app/
git commit -S -m "Add attachment staging with content sniffing and metadata stripping

Type comes from leading bytes, so a zip named .pdf is refused. Images
are rebuilt without their metadata dictionary rather than having GPS
deleted from it, which leaves no field to forget."
```

---

## Task 9: Authenticated Media and the Attachment Cache

A Cave attachment needs a bearer. `AsyncImage(url:)` cannot carry one, and any API that takes a bare URL will happily put the token in a request the app does not control — plus a shared URL cache. So Cave-hosted media is fetched through the transport, written to a private cache directory, and rendered from the file.

Remote `https:` images from a familiar's marker are a different matter: they load on an explicit tap and never before.

**Files:** Create `rust/ffi/src/attachments.rs`, `app/Sources/Support/MediaLoader.swift`; modify `rust/ffi/src/session.rs`

- [ ] **Step 1: Write the failing Rust tests**

Add to `rust/ffi/src/attachments.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> MediaCache {
        let dir = std::env::temp_dir().join(format!("media-{}", uuid::Uuid::new_v4()));
        MediaCache::open(dir.to_string_lossy().into_owned()).expect("open")
    }

    #[test]
    fn a_cached_path_is_returned_without_a_fetch() {
        let cache = cache();
        let path = cache.write_for_test("a1", b"bytes").expect("write");
        assert_eq!(cache.cached_path("a1".into()), Some(path));
    }

    #[test]
    fn an_unknown_id_is_not_cached() {
        assert_eq!(cache().cached_path("nope".into()), None);
    }

    #[test]
    fn an_id_that_escapes_the_directory_is_refused() {
        // An attachment id arrives from server JSON. Treating it as a path
        // component without checking is how a traversal happens.
        let cache = cache();
        assert!(cache.write_for_test("../escape", b"x").is_err());
        assert_eq!(cache.cached_path("../escape".into()), None);
    }

    #[test]
    fn eviction_keeps_the_cache_under_its_budget() {
        let cache = cache();
        for index in 0..40 {
            let _ = cache.write_for_test(&format!("a{index}"), &vec![0u8; 512 * 1024]);
        }
        cache.evict_to_budget().expect("evict");
        assert!(cache.total_bytes().expect("size") <= MAX_CACHE_BYTES);
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml attachments 2>&1 | tail -20
```

- [ ] **Step 3: Implement the cache and upload**

Prepend to `rust/ffi/src/attachments.rs`:

```rust
//! Attachment upload and the on-disk media cache.
//!
//! Cave-hosted bytes are fetched with the bearer through `coven-transport` and
//! written to a private directory. Swift renders from the file. No Cave URL is
//! ever handed to a framework that would build its own request: the token
//! would end up in a cache the app does not control.

use crate::ChatError;
use coven_transport::multipart::{FilePart, MAX_PART_BYTES};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Disk budget for cached attachment bytes.
pub const MAX_CACHE_BYTES: u64 = 128 * 1024 * 1024;

/// An attachment Cave accepted.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UploadedAttachmentFfi {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

/// Progress on one upload. Return `false` from Swift to cancel.
#[uniffi::export(with_foreign)]
pub trait UploadProgress: Send + Sync {
    /// Bytes sent of bytes total.
    fn advanced(&self, sent: u64, total: u64) -> bool;
}

/// A private, bounded cache of downloaded attachment bytes.
#[derive(uniffi::Object)]
pub struct MediaCache {
    root: PathBuf,
}

#[uniffi::export]
impl MediaCache {
    /// Open or create the cache directory.
    #[uniffi::constructor]
    pub fn open(directory: String) -> Result<Arc<Self>, ChatError> {
        let root = PathBuf::from(directory);
        std::fs::create_dir_all(&root).map_err(|error| ChatError::Storage {
            message: format!("could not create the media cache: {error}"),
        })?;
        Ok(Arc::new(Self { root }))
    }

    /// The local path for an attachment, if it has been downloaded.
    pub fn cached_path(&self, attachment_id: String) -> Option<String> {
        let path = self.path_for(&attachment_id).ok()?;
        path.exists().then(|| path.to_string_lossy().into_owned())
    }

    /// Total cached bytes.
    pub fn total_bytes(&self) -> Result<u64, ChatError> {
        let mut total = 0u64;
        let entries = std::fs::read_dir(&self.root).map_err(|error| ChatError::Storage {
            message: format!("could not read the media cache: {error}"),
        })?;
        for entry in entries.flatten() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
        Ok(total)
    }

    /// Delete least-recently-used entries until the cache fits its budget.
    pub fn evict_to_budget(&self) -> Result<(), ChatError> {
        let mut entries: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(&self.root)
            .map_err(|error| ChatError::Storage {
                message: format!("could not read the media cache: {error}"),
            })?
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some((meta.accessed().or_else(|_| meta.modified()).ok()?, meta.len(), entry.path()))
            })
            .collect();
        entries.sort_by_key(|(when, _, _)| *when);

        let mut total: u64 = entries.iter().map(|(_, size, _)| size).sum();
        for (_, size, path) in entries {
            if total <= MAX_CACHE_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
        Ok(())
    }

    /// Delete everything. Called on sign-out with the read cache.
    pub fn clear(&self) -> Result<(), ChatError> {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).map_err(|error| ChatError::Storage {
                message: format!("could not clear the media cache: {error}"),
            })?;
            std::fs::create_dir_all(&self.root).map_err(|error| ChatError::Storage {
                message: format!("could not recreate the media cache: {error}"),
            })?;
        }
        Ok(())
    }
}

impl MediaCache {
    /// Resolve an attachment id to a path inside the cache.
    ///
    /// The id comes from server JSON, so it is treated as untrusted input: a
    /// single path component of safe characters, or nothing.
    fn path_for(&self, attachment_id: &str) -> Result<PathBuf, ChatError> {
        let safe = !attachment_id.is_empty()
            && attachment_id.len() <= 128
            && attachment_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !safe {
            return Err(ChatError::Storage { message: "unusable attachment id".to_string() });
        }
        Ok(self.root.join(attachment_id))
    }

    /// Test seam. Not exported.
    #[cfg(test)]
    fn write_for_test(&self, id: &str, bytes: &[u8]) -> Result<String, ChatError> {
        let path = self.path_for(id)?;
        std::fs::write(&path, bytes).map_err(|error| ChatError::Storage {
            message: format!("write failed: {error}"),
        })?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Where a download should land.
    pub(crate) fn destination(&self, attachment_id: &str) -> Result<PathBuf, ChatError> {
        self.path_for(attachment_id)
    }

    /// The cache root.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

/// Build the upload part list for a batch of staged files.
pub(crate) fn parts_for(files: &[(String, String, String, String, u64)]) -> Result<Vec<FilePart>, ChatError> {
    files
        .iter()
        .map(|(_, name, mime, path, size)| {
            if *size > MAX_PART_BYTES {
                return Err(ChatError::Attachment {
                    message: format!("{name} is larger than the 10 MB limit"),
                });
            }
            Ok(FilePart {
                field: "file".to_string(),
                filename: name.clone(),
                mime: mime.clone(),
                path: path.clone(),
                byte_count: *size,
            })
        })
        .collect()
}
```

Add `ChatError::Attachment { message: String }` to the FFI error enum.

- [ ] **Step 4: Expose upload and download on the session**

Add to `rust/ffi/src/session.rs`:

```rust
    /// Upload staged files and return what Cave stored.
    ///
    /// The bytes stream from the paths given; nothing is read whole. The
    /// returned ids are what `send` carries — a file that did not upload
    /// cannot be referenced, which is why send waits for this.
    pub async fn upload_attachments(
        &self,
        files: Vec<StagedFileFfi>,
        progress: Option<Arc<dyn UploadProgress>>,
        network: Option<String>,
    ) -> Result<Vec<UploadedAttachmentFfi>, ChatError> {
        let parts = crate::attachments::parts_for(
            &files
                .iter()
                .map(|f| (f.id.clone(), f.name.clone(), f.mime.clone(), f.path.clone(), f.byte_count))
                .collect::<Vec<_>>(),
        )?;
        let uploaded = self
            .client
            .upload_attachments(parts, progress.map(Into::into), network.as_deref(), &self.store)
            .await?;
        Ok(uploaded.into_iter().map(Into::into).collect())
    }

    /// Download one attachment into the media cache, returning its path.
    ///
    /// Already-cached bytes short-circuit. The bearer is applied by the
    /// client; it never reaches Swift and never appears in a URL.
    pub async fn attachment_path(
        &self,
        attachment_id: String,
        cache: Arc<crate::attachments::MediaCache>,
        network: Option<String>,
    ) -> Result<String, ChatError> {
        if let Some(path) = cache.cached_path(attachment_id.clone()) {
            return Ok(path);
        }
        let destination = cache.destination(&attachment_id)?;
        self.client
            .download_attachment(
                &attachment_id,
                &destination.to_string_lossy(),
                network.as_deref(),
                &self.store,
            )
            .await?;
        cache.evict_to_budget()?;
        Ok(destination.to_string_lossy().into_owned())
    }
```

Add the corresponding `upload_attachments` and `download_attachment` methods to `cave_core::CaveClient`, built on `coven_transport::multipart::post_multipart` and `fetch::get_to_file`, using the same candidate selection as every other call.

- [ ] **Step 5: Implement the Swift loader**

Create `app/Sources/Support/MediaLoader.swift`:

```swift
import SwiftUI

/// Loads image bytes for a block, honouring where they come from.
///
/// Three sources, three policies:
/// - `attachment`: fetched through the authenticated transport into the media
///   cache, then read from disk. Loads when the view appears, because these
///   are the user's own conversation contents on their own Cave.
/// - `inline`: decoded from the marker. No network at all.
/// - `remote`: NOT loaded on appear. A familiar can put any host in a marker,
///   and a transcript that fetches it has told that host the user opened this
///   conversation. Loads only after an explicit tap.
@MainActor
final class MediaLoader: ObservableObject {
    /// What the view should draw right now.
    enum State: Equatable {
        case idle
        case awaitingConsent(host: String)
        case loading
        case ready(UIImage)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let store: CaveStore
    private var task: Task<Void, Never>?

    init(store: CaveStore) {
        self.store = store
    }

    /// Begin whatever loading this source permits without a gesture.
    func begin(_ image: ImageFfi) {
        switch image.kind {
        case "inline":
            guard let base64 = image.base64,
                  let data = Data(base64Encoded: base64),
                  let decoded = UIImage(data: data)
            else {
                state = .failed("This image could not be decoded.")
                return
            }
            state = .ready(decoded)
        case "attachment":
            load(attachmentId: image.attachmentId)
        case "remote":
            state = .awaitingConsent(host: image.host ?? "an external site")
        default:
            state = .failed("This image type is not supported.")
        }
    }

    /// The user tapped a remote image and asked for it.
    func loadRemote(_ image: ImageFfi) {
        guard case .awaitingConsent = state, let raw = image.url, let url = URL(string: raw) else {
            return
        }
        state = .loading
        task?.cancel()
        task = Task { [weak self] in
            // A remote image is fetched with an ephemeral session carrying no
            // credentials and no shared cookie jar. It has nothing to do with
            // Cave and must not borrow Cave's identity.
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieAcceptPolicy = .never
            configuration.httpShouldSetCookies = false
            let session = URLSession(configuration: configuration)
            do {
                let (data, response) = try await session.data(from: url)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      let decoded = UIImage(data: data)
                else {
                    await MainActor.run { self?.state = .failed("That image could not be loaded.") }
                    return
                }
                await MainActor.run { self?.state = .ready(decoded) }
            } catch {
                await MainActor.run { self?.state = .failed("That image could not be loaded.") }
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }

    private func load(attachmentId: String?) {
        guard let attachmentId else {
            state = .failed("This attachment is missing an identifier.")
            return
        }
        state = .loading
        task?.cancel()
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let path = try await store.attachmentPath(id: attachmentId)
                guard let decoded = UIImage(contentsOfFile: path) else {
                    await MainActor.run { self.state = .failed("This attachment could not be read.") }
                    return
                }
                await MainActor.run { self.state = .ready(decoded) }
            } catch let error as ChatError {
                await MainActor.run { self.state = .failed(error.userFacingMessage) }
            } catch {
                await MainActor.run { self.state = .failed("This attachment could not be loaded.") }
            }
        }
    }
}
```

- [ ] **Step 6: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml
./scripts/build-xcframework.sh && xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add rust/ app/
git commit -S -m "Add attachment upload, the media cache, and the image loader

A remote image named by a familiar does not load until the user taps it,
and then through an ephemeral session with no credentials. Cave-hosted
bytes go through the authenticated transport to a private file."
```

---

## Task 10: Actions in `cave-core`

Execution, as opposed to recognition. Every request here carries `confirmed: true` and an idempotency key, and every response is classified into an outcome the caller cannot mistake for success.

**Files:** Create `crates/cave-core/src/actions.rs`; modify `crates/cave-core/src/lib.rs`, `src/client.rs`

- [ ] **Step 1: Write the failing tests**

Add to `crates/cave-core/src/actions.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::markup::action::{GitHubAction, MergeMethod};

    fn request() -> ActionRequest {
        ActionRequest {
            idempotency_key: "11111111-1111-4111-8111-111111111111".to_string(),
            confirmed: true,
            action: ActionRequestKind::GitHub(GitHubAction::Merge {
                repo: "o/r".into(),
                number: 7,
                method: MergeMethod::Squash,
            }),
        }
    }

    #[test]
    fn a_request_serializes_with_confirmation_and_a_key() {
        let json = serde_json::to_value(request()).expect("serialize");
        assert_eq!(json["confirmed"], serde_json::json!(true));
        assert_eq!(json["idempotencyKey"], serde_json::json!("11111111-1111-4111-8111-111111111111"));
    }

    #[test]
    fn an_unconfirmed_request_cannot_be_built() {
        assert!(ActionRequest::confirmed(request().action.clone(), "not-a-uuid".into()).is_err());
    }

    #[test]
    fn a_successful_response_is_completed() {
        let outcome = classify_response(200, "{\"ok\":true,\"result\":{\"url\":\"https://x.test/1\"}}");
        assert!(matches!(outcome, ActionOutcome::Completed { .. }));
    }

    #[test]
    fn a_two_hundred_without_ok_is_not_completed() {
        // A body the client cannot read is not evidence the mutation ran.
        let outcome = classify_response(200, "{\"queued\":true}");
        assert!(matches!(outcome, ActionOutcome::Failed { .. }));
    }

    #[test]
    fn a_rejection_is_rejected_not_failed() {
        let outcome = classify_response(
            403,
            "{\"ok\":false,\"error\":{\"code\":\"scope_missing\",\"message\":\"Not permitted\",\"retryable\":false}}",
        );
        match outcome {
            ActionOutcome::Rejected { code, .. } => assert_eq!(code, "scope_missing"),
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    #[test]
    fn a_five_hundred_with_no_body_is_ambiguous() {
        // The mutation may have run. Retrying without reconciling could
        // double-merge a pull request.
        assert!(matches!(classify_response(502, ""), ActionOutcome::Ambiguous { .. }));
    }

    #[test]
    fn a_timeout_is_ambiguous() {
        assert!(matches!(
            outcome_for_transport(&crate::CaveError::Unreachable { detail: "timed out".into() }),
            ActionOutcome::Ambiguous { .. }
        ));
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core actions 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/actions.rs`:

```rust
//! Executing a confirmed action, and the conversation mutations.
//!
//! Three rules hold every type here in shape:
//!
//! 1. A request cannot be constructed without confirmation and a key.
//! 2. `Completed` requires a successful, well-formed response. Nothing else
//!    produces it.
//! 3. An unknown outcome is `Ambiguous`, which is not a failure and not a
//!    success, and which the caller must reconcile rather than retry.

use crate::error::{ErrorEnvelope, CaveError};
pub use crate::markup::action::ActionRequestKind;
use serde::{Deserialize, Serialize};

/// A confirmed request, ready to send.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    /// Client-generated, reused for every attempt at this same confirmation.
    pub idempotency_key: String,
    /// Always true. The field exists because Cave requires it; the type
    /// exists so it cannot be false.
    pub confirmed: bool,
    /// What to do.
    #[serde(flatten)]
    pub action: ActionRequestKind,
}

impl ActionRequest {
    /// Build a confirmed request.
    ///
    /// The key must be a UUID. A caller that passes a counter, a timestamp, or
    /// a hash of the content will collide across devices, and a colliding
    /// idempotency key on a mutation is worse than no key at all.
    pub fn confirmed(action: ActionRequestKind, idempotency_key: String) -> Result<Self, CaveError> {
        if !is_uuid(&idempotency_key) {
            return Err(CaveError::Contract {
                detail: "idempotency key must be a UUID".to_string(),
            });
        }
        Ok(Self { idempotency_key, confirmed: true, action })
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
}

/// What happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionOutcome {
    /// Cave ran it and said so.
    Completed { result_json: String },
    /// Cave declined. The action did not run.
    Rejected { code: String, message: String },
    /// Cave tried and failed. The action did not run.
    Failed { code: String, message: String },
    /// Unknown. It may have run. Reconcile before doing anything else.
    Ambiguous { detail: String },
}

/// The successful envelope shape.
#[derive(Debug, Deserialize)]
struct ActionSuccess {
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
}

/// Classify a response.
pub fn classify_response(status: u16, body: &str) -> ActionOutcome {
    if (200..300).contains(&status) {
        return match serde_json::from_str::<ActionSuccess>(body) {
            Ok(success) if success.ok => ActionOutcome::Completed {
                result_json: success.result.to_string(),
            },
            // A 2xx whose body this client cannot read is not proof the
            // mutation ran, and presenting it as completed would be a
            // success-shaped fallback over an unknown.
            _ => ActionOutcome::Failed {
                code: "malformed_response".to_string(),
                message: "Cave's reply could not be read, so this was not confirmed.".to_string(),
            },
        };
    }

    match serde_json::from_str::<ErrorEnvelope>(body) {
        Ok(envelope) => {
            let denial = matches!(status, 400 | 401 | 403 | 404 | 409 | 422);
            if denial {
                ActionOutcome::Rejected { code: envelope.code, message: envelope.message }
            } else {
                ActionOutcome::Failed { code: envelope.code, message: envelope.message }
            }
        }
        // A 5xx with no readable envelope may or may not have run. This is
        // the case that must never turn into an automatic retry.
        Err(_) if status >= 500 => ActionOutcome::Ambiguous {
            detail: format!("Cave replied {status} with no usable detail."),
        },
        Err(_) => ActionOutcome::Failed {
            code: "unknown_error".to_string(),
            message: format!("Cave replied {status}."),
        },
    }
}

/// Classify a transport failure. Anything that leaves the request's fate
/// unknown is ambiguous, including a timeout after the bytes went out.
pub fn outcome_for_transport(error: &CaveError) -> ActionOutcome {
    match error {
        CaveError::Unreachable { detail } => ActionOutcome::Ambiguous { detail: detail.clone() },
        other => ActionOutcome::Failed {
            code: "transport".to_string(),
            message: other.to_string(),
        },
    }
}

/// Conversation management, which is a mutation like any other and carries
/// the same key.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
pub enum ConversationMutation {
    Rename { title: String },
    Pin { pinned: bool },
    Archive { archived: bool },
    Delete,
}

impl ConversationMutation {
    /// The confirmation sentence. `Delete` is the only irreversible one and
    /// says so.
    pub fn summary(&self, conversation_title: &str) -> String {
        match self {
            Self::Rename { title } => format!("Rename \"{conversation_title}\" to \"{title}\""),
            Self::Pin { pinned: true } => format!("Pin \"{conversation_title}\""),
            Self::Pin { pinned: false } => format!("Unpin \"{conversation_title}\""),
            Self::Archive { archived: true } => format!("Archive \"{conversation_title}\""),
            Self::Archive { archived: false } => format!("Unarchive \"{conversation_title}\""),
            Self::Delete => {
                format!("Delete \"{conversation_title}\" and its messages. This cannot be undone.")
            }
        }
    }

    /// Whether a confirmation sheet is required. Reversible operations do not
    /// need one; deletion always does.
    pub fn requires_confirmation(&self) -> bool {
        matches!(self, Self::Delete)
    }
}
```

Add the `CaveClient` methods that send these against `/api/client/v1/github/actions`, `/attention/responses`, `/tasks/handoffs`, and `/conversations/{id}`, each returning `ActionOutcome` and each routing through the existing candidate selection and error envelope handling.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core
cargo clippy -p cave-core --all-targets -- -D warnings
git add crates/cave-core
git commit -S -m "Add confirmed action requests and outcome classification

A 2xx whose body cannot be read is Failed, not Completed, and a 5xx with
no envelope is Ambiguous. Neither may be presented as a mutation that
ran, and Ambiguous is the one that must never auto-retry."
```

---

## Task 11: The Action Journal

Phase E established that an ambiguous outcome is never resubmitted automatically. Actions get the same treatment, plus one addition: a key belongs to a confirmation, not to an attempt. Tapping "Merge" once and retrying a network failure must reuse the key. Tapping "Merge" again after cancelling must mint a new one.

**Files:** Create `rust/ffi/src/journal.rs`; modify `rust/ffi/src/session.rs`, `lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to `rust/ffi/src/journal.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> ActionJournal {
        let dir = std::env::temp_dir().join(format!("journal-{}", uuid::Uuid::new_v4()));
        ActionJournal::open(dir.to_string_lossy().into_owned()).expect("open")
    }

    #[test]
    fn confirming_mints_a_uuid_key() {
        let journal = journal();
        let entry = journal.confirm("p1".into(), "{}".into(), "Merge o/r #7".into()).expect("confirm");
        assert_eq!(entry.idempotency_key.len(), 36);
        assert_eq!(entry.state, ActionState::Confirmed);
    }

    #[test]
    fn retrying_the_same_confirmation_reuses_the_key() {
        let journal = journal();
        let first = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        journal.mark_failed("p1".into(), "network".into()).expect("fail");
        let retried = journal.retry("p1".into()).expect("retry");
        assert_eq!(retried.idempotency_key, first.idempotency_key);
    }

    #[test]
    fn a_fresh_confirmation_after_discard_mints_a_new_key() {
        let journal = journal();
        let first = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        journal.discard("p1".into()).expect("discard");
        let second = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        assert_ne!(second.idempotency_key, first.idempotency_key);
    }

    #[test]
    fn a_completed_action_cannot_be_confirmed_again() {
        let journal = journal();
        let _ = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        journal.mark_completed("p1".into(), "{}".into()).expect("complete");
        assert!(journal.confirm("p1".into(), "{}".into(), "s".into()).is_err());
    }

    #[test]
    fn an_ambiguous_action_is_not_retryable_until_reconciled() {
        let journal = journal();
        let _ = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        journal.mark_ambiguous("p1".into(), "no reply".into()).expect("ambiguous");
        assert!(journal.retry("p1".into()).is_err(), "an unknown outcome must not resubmit");

        journal.reconcile("p1".into(), false).expect("reconcile");
        assert!(journal.retry("p1".into()).is_ok(), "reconciling to did-not-land allows a retry");
    }

    #[test]
    fn reconciling_to_landed_completes_rather_than_retries() {
        let journal = journal();
        let _ = journal.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        journal.mark_ambiguous("p1".into(), "no reply".into()).expect("ambiguous");
        journal.reconcile("p1".into(), true).expect("reconcile");
        assert_eq!(journal.entry("p1".into()).expect("entry").state, ActionState::Completed);
        assert!(journal.retry("p1".into()).is_err());
    }

    #[test]
    fn state_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!("journal-{}", uuid::Uuid::new_v4()));
        let path = dir.to_string_lossy().into_owned();
        let first = ActionJournal::open(path.clone()).expect("open");
        let entry = first.confirm("p1".into(), "{}".into(), "s".into()).expect("confirm");
        drop(first);

        let second = ActionJournal::open(path).expect("reopen");
        assert_eq!(second.entry("p1".into()).expect("entry").idempotency_key, entry.idempotency_key);
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml journal 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Prepend to `rust/ffi/src/journal.rs`:

```rust
//! The durable action journal.
//!
//! One entry per proposal the user has confirmed. The entry owns the
//! idempotency key, which is what makes "retry after a dropped connection"
//! safe and "tap merge twice" honest.
//!
//! The state machine is deliberately narrow. There is exactly one transition
//! out of `Ambiguous`, and it goes through `reconcile`.

use crate::ChatError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Where an action is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum ActionState {
    /// The user confirmed it; it has not been sent.
    Confirmed,
    /// In flight.
    Submitting,
    /// Cave ran it.
    Completed,
    /// Cave declined it. It did not run.
    Rejected,
    /// It did not run, and it can be tried again.
    Failed,
    /// Outcome unknown. Must be reconciled before anything else happens.
    Ambiguous,
}

/// One confirmed action.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct ActionEntry {
    /// The proposal this came from, stable across re-renders.
    pub proposal_id: String,
    /// Minted at confirmation, reused for every attempt at that confirmation.
    pub idempotency_key: String,
    /// The request body.
    pub payload_json: String,
    /// The summary the user actually saw when they confirmed.
    pub summary: String,
    pub state: ActionState,
    /// Set on rejection, failure, or ambiguity.
    pub detail: Option<String>,
    /// Set on completion.
    pub result_json: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    entries: HashMap<String, ActionEntry>,
}

/// Durable action state.
#[derive(uniffi::Object)]
pub struct ActionJournal {
    path: PathBuf,
    stored: Mutex<Stored>,
}

#[uniffi::export]
impl ActionJournal {
    /// Open or create the journal.
    #[uniffi::constructor]
    pub fn open(directory: String) -> Result<Arc<Self>, ChatError> {
        let root = PathBuf::from(directory);
        std::fs::create_dir_all(&root).map_err(|error| ChatError::Storage {
            message: format!("could not create the action journal: {error}"),
        })?;
        let path = root.join("actions.json");
        let stored = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Stored::default(),
        };
        Ok(Arc::new(Self { path, stored: Mutex::new(stored) }))
    }

    /// Record a confirmation and mint its key.
    ///
    /// Refuses when an entry for this proposal already exists in a state that
    /// is not retryable — confirming a completed action a second time is the
    /// double-submit this whole file exists to prevent.
    pub fn confirm(
        &self,
        proposal_id: String,
        payload_json: String,
        summary: String,
    ) -> Result<ActionEntry, ChatError> {
        let mut stored = self.lock()?;
        if let Some(existing) = stored.entries.get(&proposal_id) {
            match existing.state {
                ActionState::Failed | ActionState::Rejected => {}
                other => {
                    return Err(ChatError::Action {
                        message: format!("this action is already {other:?} and cannot be confirmed again"),
                    })
                }
            }
        }
        let entry = ActionEntry {
            proposal_id: proposal_id.clone(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            payload_json,
            summary,
            state: ActionState::Confirmed,
            detail: None,
            result_json: None,
        };
        stored.entries.insert(proposal_id, entry.clone());
        self.persist(&stored)?;
        Ok(entry)
    }

    /// One entry.
    pub fn entry(&self, proposal_id: String) -> Option<ActionEntry> {
        self.stored.lock().ok()?.entries.get(&proposal_id).cloned()
    }

    /// Mark an entry in flight.
    pub fn mark_submitting(&self, proposal_id: String) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            entry.state = ActionState::Submitting;
            entry.detail = None;
        })
    }

    /// Cave ran it.
    pub fn mark_completed(&self, proposal_id: String, result_json: String) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            entry.state = ActionState::Completed;
            entry.result_json = Some(result_json);
            entry.detail = None;
        })
    }

    /// Cave declined it.
    pub fn mark_rejected(&self, proposal_id: String, detail: String) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            entry.state = ActionState::Rejected;
            entry.detail = Some(detail);
        })
    }

    /// It did not run, and may be tried again.
    pub fn mark_failed(&self, proposal_id: String, detail: String) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            entry.state = ActionState::Failed;
            entry.detail = Some(detail);
        })
    }

    /// Outcome unknown.
    pub fn mark_ambiguous(&self, proposal_id: String, detail: String) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            entry.state = ActionState::Ambiguous;
            entry.detail = Some(detail);
        })
    }

    /// Resolve an ambiguous entry against what Cave actually shows.
    ///
    /// This is the only way out of `Ambiguous`. `landed` comes from reading
    /// canonical state, not from guessing.
    pub fn reconcile(&self, proposal_id: String, landed: bool) -> Result<(), ChatError> {
        self.transition(&proposal_id, |entry| {
            if entry.state == ActionState::Ambiguous {
                entry.state = if landed { ActionState::Completed } else { ActionState::Failed };
                entry.detail = None;
            }
        })
    }

    /// Prepare a retry of an existing confirmation, reusing its key.
    pub fn retry(&self, proposal_id: String) -> Result<ActionEntry, ChatError> {
        let mut stored = self.lock()?;
        let entry = stored.entries.get_mut(&proposal_id).ok_or_else(|| ChatError::Action {
            message: "no such action".to_string(),
        })?;
        if entry.state != ActionState::Failed {
            return Err(ChatError::Action {
                message: format!("an action that is {:?} cannot be retried", entry.state),
            });
        }
        entry.state = ActionState::Confirmed;
        entry.detail = None;
        let out = entry.clone();
        self.persist(&stored)?;
        Ok(out)
    }

    /// Forget an entry, so a future confirmation starts fresh.
    pub fn discard(&self, proposal_id: String) -> Result<(), ChatError> {
        let mut stored = self.lock()?;
        stored.entries.remove(&proposal_id);
        self.persist(&stored)
    }

    /// Every entry needing reconciliation.
    pub fn ambiguous(&self) -> Vec<ActionEntry> {
        self.stored
            .lock()
            .map(|stored| {
                stored
                    .entries
                    .values()
                    .filter(|entry| entry.state == ActionState::Ambiguous)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Drop everything. Called on sign-out.
    pub fn clear(&self) -> Result<(), ChatError> {
        let mut stored = self.lock()?;
        stored.entries.clear();
        self.persist(&stored)
    }
}

impl ActionJournal {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Stored>, ChatError> {
        self.stored.lock().map_err(|_| ChatError::Storage {
            message: "the action journal is poisoned".to_string(),
        })
    }

    fn transition(
        &self,
        proposal_id: &str,
        change: impl FnOnce(&mut ActionEntry),
    ) -> Result<(), ChatError> {
        let mut stored = self.lock()?;
        let entry = stored.entries.get_mut(proposal_id).ok_or_else(|| ChatError::Action {
            message: "no such action".to_string(),
        })?;
        change(entry);
        self.persist(&stored)
    }

    fn persist(&self, stored: &Stored) -> Result<(), ChatError> {
        let raw = serde_json::to_string(stored).map_err(|error| ChatError::Storage {
            message: format!("could not encode the action journal: {error}"),
        })?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, raw).map_err(|error| ChatError::Storage {
            message: format!("could not write the action journal: {error}"),
        })?;
        std::fs::rename(&temporary, &self.path).map_err(|error| ChatError::Storage {
            message: format!("could not commit the action journal: {error}"),
        })
    }
}
```

Add `ChatError::Action { message: String }` to the FFI error enum.

- [ ] **Step 4: Wire submission through the session**

Add to `rust/ffi/src/session.rs` a `perform_action` that takes the journal and a proposal id, marks submitting, sends, and records the classified outcome — with no path that retries on its own:

```rust
    /// Send a confirmed action and record what happened.
    ///
    /// There is no retry here on purpose. `Ambiguous` returns to Swift as
    /// `Ambiguous`, and the only way forward is reconciliation followed by an
    /// explicit human decision.
    pub async fn perform_action(
        &self,
        journal: Arc<crate::journal::ActionJournal>,
        proposal_id: String,
        network: Option<String>,
    ) -> Result<crate::journal::ActionEntry, ChatError> {
        let entry = journal.entry(proposal_id.clone()).ok_or_else(|| ChatError::Action {
            message: "no such action".to_string(),
        })?;
        if entry.state != crate::journal::ActionState::Confirmed {
            return Err(ChatError::Action {
                message: format!("an action that is {:?} is not ready to send", entry.state),
            });
        }
        journal.mark_submitting(proposal_id.clone())?;

        let outcome = self
            .client
            .perform_action(&entry.payload_json, &entry.idempotency_key, network.as_deref(), &self.store)
            .await;

        match outcome {
            Ok(cave_core::actions::ActionOutcome::Completed { result_json }) => {
                journal.mark_completed(proposal_id.clone(), result_json)?;
            }
            Ok(cave_core::actions::ActionOutcome::Rejected { code, message }) => {
                journal.mark_rejected(proposal_id.clone(), format!("{code}: {message}"))?;
            }
            Ok(cave_core::actions::ActionOutcome::Failed { code, message }) => {
                journal.mark_failed(proposal_id.clone(), format!("{code}: {message}"))?;
            }
            Ok(cave_core::actions::ActionOutcome::Ambiguous { detail }) => {
                journal.mark_ambiguous(proposal_id.clone(), detail)?;
            }
            Err(error) => match cave_core::actions::outcome_for_transport(&error) {
                cave_core::actions::ActionOutcome::Ambiguous { detail } => {
                    journal.mark_ambiguous(proposal_id.clone(), detail)?;
                }
                _ => journal.mark_failed(proposal_id.clone(), error.to_string())?,
            },
        }

        journal.entry(proposal_id).ok_or_else(|| ChatError::Action {
            message: "the action vanished from the journal".to_string(),
        })
    }
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
git add rust/
git commit -S -m "Add the durable action journal

The key belongs to the confirmation, so a retry after a dropped
connection reuses it and a second deliberate tap does not. Ambiguous has
exactly one exit and it goes through reconcile."
```

---

## Task 12: Native Renderers

Every block gets a view. The views are ordinary SwiftUI: `Text`, `Image`, `Grid`. There is no HTML anywhere in this task, and the CI gate in Task 16 makes that structural rather than aspirational.

**Files:** Create `app/Sources/Content/*.swift`, `app/Sources/Support/SafariLink.swift`, `app/Tests/BlockRenderingTests.swift`; modify `app/Sources/Views/ThreadView.swift`

- [ ] **Step 1: Write the failing tests**

Create `app/Tests/BlockRenderingTests.swift`. These test the view models and the decisions, not pixels — a snapshot test would pin a layout, and what matters here is that nothing loads, executes, or lies.

```swift
import XCTest
@testable import ChatIOS

@MainActor
final class BlockRenderingTests: XCTestCase {
    func testUnsupportedBlocksAreNotInteractive() {
        let model = BlockPresentation(block: .unsupported(
            source: "<coven:hologram x=\"1\" />", reason: "unknown"
        ))
        XCTAssertFalse(model.isInteractive)
        XCTAssertEqual(model.accessibilityLabel, "Unsupported content")
    }

    func testARemoteImageDoesNotLoadOnAppear() {
        let loader = MediaLoader(store: CaveStore.preview)
        loader.begin(ImageFfi(
            kind: "remote", url: "https://tracker.test/1.png", host: "tracker.test",
            attachmentId: nil, mime: nil, base64: nil, alt: nil, caption: nil
        ))
        guard case .awaitingConsent(let host) = loader.state else {
            return XCTFail("a remote image began loading without a gesture")
        }
        XCTAssertEqual(host, "tracker.test")
    }

    func testACitationShowsItsDomainWithoutFetching() {
        let citation = CitationFfi(
            n: 1, title: "Page", url: "https://example.com/a", domain: "example.com",
            snippet: nil, filePath: nil, lineStart: nil, lineEnd: nil
        )
        let model = CitationPresentation(citation: citation)
        XCTAssertEqual(model.subtitle, "example.com")
        XCTAssertTrue(model.opensExternally)
    }

    func testAFileCitationIsNotTappable() {
        let citation = CitationFfi(
            n: 1, title: "src/lib/foo.ts", url: nil, domain: nil, snippet: nil,
            filePath: "src/lib/foo.ts", lineStart: 12, lineEnd: 18
        )
        let model = CitationPresentation(citation: citation)
        XCTAssertFalse(model.opensExternally)
        XCTAssertEqual(model.subtitle, "Lines 12 to 18")
    }

    func testStatusIsDistinguishableWithoutColor() {
        // A red dot and a green dot are the same dot to a large share of
        // users. Every status carries a symbol and a word.
        for stage in ["loaded", "running", "done", "error"] {
            let model = SkillPresentation(name: "s", stage: stage, note: nil)
            XCTAssertFalse(model.symbolName.isEmpty)
            XCTAssertFalse(model.statusWord.isEmpty)
        }
    }

    func testADocumentCardReportsItsSize() {
        let model = DocumentPresentation(
            kind: "spec", title: "T", markdown: "# T\n\n## A\n\n## B", sectionCount: 2, readingMinutes: 1
        )
        XCTAssertEqual(model.subtitle, "2 sections, 1 min read")
    }

    func testALinkRunExposesItsHostBeforeTheTap() {
        let run = RunFfi.link(text: "docs", url: "https://example.com/deep/path", host: "example.com")
        XCTAssertEqual(LinkPresentation(run: run)?.host, "example.com")
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test 2>&1 | tail -20
```

- [ ] **Step 3: Implement the dispatcher**

Create `app/Sources/Content/BlockView.swift`:

```swift
import SwiftUI

/// Renders one block.
///
/// Exhaustive over `BlockFfi` with no `default` case: a new block kind in the
/// core must be handled here, and the compiler is what enforces that rather
/// than a reviewer noticing.
@MainActor
struct BlockView: View {
    let block: BlockFfi
    let citations: [CitationFfi]
    @ObservedObject var model: ThreadModel

    var body: some View {
        switch block {
        case .text(let spans):
            MarkdownView(spans: spans, citations: citations)
        case .code(let language, let source):
            CodeBlockView(language: language, source: source)
        case .carousel(let images):
            ImageCarouselView(images: images, store: model.store)
        case .gitHubCard(let card):
            GitHubCardView(card: card)
        case .actionProposal(let proposal):
            ActionCardView(proposal: proposal, model: model)
        case .skillStage(let name, let stage, let note):
            StatusCardView(presentation: SkillPresentation(name: name, stage: stage, note: note))
        case .autoStatus(let state, let note):
            StatusCardView(presentation: AutoStatusPresentation(state: state, note: note))
        case .attention(let reason):
            AttentionCardView(reason: reason, model: model)
        case .document(let kind, let title, let markdown, let sectionCount, let readingMinutes):
            DocumentCardView(presentation: DocumentPresentation(
                kind: kind, title: title, markdown: markdown,
                sectionCount: sectionCount, readingMinutes: readingMinutes
            ))
        case .citations(let list):
            CitationListView(citations: list)
        case .unsupported(let source, let reason):
            UnsupportedBlockView(source: source, reason: reason)
        }
    }
}
```

- [ ] **Step 4: Implement the prose, code, and link views**

Create `app/Sources/Content/MarkdownView.swift`:

```swift
import SwiftUI

/// Native prose. No attributed-string markdown parsing, no HTML, no web view.
@MainActor
struct MarkdownView: View {
    let spans: [SpanFfi]
    let citations: [CitationFfi]
    @State private var externalURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(spans.enumerated()), id: \.offset) { _, span in
                span(for: span)
            }
        }
        .sheet(item: $externalURL) { url in
            SafariLink(url: url)
        }
    }

    @ViewBuilder
    private func span(for span: SpanFfi) -> some View {
        switch span {
        case .heading(let level, let runs):
            inline(runs)
                .font(headingFont(level))
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let runs):
            inline(runs)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(index + 1)." : "\u{2022}")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        inline(item.runs)
                    }
                }
            }
        case .quote(let runs):
            HStack(alignment: .top, spacing: 10) {
                Rectangle().frame(width: 3).foregroundStyle(.tertiary)
                inline(runs).foregroundStyle(.secondary)
            }
        case .table(let header, let rows):
            // A table on a phone scrolls sideways rather than reflowing into
            // something that is no longer a table.
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    GridRow {
                        ForEach(header, id: \.self) { cell in
                            Text(cell).font(.subheadline.weight(.semibold))
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(row.cells, id: \.self) { cell in
                                Text(cell).font(.subheadline)
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        case .divider:
            Divider()
        }
    }

    private func inline(_ runs: [RunFfi]) -> some View {
        runs.reduce(Text("")) { partial, run in
            switch run {
            case .text(let text):
                return partial + Text(text)
            case .emphasis(let text):
                return partial + Text(text).italic()
            case .strong(let text):
                return partial + Text(text).bold()
            case .code(let text):
                return partial + Text(text).font(.system(.body, design: .monospaced))
            case .link(let text, _, _):
                // Underlined and tinted, but not a Link: the tap is handled
                // below so the destination goes through SafariLink and never
                // through an arbitrary URL handler.
                return partial + Text(text).underline().foregroundColor(.accentColor)
            case .citationRef(let n):
                return partial + Text("[\(n)]").font(.caption2).baselineOffset(6)
            }
        }
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            externalURL = url
            return .handled
        })
    }

    private func headingFont(_ level: UInt8) -> Font {
        switch level {
        case 1: return .title2.weight(.semibold)
        case 2: return .title3.weight(.semibold)
        default: return .headline
        }
    }
}
```

Create `app/Sources/Support/SafariLink.swift`:

```swift
import SafariServices
import SwiftUI

/// Opens a URL in Safari's own process.
///
/// This is not a rendering surface. The app cannot inject script into it, read
/// its DOM, or observe its cookies — which is exactly why it is the only way a
/// transcript reaches the web.
struct SafariLink: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        return SFSafariViewController(url: url, configuration: configuration)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

extension URL: Identifiable {
    public var id: String { absoluteString }
}
```

Create `app/Sources/Content/CodeBlockView.swift` with a horizontally scrolling monospaced body, the language as a caption, and a copy button that reports success through an accessibility announcement rather than only a colour change.

- [ ] **Step 5: Implement the cards**

Create the remaining views:

- `ImageCarouselView` — a `TabView` with `.page` style over `MediaLoader`s. A remote image shows its host and a "Load image" button; tapping calls `loadRemote`. Alt text becomes the accessibility label; a picture with neither alt nor caption is labelled by position ("Image 2 of 5").
- `CitationView` / `CitationListView` — numbered rows showing title and domain, or path and line range. Only a web citation is tappable, and it opens `SafariLink`.
- `DocumentCardView` — title, kind, "N sections, M min read", opening `DocumentReaderView` in a sheet. The reader renders the document's markdown through `MarkdownView`, reusing the same parser via `ContentCache` with a synthetic id.
- `StatusCardView` — driven by a `StatusPresentation` protocol so skill stages, auto-mission states, and Phase E's `ProgressStep` values all render through one view. Each state supplies a symbol, a word, and a colour, in that order of importance.
- `ToolCardView` — Phase E's `ToolPayload` values, collapsed by default, expandable, with arguments redacted to name and count rather than dumped.
- `GitHubCardView` — repo, number, kind, and title. Tapping opens the item in `SafariLink`. It performs no API call: it is a card, not a live view.
- `UnsupportedBlockView` — a muted, non-interactive card reading "Unsupported content" with the source available behind a disclosure. It is deliberately dull. A user should be able to tell that something was there and that this client will not act on it.

- [ ] **Step 6: Wire the transcript**

In `ThreadView`, replace `Text(message.text)` with:

```swift
                    ForEach(Array(model.blocks(for: message).enumerated()), id: \.offset) { _, block in
                        BlockView(block: block, citations: model.citations(for: message), model: model)
                    }
```

and replace the streaming text with the same, parsed in streaming mode. Add to `ThreadModel`:

```swift
    /// Blocks for one canonical turn, parsed once and cached.
    func blocks(for message: MessageFfi) -> [BlockFfi] {
        store.content.blocks(messageId: message.id, text: message.text, streaming: false)
    }

    /// Blocks for the run in flight.
    ///
    /// Streaming mode withholds a half-arrived marker, so a `<coven:atten`
    /// tail never flashes as literal text before completing.
    var streamingBlocks: [BlockFfi] {
        guard !streamingText.isEmpty else { return [] }
        return store.content.blocks(
            messageId: activeRunId ?? "streaming",
            text: streamingText,
            streaming: true
        )
    }
```

- [ ] **Step 7: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --strict
git add app/
git commit -S -m "Render every block natively

The dispatcher is exhaustive with no default case, so a new block kind
in the core fails the build here rather than rendering as nothing. Links
go through SFSafariViewController and nothing else opens a URL."
```

---

## Task 13: Confirmation and Result

A proposal is an offer. This task is the difference between an offer and an action, and it is the part of the phase where a bug is measured in merged pull requests.

**Files:** Create `app/Sources/Actions/ActionCardView.swift`, `ConfirmationSheet.swift`, `AttentionCardView.swift`, `app/Tests/ActionGestureTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `app/Tests/ActionGestureTests.swift`:

```swift
import XCTest
@testable import ChatIOS

@MainActor
final class ActionGestureTests: XCTestCase {
    private var store: RecordingCaveStore!
    private var model: ThreadModel!

    override func setUp() async throws {
        store = RecordingCaveStore()
        model = ThreadModel(conversationId: "c1", store: store)
    }

    private func proposal() -> ActionProposalFfi {
        ActionProposalFfi(
            proposalId: "m1:0", family: "github", kind: "merge",
            summary: "Merge o/r #7 using squash",
            payloadJson: "{\"family\":\"github\",\"kind\":\"merge\"}"
        )
    }

    func testRenderingAProposalPerformsNoCalls() {
        _ = ActionCardView(proposal: proposal(), model: model)
        XCTAssertEqual(store.performedActions, 0)
    }

    func testTheSheetShowsTheExactSummary() {
        let sheet = ConfirmationSheet(
            title: "Confirm this action", summary: proposal().summary, destructive: false
        ) {} onCancel: {}
        XCTAssertEqual(sheet.summary, "Merge o/r #7 using squash")
    }

    func testCancellingPerformsNothing() async {
        await model.cancelAction(proposalId: "m1:0")
        XCTAssertEqual(store.performedActions, 0)
        XCTAssertNil(store.journal.entry(proposalId: "m1:0"))
    }

    func testOneConfirmationPerformsExactlyOneMutation() async {
        await model.confirmAction(proposal())
        XCTAssertEqual(store.performedActions, 1)
    }

    func testASecondConfirmationOfACompletedActionIsRefused() async {
        store.nextOutcome = .completed
        await model.confirmAction(proposal())
        await model.confirmAction(proposal())
        XCTAssertEqual(store.performedActions, 1, "a completed action was submitted twice")
    }

    func testRetryReusesTheKeyAndDoesNotFireByItself() async {
        store.nextOutcome = .failed
        await model.confirmAction(proposal())
        let firstKey = store.lastIdempotencyKey
        XCTAssertEqual(store.performedActions, 1)

        // No automatic retry happened while we waited.
        XCTAssertEqual(store.performedActions, 1)

        store.nextOutcome = .completed
        await model.retryAction(proposalId: "m1:0")
        XCTAssertEqual(store.performedActions, 2)
        XCTAssertEqual(store.lastIdempotencyKey, firstKey)
    }

    func testAnAmbiguousOutcomeDoesNotResubmit() async {
        store.nextOutcome = .ambiguous
        await model.confirmAction(proposal())
        await model.retryAction(proposalId: "m1:0")
        XCTAssertEqual(store.performedActions, 1, "an unknown outcome was resubmitted")
        XCTAssertEqual(model.actionState(for: "m1:0"), .ambiguous)
    }

    func testCompletedPresentationRequiresASuccessfulResult() async {
        store.nextOutcome = .failed
        await model.confirmAction(proposal())
        XCTAssertNotEqual(model.actionState(for: "m1:0"), .completed)
    }

    func testActionsAreUnavailableWhileDisconnected() {
        store.connection = .unreachable(detail: "no route")
        let card = ActionCardView(proposal: proposal(), model: model)
        XCTAssertFalse(card.isEnabled)
        XCTAssertEqual(card.disabledReason, "Not connected to Cave")
    }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test 2>&1 | tail -20
```

- [ ] **Step 3: Implement the card and sheet**

Create `app/Sources/Actions/ActionCardView.swift`:

```swift
import SwiftUI

/// A proposed mutation.
///
/// Renders in one of two shapes and never both: an offer, or a result. The
/// result shape appears only for a journal entry in `.completed`, which only a
/// successful Cave response produces.
@MainActor
struct ActionCardView: View {
    let proposal: ActionProposalFfi
    @ObservedObject var model: ThreadModel
    @State private var confirming = false

    /// Whether the action can be attempted at all.
    var isEnabled: Bool { disabledReason == nil }

    /// Why not, when not.
    var disabledReason: String? {
        if !model.store.isConnected { return "Not connected to Cave" }
        if !model.store.hasScope(for: proposal.family) { return "This credential cannot do that" }
        if model.actionState(for: proposal.proposalId) == .submitting { return "Working" }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(proposal.summary, systemImage: symbolName)
                .font(.subheadline.weight(.medium))

            switch model.actionState(for: proposal.proposalId) {
            case .completed:
                Label("Done", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            case .rejected:
                resultRow("Not permitted", symbol: "hand.raised.fill")
            case .failed:
                VStack(alignment: .leading, spacing: 6) {
                    resultRow("Did not run", symbol: "exclamationmark.triangle.fill")
                    Button("Try again") { Task { await model.retryAction(proposalId: proposal.proposalId) } }
                        .font(.caption)
                        .disabled(!isEnabled)
                }
            case .ambiguous:
                // Never offer a retry here. The user is told what is unknown
                // and given the one safe next step.
                VStack(alignment: .leading, spacing: 6) {
                    resultRow("Outcome unknown", symbol: "questionmark.circle.fill")
                    Text("Cave did not confirm this. Check on Cave before trying again.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button("Check now") { Task { await model.reconcileAction(proposalId: proposal.proposalId) } }
                        .font(.caption)
                }
            case .submitting:
                ProgressView().controlSize(.small)
            case .confirmed, .none:
                HStack {
                    Button("Confirm") { confirming = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isEnabled)
                    if let reason = disabledReason {
                        Text(reason).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        .confirmationDialogSheet(isPresented: $confirming) {
            ConfirmationSheet(
                title: "Confirm this action",
                summary: proposal.summary,
                destructive: proposal.kind == "merge" || proposal.kind == "issue-state"
            ) {
                Task { await model.confirmAction(proposal) }
            } onCancel: {
                Task { await model.cancelAction(proposalId: proposal.proposalId) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Proposed action. \(proposal.summary)")
    }

    private func resultRow(_ text: String, symbol: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(.caption)
                if let detail = model.actionDetail(for: proposal.proposalId) {
                    Text(detail).font(.caption2).foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: symbol)
        }
    }

    private var symbolName: String {
        switch proposal.family {
        case "github": return "chevron.left.forwardslash.chevron.right"
        case "handoff": return "arrow.right.doc.on.clipboard"
        default: return "bell.badge"
        }
    }
}
```

`ConfirmationSheet` renders the summary verbatim, offers Cancel and a single confirm button, marks destructive actions with `.destructive` role, and returns focus to the card on dismissal.

- [ ] **Step 4: Implement the model side**

Add to `ThreadModel`:

```swift
    /// Confirm and perform one action.
    ///
    /// The journal mints the key; this method never generates one. Exactly one
    /// `perform` call happens per confirmation, and no branch here retries.
    func confirmAction(_ proposal: ActionProposalFfi) async {
        do {
            _ = try store.journal.confirm(
                proposalId: proposal.proposalId,
                payloadJson: proposal.payloadJson,
                summary: proposal.summary
            )
            let entry = try await store.performAction(proposalId: proposal.proposalId)
            actionStates[proposal.proposalId] = entry
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "That action could not be performed."
        }
    }

    /// The user backed out before confirming.
    func cancelAction(proposalId: String) async {
        try? store.journal.discard(proposalId: proposalId)
        actionStates[proposalId] = nil
    }

    /// Retry a failed action under its original key.
    func retryAction(proposalId: String) async {
        do {
            _ = try store.journal.retry(proposalId: proposalId)
            let entry = try await store.performAction(proposalId: proposalId)
            actionStates[proposalId] = entry
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "That action could not be retried."
        }
    }

    /// Resolve an ambiguous action against canonical state.
    ///
    /// Reloads the conversation and asks whether the action's effect is
    /// visible. Nothing is resubmitted here under any outcome.
    func reconcileAction(proposalId: String) async {
        await load()
        guard let entry = store.journal.entry(proposalId: proposalId) else { return }
        let landed = store.actionEffectVisible(entry: entry, in: detail)
        try? store.journal.reconcile(proposalId: proposalId, landed: landed)
        actionStates[proposalId] = store.journal.entry(proposalId: proposalId)
    }
```

`AttentionCardView` renders the reason, a text field for the answer, and a Send button that goes through the same journal path with an `attention` family payload.

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --strict
git add app/
git commit -S -m "Add action confirmation and result presentation

Rendering a proposal performs no call, one confirmation performs one
mutation, and an ambiguous outcome offers checking rather than retrying.
Completed appears only for a journal entry a successful response wrote."
```

---

## Task 14: Attachments in the Composer

Phase E wired `attachment_ids` through and always sent it empty. This fills it, and it has to cooperate with the outbox: a message queued while unreachable holds staged files that must still exist when the network returns.

**Files:** Create `app/Sources/Views/AttachmentTrayView.swift`; modify `app/Sources/Views/ComposerView.swift`, `app/Sources/Support/ThreadModel.swift`, `rust/ffi/src/outbox.rs`

- [ ] **Step 1: Write the failing tests**

Add to `rust/ffi/src/outbox.rs` tests:

```rust
    #[test]
    fn a_queued_entry_carries_its_staged_files() {
        let outbox = outbox();
        let entry = outbox
            .enqueue_with_attachments(
                "c1".into(),
                "f1".into(),
                "look".into(),
                "r1".into(),
                vec![StagedFileFfi {
                    id: "s1".into(),
                    name: "a.png".into(),
                    mime: "image/png".into(),
                    path: "/tmp/a.png".into(),
                    byte_count: 10,
                }],
            )
            .expect("enqueue");
        assert_eq!(entry.staged.len(), 1);
    }

    #[test]
    fn an_entry_whose_staged_file_vanished_fails_rather_than_sending_without_it() {
        // Sending the text alone would deliver a message that reads as though
        // the picture is attached when it is not.
        let outbox = outbox();
        let entry = outbox
            .enqueue_with_attachments(
                "c1".into(),
                "f1".into(),
                "look".into(),
                "r1".into(),
                vec![StagedFileFfi {
                    id: "s1".into(),
                    name: "a.png".into(),
                    mime: "image/png".into(),
                    path: "/definitely/missing.png".into(),
                    byte_count: 10,
                }],
            )
            .expect("enqueue");
        assert!(matches!(
            outbox.verify_staged(entry.id.clone()),
            Err(ChatError::Attachment { .. })
        ));
    }

    #[test]
    fn completing_an_entry_releases_its_staged_files() {
        let outbox = outbox();
        let path = std::env::temp_dir().join("release-me.png");
        std::fs::write(&path, b"x").expect("write");
        let entry = outbox
            .enqueue_with_attachments(
                "c1".into(),
                "f1".into(),
                "p".into(),
                "r1".into(),
                vec![StagedFileFfi {
                    id: "s1".into(),
                    name: "a.png".into(),
                    mime: "image/png".into(),
                    path: path.to_string_lossy().into_owned(),
                    byte_count: 1,
                }],
            )
            .expect("enqueue");
        outbox.complete(entry.id).expect("complete");
        assert!(!path.exists(), "a staged file outlived its message");
    }
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml outbox 2>&1 | tail -20
```

- [ ] **Step 3: Implement**

Extend `OutboxEntry` with `staged: Vec<StagedFileFfi>` and add:

- `enqueue_with_attachments`, keeping `enqueue` as the no-attachment case.
- `verify_staged`, called before submission, which checks every staged path exists at its recorded size and returns `ChatError::Attachment` otherwise. A message with a missing attachment fails visibly; it does not send its text alone.
- Cleanup of staged files in `complete` and `discard`.

Then extend the send path in `ThreadModel`:

```swift
    /// Queue a message with its attachments and try to send it.
    ///
    /// Uploading happens at submission time, not at composition time: a file
    /// staged while offline has nowhere to go, and uploading eagerly would
    /// mean an attachment id for a message that may never be sent.
    func send(_ text: String, attachments: [StagedAttachment]) async {
        guard let revision = detail?.conversation.revision,
              let familiarId = detail?.conversation.familiarId
        else { return }
        do {
            _ = try store.enqueue(
                conversationId: conversationId,
                familiarId: familiarId,
                prompt: text,
                revision: revision,
                staged: attachments.map(StagedFileFfi.init)
            )
            // Staged files now belong to the outbox entry. The composer's
            // stager releases them without deleting, because the entry may
            // outlive this view by days.
            try stager.release(attachments.map(\.id))
            refreshPending()
            await drainOutbox()
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "Could not queue that message."
        }
    }
```

In the drain path, upload the entry's staged files, then send with the returned ids. An upload failure marks the entry `Failed` with a reason naming the file; it never proceeds to send.

- [ ] **Step 4: Implement the tray**

Create `app/Sources/Views/AttachmentTrayView.swift`: a horizontal row of thumbnails above the composer, each with a name, size, remove button, and — during upload — a determinate progress bar and a cancel button. A rejected file shows why in words ("PNG, JPEG, WebP, GIF, PDF, text, and audio files only") rather than an error code.

Add to `ComposerView` a `PhotosPicker` and a `fileImporter`, both routing through `AttachmentStager.stage`, plus paste handling for images.

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
cargo test -p chat-ios-ffi --manifest-path rust/Cargo.toml
./scripts/build-xcframework.sh && xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add rust/ app/
git commit -S -m "Attach files to outgoing messages

Uploads happen at submission, so a file staged offline is not given an
id for a message that may never send. An entry whose staged file went
missing fails visibly instead of delivering text that claims a picture."
```

---

## Task 15: Conversation Management

Rename, pin, archive, delete. Small surface, one real decision: only deletion gets a confirmation, because a confirmation on every reversible operation trains people to dismiss the one that matters.

**Files:** Create `app/Sources/Views/ConversationMenu.swift`; modify `app/Sources/Views/ConversationListView.swift`, `ThreadView.swift`, `app/Sources/Support/CaveStore.swift`

- [ ] **Step 1: Write the failing tests**

Add to `app/Tests/CaveStoreTests.swift`:

```swift
    func testRenameSendsTheNewTitleAndRefreshes() async throws {
        store.nextOutcome = .completed
        try await store.renameConversation(id: "c1", title: "New name")
        XCTAssertEqual(store.lastMutation, "rename")
        XCTAssertTrue(store.didReloadConversations)
    }

    func testDeleteRequiresConfirmationInTheViewModel() {
        XCTAssertTrue(ConversationMenuModel(title: "T").requiresConfirmation(for: .delete))
        XCTAssertFalse(ConversationMenuModel(title: "T").requiresConfirmation(for: .archive))
    }

    func testAFailedMutationDoesNotChangeLocalState() async {
        store.nextOutcome = .failed
        store.conversations = [.stub(id: "c1", title: "Original")]
        try? await store.renameConversation(id: "c1", title: "New name")
        XCTAssertEqual(store.conversations.first?.title, "Original",
                       "local state moved ahead of Cave")
    }

    func testMutationsAreHiddenWithoutTheCapability() {
        store.capabilities = []
        XCTAssertFalse(ConversationMenuModel(title: "T", capabilities: store.capabilities)
            .showsArchive)
    }
```

- [ ] **Step 2: Verify the tests fail, then implement**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test 2>&1 | tail -20
```

Implement:

- `CaveStore.renameConversation`, `setPinned`, `setArchived`, `deleteConversation`, each going through `cave_core::actions::ConversationMutation` with a fresh idempotency key, and each **reloading canonical state on success rather than mutating the local list**. A local edit that outpaces Cave is how two clients start disagreeing about a title.
- `ConversationMenu` — a `Menu` in the thread header and a swipe action set in the list. Delete is `.destructive` and confirms with the conversation's title in the sentence.
- Capability gating: hide what this Cave does not advertise instead of showing a control that will fail.

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --strict
git add app/
git commit -S -m "Add conversation rename, pin, archive, and delete

Only deletion confirms. Success reloads canonical state rather than
editing the local list, so the phone never shows a title Cave does not
have."
```

---

## Task 16: Phase Gate

- [ ] **Step 1: Add the WebKit gate to CI**

Add to `.github/workflows/ci.yml`, beside D1's GPL check:

```yaml
      - name: No web view may render message content
        run: |
          set -euo pipefail
          if grep -rn --include='*.swift' -E 'import WebKit|WKWebView|WKUserContentController' app/Sources; then
            echo "A web view reached the app. Message content must never render in one."
            exit 1
          fi
          if grep -rn --include='*.swift' -E 'AttributedString\(markdown:|NSAttributedString\(html' app/Sources; then
            echo "HTML-capable attributed string parsing is not permitted for message content."
            exit 1
          fi

      - name: No eager remote image loading
        run: |
          set -euo pipefail
          if grep -rn --include='*.swift' -E 'AsyncImage\(' app/Sources; then
            echo "AsyncImage cannot carry a bearer and loads without a gesture. Use MediaLoader."
            exit 1
          fi
```

- [ ] **Step 2: Full clean build and test**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
rm -rf build app/Sources/Generated rust/target
./scripts/build-xcframework.sh && xcodegen generate && swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Expected: `TEST SUCCEEDED`.

- [ ] **Step 3: Confirm no path completes an action without a successful response**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
grep -n "mark_completed\|ActionState::Completed" ffi/src/journal.rs ffi/src/session.rs
```

Read every match. `mark_completed` must be reachable only from a `Completed` outcome or from `reconcile(landed: true)`. If any other caller exists, it can show a person that something happened when it did not.

- [ ] **Step 4: Confirm no path resubmits an ambiguous action or message**

```bash
grep -n "Ambiguous" ffi/src/journal.rs ffi/src/outbox.rs ffi/src/session.rs
```

Confirm the only transition out of `Ambiguous` is `reconcile`, in both the journal and the outbox.

- [ ] **Step 5: Confirm the parser is total**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test -p cave-core --test markup_vectors
grep -rn "unwrap()\|expect(" crates/cave-core/src/markup/*.rs | grep -v "#\[cfg(test)\]" | grep -v "^.*tests"
```

Expected: the vector test passes, and the grep returns nothing outside tests. A panic in a parser fed by model output is a crash a familiar can trigger.

- [ ] **Step 6: Confirm the SDK and Pocket still pass**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/ios-phase-f-sdk
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi
```

Expected: PASS. Task 7 changed `coven-transport`, which Pocket consumes.

- [ ] **Step 7: Hostile content pass against a live Cave**

Requires Cave Phase 4. Ask a familiar to emit, or paste into a conversation through Cave's own UI, each of the following, and record the observed result:

1. A well-formed marker of every family.
2. A malformed marker of every family.
3. `<coven:image src="javascript:alert(1)" />` and a `data:image/svg+xml` source.
4. A marker inside a code fence, and one inside inline code.
5. A `spec` document containing a triple-backtick code block.
6. A footnote citation to a real page, and one to a repo path.
7. A turn ending mid-marker, watched as it streams.
8. A 12 MB photo, a zip renamed `.pdf`, and an SVG renamed `.png`.
9. A HEIC photo taken with location on — then check Cave's stored copy for GPS.
10. A `github-action` proposal for merge, watched to confirm nothing happens until tapped.

Item 9 is the one to check personally rather than trust. If the stored file has coordinates, stop and fix before proceeding.

- [ ] **Step 8: Action journey against a live Cave**

1. Confirm a comment action; verify it appears on GitHub exactly once.
2. Confirm a merge action, then background the app mid-request; foreground and confirm the card shows one outcome, not two attempts.
3. Enable airplane mode, confirm an action; verify it fails rather than reporting done.
4. Force-quit during an action, relaunch; verify the card is not `completed` unless Cave shows the effect.
5. Answer an attention prompt; verify the response lands as a canonical turn.
6. Create a task handoff from a handoff document; verify the task exists in Cave.
7. Rename, pin, archive, and delete a conversation; verify each in Cave's own UI.

- [ ] **Step 9: Verify signatures**

```bash
for repo in chat-ios sdk; do
  cd "/Users/buns/Documents/GitHub/OpenCoven/$repo"
  echo "== $repo"
  git log --pretty='%H %G?' -40 | awk '$2 != "G" {print "UNSIGNED:", $0}'
done
```

Expected: no output.

---

## Phase F Completion

Phase F is done when:

- Every marker family Cave emits renders as a native card, and the vector file passes in `cave-core`.
- A marker inside a code fence stays literal, and a half-arrived marker never flashes in a streaming turn.
- An unknown or malformed marker renders as a dull, non-interactive card that says so.
- No message content passes through a web view, and CI fails if one appears.
- A remote image named by a familiar does not load until the user taps it, and then without credentials.
- A Cave attachment renders from an authenticated download to a private file, with no bearer in any URL.
- Attachments are typed by sniffed content, transcoded from HEIC, stripped of location, and streamed from disk.
- A staged file that vanished fails its message rather than sending text that claims an attachment.
- Rendering a proposal performs no network call.
- One confirmation performs exactly one mutation, under a key minted by the journal.
- A retry after a failure reuses that key; a fresh confirmation mints a new one.
- An ambiguous outcome is never resubmitted, and offers reconciliation instead.
- An action shows as completed only from a successful Cave response or a reconciliation that found its effect.
- Rename, pin, archive, and delete work, confirm only where deletion is involved, and reload canonical state.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** push notifications, the doorbell relay, background refresh, the device matrix, and the full accessibility audit.

## Handoff to Phase G

Phase G builds the doorbell relay service, emits doorbells from Cave, delivers them to the device, adds background refresh, and runs the accessibility and security reviews. The relay's hosting platform is an open decision to be made at the start of that phase.

Three things Phase F leaves for it:

- `MediaCache.evict_to_budget` runs after each download. Nothing runs it on a schedule, and nothing runs it in the background. Phase G's background refresh is the natural place.
- `ActionJournal.ambiguous()` exists and is unused. Phase G should reconcile ambiguous entries on foreground, the same way Phase E's outbox reconciles on conversation load.
- Accessibility work in Phase F is per-view: labels, Dynamic Type, and colour-independent status. A full audit across the app — VoiceOver order, focus return, reduce-motion, and contrast — is Phase G's.
