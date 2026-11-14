# Coven Chat refinement implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Deliver Coven Chat desktop branding, a restrained control system, practical UX improvements, and executed end-to-end coverage.

**Architecture:** Refine existing React primitives and CSS roles rather than introducing another component system. Preserve native identity and application behavior while updating product display names and release consumers together.

**Tech Stack:** React, TypeScript, CSS, Tauri, Rust, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-coven-chat-polish-design.md`.

## Global constraints

- Preserve `ai.opencoven.chat`, conversation storage, permission controls, and Stop.
- Preserve the crown path, outlined bubble, light/dark appearance, focus visibility, and reduced motion.
- Do not modify the conflicted source checkout or historical release records and frozen external fixtures.
- Run locally; distinguish browser fixture checks, native compilation, and installed-app acceptance.
- Keep published prose paragraphs on one logical source line.

## Review focus

- Rename must reach native packaging and updater/install consumers without breaking prior release handling.
- A populated search must clear without losing input focus or switching the selected conversation.
- Compact layouts must retain reachable primary controls with long familiar names and larger text.
- Light and dark button foregrounds must remain legible in default, hover, disabled, and focus states.
- Sending must still transition to Stop and preserve draft and run ownership when navigating.

### Task 1: Desktop branding and identity

**Files:** `src/lib/window-title.ts`, `src/lib/app-metadata.ts`, `src-tauri/tauri.conf.json`, `scripts/release-smoke.*`, current release/acceptance consumers, and associated existing tests.

**Interfaces:** `windowTitle(name, finished)` returns titles using Coven Chat; native `productName` and release `PRODUCT_NAME` agree; application identifier remains unchanged.

- [ ] Change existing window-title and installer-output tests to expect Coven Chat; run and observe expected name mismatches.
- [ ] Update active product strings and packaging consumers while preserving immutable fixtures and historical documentation.
- [ ] Run window-title, release-smoke, metadata, and affected UI tests, plus typechecking.
- [ ] Record the reviewed changes and verification; sign any commit created.

### Task 2: Controls, icons, and familiar search

**Files:** `src/design/minimal-icons.tsx`, `src/design/familiars-shell.css`, `src/ui/ui.css`, `src/coven/chat-layout.tsx`, `src/coven/chat-app.css`, `src/coven/settings-dialog.css`, desktop brand SVG and raster exports.

**Interfaces:** Existing icon and button APIs stay stable; familiar search gains a Clear familiar search action and a live result count.

- [ ] Add a real ChatLayout test that searches for a familiar, clears the filter, retains selection, and returns focus to search; observe failure before implementation.
- [ ] Add the clear action and result feedback. Refine key line glyphs, desktop icon outline, flat button hierarchy, composer focus, Settings surfaces, and coarse-pointer hit targets.
- [ ] Run affected component and brand-export tests, typechecking, lint, and build; inspect rendered screenshots in both schemes and compact/wide layouts.
- [ ] Record the reviewed changes and verification; sign any commit created.

### Task 3: End-to-end coverage and delivery

**Files:** Shared browser runtime fixture, `e2e/coven-chat-polish.spec.ts`, Playwright configuration, and a verification note.

**Interfaces:** The fixture remains an explicit IPC test boundary; application production code never gains a demo mode or fabricated runtime.

- [ ] Exercise real rendered branding, search clear/focus, sending/Stop, Settings keyboard exit, and compact layouts in Chromium and WebKit with light/dark schemes.
- [ ] Run the normal frontend suite, heavy suite, focused/native Rust checks as appropriate, and production/native app builds; retain logs and report failures by suite.
- [ ] Obtain one independent final code review, address important findings, and rerun affected checks.
- [ ] Provide the native candidate, screenshots, e2e results, and exact remaining limitations without replacing an active installed app.
