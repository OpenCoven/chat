# Working here: what earlier sessions learned

Practical knowledge that cost earlier sessions time to find. Each entry says what happens, why it
matters, and what to do. Read `AGENTS.md` first; this page assumes it. When you learn something
every agent here needs, add it with the date you verified it. When an entry stops being true, fix
or delete it in the same PR as the change that made it false.

## GitHub

### Use REST, not GraphQL (verified 2026-11-12)

Every session shares one GitHub account, and so one GraphQL quota. `gh issue create`,
`gh pr create` and `gh pr view` go through GraphQL and fail with "API rate limit already exceeded"
when other sessions are busy. The REST endpoints keep working:

```bash
gh api repos/OpenCoven/chat/issues -f title='...' -F body=@body.md
gh api repos/OpenCoven/chat/pulls -f title='...' -f head=<branch> -f base=main -F body=@body.md
gh api repos/OpenCoven/chat/issues/<n>/labels -f 'labels[]=ci:full'
gh api -X DELETE repos/OpenCoven/chat/issues/<n>/labels/agent-ready
gh api repos/OpenCoven/chat/issues/<n> --jq .body > body.md   # then edit the State block
gh api -X PATCH repos/OpenCoven/chat/issues/<n> -F body=@body.md
gh api repos/OpenCoven/chat/issues/<n>/comments -F body=@comment.md
gh api -X PUT repos/OpenCoven/chat/pulls/<n>/merge -f sha=<expected head> -f merge_method=merge
```

Fetch the body right before you patch it, so you don't overwrite an edit made in between. Marking
a draft PR ready has no REST endpoint. Check
`gh api rate_limit --jq .resources.graphql.remaining` before `gh pr ready`.

### Every session is the same GitHub user

Sessions and Val all push, comment and merge as one account, so an issue's author or a PR's
`merged_by` can't tell you who did something. Say a merge "landed under the shared account"
rather than guessing who did it. Pass the expected head `sha` when merging so a concurrent push
can't slip in. To find out who is working on what, read the claim comments on issues and ask
peer sessions directly, not GitHub's attribution.

### Write GitHub prose as one line per paragraph

GitHub renders a newline inside a paragraph in comments and bodies as a line break. Before posting
a body you copied from a wrapped Markdown file, join each paragraph onto one line. Keep lists,
tables and code blocks as they are.

## CI

### A green PR may not have run the Rust or Windows checks (verified 2026-11-12)

On a pull request, `ci.yml` runs `Rust`, `Phase 1 real-authority conformance`,
`Windows supervisor behavior`, `Packaged acceptance (Windows)` and
`Windows profile residual cleanup` only when the PR carries the `ci:full` label. The macOS leg of `Unix producer supervisor` follows the same rule. Without the
label those jobs report `skipped`, branch protection accepts `skipped`, and the PR shows green
with that code never built.

- Add `ci:full` to any PR that touches `src-tauri/`, the supervisors, or Windows paths, before you
  call it green. The **ci:full when needed** check (`.github/workflows/ci-full-label.yml`) fails
  on a PR that changes those paths, or any file the conformance lock governs, without the label,
  and lists them. `scripts/ci-full-check.mjs` holds the rules.
- Read `skipped` on `Rust` as "not tested".
- The **iPhone companion** workflow (`ios.yml`) has the same gap. On a pull request it runs the
  simulator UI flow (`CompanionFlowTests`) only under `ci:full`, and otherwise only the native unit
  tests, still green. For a change to the companion alone, dispatch it on your branch instead of
  starting every Rust and Windows job:
  `gh api -X POST repos/OpenCoven/chat/actions/workflows/ios.yml/dispatches -f ref=<branch> -f 'inputs[ui_flow]=true' -f 'inputs[testflight]=none'`.
  It shares a concurrency group with the PR's run, so dispatch after that run finishes.
- Adding the label starts a new run (`labeled` is a trigger) and cancels the one in progress.
  Check-run lists keep entries from the cancelled run, so read the newest run's jobs.

### Known flaky rows and jobs

When one of these fails, tally that row across recent runs before debugging it, rerun only the
failed job, and record the flake (run link and attempt number) in the PR instead of hiding it:

```bash
gh api -X POST repos/OpenCoven/chat/actions/runs/<run-id>/rerun-failed-jobs
```

| What fails | Symptom | Seen |
| --- | --- | --- |
| Native acceptance row 515 (Open hands the address to the browser) | Firefox shows no window for a plain `http://` address; or, on Windows, the next link's review never opens within 10 s | About 1 in 13 runs, Linux and Windows, 2026-11-10 to 11-11 |
| Native acceptance row 567 (link review while streaming) | "Timed out waiting for the held-stream review to appear" | Linux, 2026-11-10 to 11-11. #588 fixes the lane's cause (it pressed a link below the visible area) |
| Native Windows storage audit row 504-8 | `ENOENT` statting a disappearing `Preferences<UUID>.tmp` file after quitting; the collector stops before privacy assertions | Published v0.1.2, run [43564207450](https://github.com/OpenCoven/chat/actions/runs/43564207450), attempt 1. A Windows-only retry observed all 19 rows. The first failure is retained; [#625](https://github.com/OpenCoven/chat/issues/625) tracks a stable snapshot without weakening checks. |
| iPhone companion UI test `testPairSendStreamStopAndForget` | Fails at varying steps, including on PRs that don't touch the companion | 5 of about 20 runs, 2026-11-10 to 11-12; tallied on #414. Again at line 25 on 2026-11-16 ([43822800872](https://github.com/OpenCoven/chat/actions/runs/43822800872)) and 2026-11-18 ([44326633128](https://github.com/OpenCoven/chat/actions/runs/44326633128)), attempt 1 each |
| iPhone companion UI test `testDraftRelaunchPrivacyAndUncertainSendRecovery` | `XCTAssertTrue` fails at `CompanionFlowTests.swift` line 110, 115, 170 or 177; or the UI test runner crashes tapping `mobile-privacy`, with `Assertion failure in -[XCPointerEventPath initForTouchAtPoint:offset:]` (XCTest's own touch synthesis) | 5 runs, 2026-11-16 to 11-19, on main and on PRs that don't touch the companion: [43812025719](https://github.com/OpenCoven/chat/actions/runs/43812025719) (the crash), [43822470589](https://github.com/OpenCoven/chat/actions/runs/43822470589), [43822800872](https://github.com/OpenCoven/chat/actions/runs/43822800872), [44326633128](https://github.com/OpenCoven/chat/actions/runs/44326633128), [44462839698](https://github.com/OpenCoven/chat/actions/runs/44462839698), attempt 1 each. #665 tracks the cause |
| iPhone companion unit test `ModelTests.testAllowWaitsForTheRunningTurn` | `XCTAssertTrue` fails at `ModelTests.swift:135`. The test yields once between starting the send and pressing Allow, so their order isn't guaranteed | 2026-11-12, [43172494948](https://github.com/OpenCoven/chat/actions/runs/43172494948) and [43172497765](https://github.com/OpenCoven/chat/actions/runs/43172497765), attempt 1 each. #645 (for #640) proposes synchronizing the send |
| iPhone companion unit test `TransportTests.testPinnedHTTPSReadsAndRejectsWrongCertificateAndToken` | Fails at `TransportTests.swift:16` with `NSURLErrorDomain -1005`, "The network connection was lost" | 2026-11-12 in the same two runs as the `ModelTests` failure, and 2026-11-16 in [43822800872](https://github.com/OpenCoven/chat/actions/runs/43822800872), attempt 1 each |
| `Phase 1 real-authority conformance` (macOS) | The only line is `phase1.packaging.coven-client-health-tests.exit-nonzero`; the producer hides the test output. That step runs `cargo test --locked -p coven-client --test health` in the pinned Coven checkout, so a Chat change can't cause it | Once, 2026-11-16, [43788631948](https://github.com/OpenCoven/chat/actions/runs/43788631948) attempt 1; passed on attempt 2 |
| `Unix producer supervisor (darwin-arm64)` | "producer and broker UIDs were not distinct", then passes on rerun | Once, 2026-11-09. Probably a timing race, not equal UIDs |
| Packaged acceptance AppImage jobs, and the native lane's `Linux (deb)` job | Ubuntu package mirror unreachable from the runner. For kernel.org, the log shows `Cannot initiate the connection to mirrors.edge.kernel.org:443 (<IPv6 address>) - connect (101: Network is unreachable)` for every package: `scripts/ci/ubuntu-apt.sh --select-only` chose it because its indexes downloaded, and that doesn't prove package downloads work | AppImage 2026-11-11 to 11-12; infrastructure, not the PR. #603 adds a mirror fallback. Native `Linux (deb)` in [43816747589](https://github.com/OpenCoven/chat/actions/runs/43816747589) attempt 1, 2026-11-16, over IPv6; passed on attempt 2 |

### What the native lane does and doesn't cover

- `scripts/native-acceptance/run.mjs` sets `ANTHROPIC_API_KEY`, so every lane row takes the
  engine's API-key path. **Sign in with Claude**, where the engine hands off to the local `claude`
  binary, has no automated coverage. That gap hid a real permission defect in coven-code 0.8.0 and
  0.9.0. When a change touches permissions, say which sign-in path your evidence covers.
- The e2e mock (`e2e/app.tauri-mock.spec.ts`) keeps session ids stable and answers reads
  instantly. A real run moves the chat to a new session and reads it with the composer disabled.
  Anything about focus or state after a run needs a delayed read or the native lane.
- Chromium drops focus as soon as a field is disabled; WebKit does it later. Focus logic that
  passes in one engine can fail in the other.

## Local checks that fail without your change (verified 2026-11-20)

Compare against an unchanged worktree before diagnosing a local failure. The runner writes prerequisite notices to stderr. For a detailed per-test report, pass `--reporter=default` to the single-file Vitest command below.

- **PowerShell tests.** Off-CI macOS and Linux runs identify missing PowerShell and skip the tests that invoke it. CI and Windows require PowerShell. Install PowerShell 7 to exercise those tests locally. On earlier checkouts, look for `spawnSync pwsh ENOENT` in the client-v1 conformance workflow, native installed-executable, native link-protocol, and native link-guard tests.
- **Both unit suites.** With #674, `corepack pnpm test` runs the normal and heavy suites and exits nonzero when either fails. On earlier revisions the normal suite can stop the command before the heavy suite starts. Run `corepack pnpm@10.34.0 --ignore-workspace test:unit:heavy` separately on those revisions.
- **Release toolchain.** Use the Node version in `.node-version` and put rustup’s `~/.cargo/bin` first on PATH. With #674, a Node mismatch skips the exact-version observation locally. Missing rustup also skips the four Cargo-resolution cases. CI keeps the requirements.

- **A single heavy file** needs the heavy config, because the default config excludes it:
  `corepack pnpm exec vitest run --config vitest.heavy.config.ts src/phase1-conformance.test.ts`.
- **`cargo` may not be rustup's.** `rust-toolchain.toml` pins 1.95.0, but only rustup reads it.
  On the Mac in use on 2026-11-20, `/opt/homebrew/bin/cargo` (1.99.1) comes before
  `~/.cargo/bin` on PATH. The CLAUDE.md cargo commands then pass on 1.99.1 (374 tests, clippy
  clean) while CI builds with 1.95.0. Check `cargo --version`; prefix
  `PATH="$HOME/.cargo/bin:$PATH"` to get the pinned toolchain.
- **Port 4173 may be taken.** `pnpm dev` and `app:dev` bind it with `strictPort`, and another
  worktree's dev server or an unrelated local server may hold it: on 2026-11-20 a week-old static
  server did. `lsof -nP -iTCP:4173 -sTCP:LISTEN` shows the holder; don't stop a process you
  didn't start. `app:dev` says so before Tauri starts, and
  `OPENCOVEN_CHAT_DEV_PORT=<port> corepack pnpm app:dev` moves the dev server and Tauri's devUrl
  for that run.
- **A scratch `HOME` does not isolate the `app:dev` WebView on macOS.** WebKit uses the account's
  home directory, not `$HOME`, so a dev run writes `~/Library/WebKit/opencoven-chat` and
  `~/Library/Caches/opencoven-chat` even when `HOME` and `COVEN_HOME` point at scratch. Coven state
  does follow `COVEN_HOME`. Say so when your task requires a scratch home.
- **Playwright WebKit** skips buttons on Tab (Safari's default keyboard setting), so the cross-browser suite uses Option+Tab in WebKit. Its clipboard permissions and RTL Range geometry checks remain Chromium-only, with explicit WebKit skips. The e2e suite runs Chromium and WebKit, and rendered captures provide the text-position check.
- `e2e/design-review/` is a capture harness for rendered design checks. Run it with
  `--config e2e/design-review/playwright.config.ts`.

## Commit signing

`main` rejects unsigned commits. `CONTRIBUTING.md` has the general setup. With an SSH key and no
`gpg` installed, sign per command without changing your config. Use the public key registered
on the GitHub account as a signing key (`~/.ssh/id_ed25519.pub` on the machines in use today):

```bash
git -c gpg.format=ssh -c user.signingkey="$HOME/.ssh/id_ed25519.pub" commit -S
```

To check it, keep an allowed signers file outside the repo (for example
`~/.config/git/allowed_signers`) holding one line: your git email, a space, then the contents of
the `.pub` file. Then:

```bash
git -c gpg.ssh.allowedSignersFile="$HOME/.config/git/allowed_signers" log -1 --show-signature
```

It must print `Good "git" signature`. Without the file, `git log --show-signature` and
`git show --show-signature` print "No signature" even for a signed commit. Don't use a `<(...)`
process substitution for the file: it is read only once, so later checks fail. GitHub's
**Verified** badge is the final word.
