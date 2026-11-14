# Coven Chat desktop refinement

Implemented in an isolated worktree from `ac09aadeef889c0e759693c1c7351a01e6e56a4f`. The source checkout's merge conflicts and installed application were preserved.

The desktop product, native window, About identity, browser title, installer outputs, and release validation now use Coven Chat. The application identifier remains `ai.opencoven.chat`. The crown path is unchanged; the rounded desktop icon has a quieter outlined bubble and regenerated native exports.

Buttons now use flatter surfaces and consistent line icons, clearer primary action contrast, larger icon targets, and 44 px minimum targets on coarse pointers. Settings and composer surfaces have less visual noise. Familiar search has a clear action, live result count, and explicit focus restoration. Settings also restores its pointer opener in WebKit. Long familiar descriptions occupy a three-line preview in empty chats while the complete description remains in the inspector and tooltip.

The release name resolver accepts exactly one checksum-listed installer under either product name. MSI pins the original UpgradeCode; the pinned NSIS template preserves legacy registry discovery and recognizes both MSI names; Debian declares replacement, conflict, and provide metadata for `opencoven-chat`. The independent review identified these three migration concerns, and mutation tests now reject missing migration declarations.

## Verification

| Check | Observed result |
| --- | --- |
| Browser e2e | 159 passed, 3 WebKit skips, no retries |
| New refinement scenarios | All 16 passed across Chromium/WebKit and light/dark appearances |
| Rust library tests | 353 passed, 0 failed, 9 ignored |
| Affected frontend checks | 320 passed; later migration/package/specification checks passed 138 tests |
| Complete normal frontend suite | 1521 passed, 21 failed, 80 skipped; all failures require unavailable `pwsh` in `client-v1-conformance-workflow.test.ts` |
| Heavy frontend suite | 915 passed, 6 failed, 36 skipped; failures listed below |
| TypeScript, lint, formatting, package validation | Passed; lint retains one specificity warning and four informational notices |
| Native macOS app | Built as Coven Chat 0.1.1 with identifier `ai.opencoven.chat` |
| Rendered review | Inspected wide, compact, and Settings captures, including both appearances |

The three WebKit skips preserve existing Chromium coverage: Playwright WebKit cannot grant clipboard-read/write permissions for two real clipboard checks, and its Range geometry does not reflect the RTL overflow shift used by the workspace-tail measurement. The remaining keyboard checks use Safari's Option+Tab traversal rather than assuming Chromium's Tab model. No clipboard behavior is simulated to turn these checks green.

Heavy-suite failures are `phase1-conformance-lock.test.ts` → `SIGKILLs and reaps a hung Git child that ignores SIGTERM`, plus `phase1-conformance.test.ts` → `observes the exact Node, pnpm, and Rust release toolchain` and the four `schema-v1`/`schema-v2 preserves resolved Cargo ahead of the supervisor PATH`/`empty PATH` cases. The full suite is not reported as green.

Local screenshots and full logs are retained under `.artifacts/coven-chat-polish/`. The macOS candidate is staged there separately from the installed app. Save any drafts and quit the running app before opening the candidate.

Actual Windows/Linux upgrade execution, native assistive-technology acceptance, and live-provider messaging were not performed. The migration declarations require the existing platform acceptance lanes before release; browser fixtures and a macOS build do not establish those results. No release was published or installed application replaced.

Changes are staged on `feat/coven-chat-polish`. A signed commit was attempted and refused because neither `user.signingkey` nor `gpg.ssh.defaultKeyCommand` is configured; no unsigned commit was made. The retained patch and source-tree receipt identify the complete candidate.
