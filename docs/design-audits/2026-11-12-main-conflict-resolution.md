# Main conflict resolution and Coven Chat integration

Resolved the five unmerged paths in the main working directory: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, and `src/coven/settings-dialog.tsx`. The four manifests already matched the current main side in their working copies; their unmerged index entries were resolved without reverting the 0.1.1 version or dependency updates. The Settings resolution retains current full-access wording and adds the specific project-grant editing instructions while preserving the incoming model picker and project-access refresh.

Applied all 54 staged Coven Chat refinement files from the isolated candidate using three-way merges against the shared `ac09aadeef889c0e759693c1c7351a01e6e56a4f` base. No further content conflicts occurred. The original messaging recovery, runtime, chat controller, controller tests, and v0.0.10 release note were verified byte-for-byte against the pre-resolution snapshot. Search, icon, button, branding, installer-identity, and e2e changes are now staged directly on local `main`.

The pre-resolution working files, exact index, conflict stages, staged patches, integration plan, and test logs are retained in `.artifacts/main-conflict-recovery-20261112/`. No stash was dropped, branch reset, commit created, remote updated, or installed application replaced. Local main remains at its original commit; the existing three documentation commits on origin/main were not pulled into this staged working tree.

## Verification on the integrated main working tree

- Zero unmerged index entries and no remaining conflict markers in the original conflicted files.
- TypeScript check passed.
- Focused frontend suite: 325 passed across seven files, including messaging recovery, Settings, chat layout, runtime bridge, window titles, release smoke, package validation, and brand assets.
- Rust library suite: 354 passed, zero failed, nine ignored.
- Complete browser e2e suite: 159 passed, three WebKit capability skips; the skipped real clipboard and RTL geometry checks remain covered in Chromium.
- Lint passed with the existing specificity warning and four informational notices.
- Cargo formatting, package validation, and staged whitespace checks passed.

The broader normal/heavy conformance unit suites were not rerun for this conflict integration. Their earlier environment failures remain documented in the preceding refinement audit; these results do not claim hosted CI, native installed-app acceptance, or Windows/Linux upgrade execution.
