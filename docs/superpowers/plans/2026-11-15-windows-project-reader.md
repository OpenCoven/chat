# Windows Project Metadata Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver #587 through a secure Windows reader, exact-candidate native verification and protected integration.

**Architecture:** Keep registry/grant interpretation and the Unix reader unchanged. Isolate Windows handle-relative traversal in a private sibling module and exercise real Windows filesystem APIs through the existing metadata entry points.

**Tech Stack:** Rust 1.95.0, existing windows-sys 0.61.2, Windows ntdll/Win32, existing native acceptance driver, Node 24.18.1 and pnpm 10.34.0.

**Spec:** [Windows reader specification](../specs/2026-11-15-windows-project-reader.md).

## Global Constraints

Preserve MAX_METADATA_BYTES = 8 * 1024 * 1024 and MAX_PROJECTS = 1024. Preserve Unix behavior, missing-only fallback, metadata-only authority, full-access/asking-off behavior, #575's hold, existing ownership and governed authority pins. No releases or tags. Every commit is signed and verified; PR uses ci:full and normal protection.

## Review Focus

- Drive-relative, device, stream and extended path spellings must not bypass component traversal.
- An existing writer or concurrent parent replacement must yield original-object access or visible refusal, never redirected data.
- A denied current store must not silently load a permissive legacy store.
- Settings refresh must clear both stale projects and stale error text after repair.
- Context suggestions must use the selected familiar's grants without changing execution policy.

### Task 1: Windows regression route and reader

**Files:** `src-tauri/src/familiar_projects.rs`, new `src-tauri/src/familiar_projects_windows.rs`, new `src-tauri/src/familiar_projects_windows_tests.rs`, new `.github/workflows/windows-project-metadata.yml`.

**Interfaces:** Preserve `open_metadata(path: &Path) -> io::Result<File>`. The Windows module exposes only private `open(path: &Path) -> io::Result<File>` and internally opens one child relative to `&File`; tests consume the existing `read_store` and `ProjectAccess::from_sources` entry points.

- [ ] Add Windows tests loading eight actual granted projects; absent/legacy behavior; malformed and oversized stores; access denial; intermediate/final reparse points; nonregular files; path spellings and replacement races. Watch the valid eight-project test fail on real Windows with Unsupported before implementation.
- [ ] Add a focused pinned-action Windows workflow running `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib familiar_projects -- --test-threads=1`; retain raw output. Preserve the governed CI workflow and Cargo manifests.
- [ ] Implement the private Windows reader, validate all handles/components, retain ancestors and map NT errors. Expand the regression tests to deterministic retained-parent and final-file mutation attempts.
- [ ] Require all Windows metadata tests and unchanged Unix metadata tests to pass, run Rust formatting and clippy, then sign and verify the implementation commit.

### Task 2: Native access and context acceptance

**Files:** `scripts/native-acceptance/access-row.mjs`, related `src/native-*` tests, `README.md`.

**Interfaces:** Existing access row entry point and platform driver, real Cave metadata fixtures for the selected familiar; no new native commands or execution policy.

- [ ] Replace Windows' expected Unsupported branch with assertions for eight projects and keyboard-reachable project list. Add error/recovery and # suggestion observations using the real native UI; retain before/failure/recovery screenshots and metadata hashes.
- [ ] Run affected collector tests failing-first, update the collector, and verify those tests pass. Update README to describe Windows reads and visible unsafe-store failures.
- [ ] Run complete applicable repository/Rust checks and exact-head native Windows candidate acceptance; retain installer and executable identities plus all attempts under `.artifacts/587/`.
- [ ] Obtain one fresh whole-branch review, resolve material findings with regression proof, and deliver a signed focused PR with ci:full. Merge only after native acceptance and protection pass; close #587 against a criterion ledger, or retain an explicit external-gate handoff.
