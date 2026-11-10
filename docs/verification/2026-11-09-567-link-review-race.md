# #567 link review completion verification

PR [#570](https://github.com/OpenCoven/chat/pull/570) merged as `f4fedf363c49c7616ec62070369399b076008f88`, with GitHub signature verification valid. Its complete tree `931c387960e14d9bd5de9e8882c69f1f15e7181b` equals the reviewed and natively tested head `31358c6f732f6b77dfe1c972a11bd45c78f5e5f9`. All three authored commits were signed and their Good SSH signatures verified before push. Native candidate evidence below is OS-level automation on fresh runner profiles, not published-build or human acceptance. No release was published.

## Cause and supported behavior

The original native helper returned at the first visible live link, before the run and transcript reload finished. Browser regressions reproduced both mechanisms: locating a live target that persisted transcript metadata later replaces, and observing an open review before completion changes its scope. The first failure's own artifacts cannot establish which mechanism occurred on that attempt; that uncertainty remains explicit.

Ordinary native sends now wait for no Stop run control and an enabled composer after reload, then resolve the settled link afresh. The previous arbitrary 500 ms post-idle delay is removed. Explicit streaming mode exists for the dedicated boundary scenario. No product source, reviewed-address policy, URL opener, resource/security assertion or release workflow changed.

README's existing policy closes a review when its conversation changes or source message disappears. That policy remains intact. An already reviewed address stays immutable while other text streams; a later target never replaces it under the reader. The settled link can be reviewed again. Surviving a conversation/source invalidation would be a separate product decision and is not introduced by this repair.

## Deterministic completion coverage

Native row 567 holds a synthetic model stream until an open review is observed, confirms the real run is active, releases exactly one stream, observes `opened-then-dismissed`, verifies no browser started, then reviews the settled link and checks Escape focus return. Cleanup releases any held fixture stream even on failure. Bounded diagnostics distinguish `not-observed`, `open` and `opened-then-dismissed`; absence is not asserted to prove a missed click, and unavailable or empty accessibility trees fail observation rather than counting as dismissal.

Completion invalidation now asserts Messages focus. All four final native artifacts directly report Messages, and every direct focus assertion passed. The Windows document-reporting fallback was unit-tested, but was not exercised by this final native run: if UIA exposes only document focus, it requires native Tab/Shift+Tab/Tab positioning at the transcript's unique Connection details control. That fallback proves native keyboard position, not an exact noninteractive DOM-focus label. Browser tests retain their exact Messages-focus assertion.

## Final native candidate evidence

[Native acceptance run 42738581141](https://github.com/OpenCoven/chat/actions/runs/42738581141), attempt 1, completed successfully on exact head `31358c6`. Each lane built its own candidate installer, installed it on a fresh profile and drove the app with CGEvent, SendInput or XTEST, reading the native accessibility tree and real browser. The only model was the disclosed local deterministic fixture.

| Lane | Successful job | OS and browser | Installer SHA-256 | Artifact |
| --- | --- | --- | --- | --- |
| `native-macos-aarch64` | [129573771131](https://github.com/OpenCoven/chat/actions/runs/42738581141/job/129573771131) | 15.8.2 (24H232) arm64; safari | `03a80cb0b6c126808d0b2f37bf96fef635041765552a543a11c6ce378cb3bbce` | `13728333797` |
| `native-macos-x64` | [129573770883](https://github.com/OpenCoven/chat/actions/runs/42738581141/job/129573770883) | 15.7.9 (24G830) x86_64; safari | `11ddd40b4956f639ed9ff74c6e319a073e3da0a33f4fa24932e6c6e961e5a382` | `13729795886` |
| `native-linux-deb` | [129573771311](https://github.com/OpenCoven/chat/actions/runs/42738581141/job/129573771311) | Ubuntu 24.04.5 LTS, kernel 7.0.0-1017-azure; firefox | `075543e4282d1a1221c0123553ca19349534ff1dbc75eff89ab999c2a1ba958a` | `13729866388` |
| `native-windows-msi` | [129573771031](https://github.com/OpenCoven/chat/actions/runs/42738581141/job/129573771031) | Microsoft Windows Server 2025 Datacenter 10.0.26100.0; edge | `7de87d3f8ac5a62beaa0c017d7d1938de7f4afe50828bac70e1e3d62fbb85642` | `13729610872` |

All five affected rows passed on every lane: 504-1 link gestures/copy/review, 504-2 modality/dismissal/focus, 515 actual browser handoff/duplicate prevention/credential-bearing URL refusal, 504-9 exact IPv6 handoff, and 567 the held-stream completion boundary. Each row is `observed` with no failed expectations. Each 567 record orders the observed open review before fixture release and subsequent dismissal; both completion focus and fresh-review Escape focus assertions passed. Full JSON records, screenshots, installer identities, browser fields and native driver logs are retained.

The native browser evidence includes exactly `https://example.com/handoff-check?x=1` and `https://[::1]:8080/x`, no extra handoff on a second Open, and Copy-only refusal for `https://name@example.com/`. The existing plain-HTTP row observes the browser's HTTPS-upgraded landing, not independent proof of its original scheme; the Linux missing-xdg-open scenario and human screen-reader acceptance remain outside this candidate result. Those broader #504/#515 issues remain open.

## Other validation and review

[Final CI 42738589542](https://github.com/OpenCoven/chat/actions/runs/42738589542) completed successfully on `31358c6`, including Web checks, E2E, desktop build, Linux supervisor and AppImage acceptance. All applicable required checks passed under enforced branch protection; unchanged Rust/Windows supervisor jobs followed the existing classifier, while actual packaged native acceptance ran separately on all four platforms. No protection bypass, assertion weakening or timeout increase was used.

Local validation passed 45 focused unit cases, all 52 Chromium runtime-boundary browser cases, typecheck and changed-file lint. Hosted normal units passed 1,514 cases across all 84 files with 61 existing platform/checkout skips; heavy tests passed 921 cases with 36 existing platform skips. Added send synchronization, unavailable-tree and native-focus regressions failed before their fixes and passed afterward. The held-stream unit test now accumulates arbitrary HTTP chunks and rejects premature completion.

An independent read-only automated reviewer found a missing native focus assertion and a stream-test chunk assumption. Both were corrected before final qualification; its second review found no remaining important issue and expressly required the fresh native run above. This is automated review, not human acceptance or a GitHub approving review.

## First failures, superseded runs and retained limits

The original failure is [run 42532885300 attempt 1](https://github.com/OpenCoven/chat/actions/runs/42532885300/attempts/1), Windows job 128890795160 on `109f764`. Artifact 13639046133 and its original results/screenshots/log are retained: row 515 timed out waiting for a review after Named login, while its previous browser handoff checks had passed. A later retry passing is not treated as diagnosis of that first failure.

Candidate run 42735768955 on `4f212e6` was cancelled when review found that empty accessibility trees also needed rejection; it provides no acceptance. The four-platform run 42736230549 passed on `575ce0b`, but predates the final focus assertions and is recorded separately. Only run 42738581141 qualifies the final assertions.

The first local full normal suite overlapped Playwright cleanup of shared test-results and lacked PowerShell; its 32 failures are retained. A corrected isolated run ended with 1,550 passes and 20 failures in seven unchanged PowerShell/schema test files. A serial follow-up ended with 226 passes and nine timeout failures in two unchanged PowerShell-based files. These are local verification limitations, not passing tests. They were not hidden by extending deadlines or skipping affected cases. Hosted CI and all actual native lanes passed as recorded above; local PowerShell responsiveness remains the specific prerequisite for reproducing the full local suite cleanly.

Durable receipts are under `/Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/567-link-review-race/.artifacts/567/`: original first-failure ZIP/log/results, red/green unit logs, browser logs, local failure receipts, independent review, signed delivery/protection preflights, final native run/job metadata, four artifact ZIPs and extracts under `final-native/`, and `final-native-manifest.json` with hashes, exact facts and all affected-row statuses. The four candidate environments and their signing limitations are recorded verbatim in their facts/environment files. This task did not modify release tags, signing secrets, #543 or another session's worktree.
