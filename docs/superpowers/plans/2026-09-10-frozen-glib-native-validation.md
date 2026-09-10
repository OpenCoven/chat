# Frozen GLib Native Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the narrow frozen-production GLib backport on native Linux x64 before publishing or adopting its source revision.

**Architecture:** A read-only CI job reconstructs the candidate from frozen production `841a88f8885bc20cac2f9d5b5b6bc2a23a76e657` and reviewed maintenance `7ca56c5c8c95fc1be4efecf22554cb4f3cc08e22`. It applies only the Cargo delta from harness `c5445941750f5ac232a78f3d7c7dcecf91bd52bc` plus the reviewed vendor files. Existing production authorities and protected workflows remain unchanged.

**Tech Stack:** GitHub Actions, pinned CI image, Node 24.18.1, pnpm 10.34.0, Rust 1.95.0.

## Task 1: Reconstruct and verify the candidate

- [x] Add `.github/workflows/frozen-glib-validation.yml`, triggered by pull requests changing this workflow or its reconstruction helper.
- [x] Use pinned checkout actions with credentials persistence disabled, exact source revisions, and read-only contents/package permissions.
- [x] Add a bounded reconstruction helper in `scripts/` that verifies both checkout identities, applies only the two Cargo changes, copies the exact 121 vendor files and provenance/test lock, and rejects unexpected source changes.
- [x] Exercise the helper against temporary checkouts, including wrong revision, changed vendor input, and unexpected source-delta rejection cases.

## Task 2: Obtain native evidence

- [ ] Use the existing CI image digest `sha256:d477f7c7d7b1893426459b3835c12d5aff1300c6c6299ec8c5e00779c9fcf779` on Ubuntu x64, with the existing 60-minute upper bound.
- [ ] Verify the published crate checksum and exact two-line fix; require pristine optimized SIGSEGV and all 11 patched iterator tests to pass.
- [ ] Verify the candidate graph resolves exactly one local GLib 0.18.5 while sys/macro siblings retain registry sources.
- [ ] Run the frozen candidate's production desktop build and unchanged complete native regression command: `cargo test --manifest-path src-tauri/Cargo.toml --locked --release --features phase1-conformance --lib --test coven_health_process_boundary --test phase1_native_rpc`.
- [ ] Preserve source identity/delta receipts and terminal CI evidence. Do not filter out the HOME-mutation test or modify its expectation.

## Task 3: Review and follow through

- [ ] Verify workflow syntax, helper behavior, permissions, unchanged governed files, and diff whitespace before a signed commit and draft PR.
- [ ] Complete native CI and independent review before claiming candidate validation.
- [ ] Record results in #188. Source publication, canonical reachability, both frozen bindings, SDK validator rebinding, and protected validation remain subsequent work; this workflow does not grant release acceptance.

## Existing evidence and limits

Local Linux x64 emulation passed provenance, the optimized iterator regression, the desktop build, and 127 native tests. The remaining RPC test detected `.cache/rosetta` in its empty HOME. An independent `/bin/true` control reproduced that mutation. Native x64 CI must supply the missing proof; a local passing subset is insufficient.
