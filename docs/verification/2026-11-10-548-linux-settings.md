# #548 Linux Settings accessibility verification

The published v0.0.9 Linux `.deb` satisfies #548's automated native acceptance: the Inspector width label, complete instruction hint, current value, Reset relationship and Orca-generated utterances are verified at 400px, 600px and after Reset to 360px. No product defect remained in this row, so no app change or fixed release is needed. PR [#572](https://github.com/OpenCoven/chat/pull/572) delivers stronger acceptance checks and this record; #548 remains open pending authorized review and disposition.

## Exact native evidence

[Native run 42801851275](https://github.com/OpenCoven/chat/actions/runs/42801851275), attempt 1, succeeded on harness commit `2ba71225bff31d2afc66a0bcd82e2581c41669ef` with `release=v0.0.9`. Each lane installed the published bytes, rather than a candidate build. Linux job [129781093590](https://github.com/OpenCoven/chat/actions/runs/42801851275/job/129781093590), artifact `13757073850`, passed all twelve rows, including all twenty-seven explicit Settings assertions in row 504-6. macOS arm64 job `129781093531`, macOS x64 job `129781093976` and Windows MSI job `129781093632` also succeeded. These are native OS-level automation results, not hand-run results.

| Identity | Observed value |
| --- | --- |
| Published app | v0.0.9, source tag resolving to `109f764` |
| Installer | `OpenCoven.Chat_0.0.9_amd64.deb` |
| Installer SHA-256 | `48f592f60c5c191845b79c0e774f059cc0564269045552388b111d06901b9d2c` |
| `SHA256SUMS` SHA-256 | `402fef0316cbda5ffa9efea9d59887ddff2e8f0684cde27476c2d958279ac336` |
| Verification and installation | Manifest check `OK`; installed `/usr/bin/opencoven-chat` |
| OS | Ubuntu 24.04.5 LTS, kernel `7.0.0-1017-azure`, x86_64 |
| WebKitGTK | `2.52.6-0ubuntu0.24.04.1` |
| Orca | `46.1` |
| Harness Node | `v24.18.1` |
| Profile | Fresh runner user; both `/home/runner/.local/share/ai.opencoven.chat` and `/home/runner/.config/ai.opencoven.chat` absent before launch; first-run setup observed |

The artifact's environment log independently records absent prior app data and a successful checksum check. Its facts and result files agree with the installer and manifest identities above. All three Settings screenshots were inspected: the label and entire hint are visible, the value changes correctly, and Reset is visibly disabled only at 360px. The helper required no restart.

| Settings state | AT-SPI label, complete hint and value | Reset described-by target | Reset enabled | Orca label, complete hint and value |
| --- | --- | --- | --- | --- |
| 400px after the pointer-capture drag | All observed | Paragraph `_r_1v_`, `400px` | Yes | All observed |
| 360px after Reset | All observed | Paragraph `_r_1v_`, `360px` | No | All observed |
| 600px after narrowing, widening and reopening the inspector | All observed | Paragraph `_r_23_`, `600px` | Yes | All observed |

The native IDs are observations from this particular app instance, not future constants. Six AT-SPI/Reset assertions and three speech assertions pass at each width. The existing default, arrow/Home/End, pointer capture outside the window, release, selection isolation, 1000px composer containment and stored-width recovery checks also pass.

## What the harness now proves

The old check asserted only a width and retained the first 200 characters of dialog text, saving a full tree only on failure. The new check retains the complete Settings tree, a scoped native Inspector selection, screenshots and utterances on success and failure. WebKitGTK flattens the visual card containers into General; the selection therefore runs from the Inspector heading to the next peer heading, excluding unrelated General text. Reset must point through its native described-by relation to the actual current width node and have the correct enabled state.

Orca is started around each reading check. A real Tab moves its focus from the outer GTK frame into the web dialog before [desktop flat review](https://help.gnome.org/orca/commands_flat_review.html) begins: Insert+KP7 goes to the first spatial line, and KP9 (`KP_Page_Up`) reads subsequent lines. Native focus is retained as a separate observation. No page script or DOM inspection is used.

The utterance parser preserves dictionary- and list-shaped voice metadata and literal multiline speech records, accepting only indented continuations and rejecting unterminated records without consuming later timestamped events. In this layout, Orca reads the first hint line alongside the adjacent width and Reset name, then reads the second hint line. Every instruction word must occur in order; adjacent controls may occur between wrapped lines, but no instruction word may be absent. The current width and label are checked independently. Generated strings are neither replaced nor synthesized by the harness.

## First failures and corrected runs

The original v0.0.8 failure and earlier incomplete v0.0.9 evidence remain in [#548](https://github.com/OpenCoven/chat/issues/548), including its [latest pre-task comment](https://github.com/OpenCoven/chat/issues/548#issuecomment-6734286108). A later-version result is not applied retroactively to v0.0.8, and new checks do not rewrite the earlier v0.0.9 run's limited observations.

| Run / harness | Original result and retained evidence |
| --- | --- |
| [42795280967](https://github.com/OpenCoven/chat/actions/runs/42795280967), `f1d4e04` | Linux job `129758791308`, artifact `13755261032`: all eighteen new AT-SPI/Reset checks passed; nine speech checks failed because ordinary Down was unbound in Orca's WebKitGTK dialog script and elicited only `Settings dialog.`. All other Linux rows passed. |
| [42797545433](https://github.com/OpenCoven/chat/actions/runs/42797545433), `93028ae` | Cancelled after the retained enabled-binding log exposed a keypad keysym mistake: keypad 9 is `KP_Page_Up`, not `KP_Next`. No acceptance credited. |
| [42797738637](https://github.com/OpenCoven/chat/actions/runs/42797738637), `96d78cf` | Linux job `129767124843`, artifact `13754653481`: commands were accepted but flat review's context was the outer GTK frame, with no dialog and only the title. The existing parser also discarded list-shaped voice metadata. Eighteen AT-SPI checks and all other Linux rows passed; nine speech checks failed. All three other platforms passed. |
| [42799289707](https://github.com/OpenCoven/chat/actions/runs/42799289707), `752b48c` | Linux job `129772379875`, artifact `13757380168`: dialog focus and flat review worked. Label checks passed; hint/width checks failed because their spatial utterance contained literal newlines and the parser split records at line boundaries. The raw log contains the full hint, width and Reset name. All other Linux rows and all three other platforms passed. |
| [42801851275](https://github.com/OpenCoven/chat/actions/runs/42801851275), `2ba7122` | Fresh execution with the corrected multiline parser: all twenty-seven Settings assertions and all native rows passed on all four platforms. Linux artifact `13757073850`. |

Corrected parsing of the three retained `752b48c` raw speech logs passes all nine speech assertions. That reanalysis is retained explicitly as post-processing evidence; the originally failed run remains failed. Final run `42801851275` independently executes the corrected assertions, so acceptance does not depend solely on reanalysis.

The first run's Windows job `129758791037`, artifact `13755155570`, passed the changed Inspector row and row 567 but failed unchanged 504-1's browser-process comparison and 515's later review observation (`not-observed` until timeout). The first comparison began with two Firefox processes that were absent later; the cause of the later review absence is not established. Its traces and full log are preserved. Later Windows passes do not diagnose or erase those original failures.

## Validation and delivery

Thirty-two focused tests pass across Settings, native review observation and completion-fixture coverage. The Settings integration regression fails when the explicit complete-row checks are removed, reproducing the former width-only acceptance gap. Negative cases reject missing labels, truncated hints, incorrect width or relationship targets, wrong Reset state, unrelated text outside the Inspector range, unavailable trees, incomplete speech and truncated speech records. Tests cover the exact native list metadata and multiline utterance shape, including the apostrophe and adjacent width/Reset text.

Typecheck, production web build, changed-file Biome and Python syntax compilation passed. Full lint retains the existing one warning and four informational diagnostics. Hosted Web checks on `2ba7122` in [CI 42801731628](https://github.com/OpenCoven/chat/actions/runs/42801731628) passed all 85 normal files (1,536 tests, 61 existing skips), heavy suites (921 tests, 36 skips), typecheck and lint. The CI run completed successfully, including browser E2E, contract canary, Linux supervisor, desktop build, AppImage construction and packaged Linux deb/AppImage acceptance. Unchanged Rust, Windows supervisor and protected conformance jobs followed the existing classifier and were skipped; actual published native acceptance ran independently on all four platforms. Exact-head CI for the final documentation-only update is visible on PR #572; it does not change the tested implementation.

The first full local normal suite had 1,492 passes, 80 skips and 21 failures in unchanged `src/client-v1-conformance-workflow.test.ts`, requiring absent `pwsh`. The separately run heavy suite had 916 passes, 36 skips and five unchanged conformance failures: Node 24.22.0 differs from required 24.18.1, and four cases require absent `rustup`. Initial new-fixture normalization and strict optional-property type errors were corrected before final validation; their first logs remain retained. Local full suites are not described as green. Reproducing them locally requires the pinned Node/Rust toolchains and PowerShell on PATH; no assertion, timeout or protected lock was relaxed.

The base was current main `af52a3fc6c60ad2d4858398133eaf64f6fd35105`. Work is isolated in `.worktrees/548-linux-settings-verification`, branch `test/548-linux-settings-verification`; existing owners and PRs #543/#476 were preserved. Root and create/remove write probes passed before edits. All six implementation commits have Good SSH signatures verified before push. The final documentation update changes no tested harness or product bytes. PR #572 is open and non-draft. No merge, release or issue closure is authorized or performed.

## Receipts and limits

Durable local receipts are in `.worktrees/548-linux-settings-verification/.artifacts/548/`: the requirement checkpoint, release metadata, original Linux artifacts for all failed runs, the first Windows artifact, full first-failure job logs, local red/green and full-suite logs, hosted Web logs, signature verification records, `752b48c-raw-speech-reanalysis.json`, and the final downloaded Linux artifact with its SHA-256 index and `final-native-audit.json`.

The final Linux artifact retains `settings-tree-{400,360,600}.json`, `settings-inspector-{400,360,600}.json`, `settings-orca-{400,360,600}.json`, screenshots `09-settings-width-400.png`, `10-settings-width-360.png` and `11-settings-width-600.png`, and original Orca session logs 3, 4 and 5. Environment, facts and result files retain the installer, isolated-profile and version evidence. The full final Linux job log is retained alongside the artifact.

AT-SPI exposure, Orca-generated debug utterances and inspected screenshots are separate observations. Orca uses the existing runner configuration with no speech server or audio device, so this is not recorded audio or human listening acceptance. The model endpoint is the disclosed deterministic local fixture; Settings is the real installed app. No #520 installer hand-run row or broader #504/#515 human acceptance is credited. #548's automated native criterion is satisfied on the already published v0.0.9 build; human review remains distinct.
