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

On a pull request, `ci.yml` runs `Rust`, `Windows supervisor behavior`,
`Packaged acceptance (Windows)` and `Windows profile residual cleanup` only when the PR carries the
`ci:full` label. The macOS leg of `Unix producer supervisor` follows the same rule. Without the
label those jobs report `skipped`, branch protection accepts `skipped`, and the PR shows green
with that code never built.

- Add `ci:full` to any PR that touches `src-tauri/`, the supervisors, or Windows paths, before you
  call it green.
- Read `skipped` on `Rust` as "not tested".
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
| iPhone companion UI test `testPairSendStreamStopAndForget` | Fails at varying steps, including on PRs that don't touch the companion | 5 of about 20 runs, 2026-11-10 to 11-12; tallied on #414 |
| `Unix producer supervisor (darwin-arm64)` | "producer and broker UIDs were not distinct", then passes on rerun | Once, 2026-11-09. Probably a timing race, not equal UIDs |
| Packaged acceptance AppImage jobs | Ubuntu package mirror unreachable from the runner | 2026-11-11 to 11-12; infrastructure, not the PR. #603 adds a mirror fallback |

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

## Local checks that fail without your change (verified 2026-11-12)

Compare against an unchanged worktree before chasing any of these as a regression:

- **`src/client-v1-conformance-workflow.test.ts`** fails with `spawnSync pwsh ENOENT` on a machine
  without PowerShell. CI has it.
- **`test:unit` stops early.** It runs the normal suite `&&` the heavy suite, so the failures above
  stop it before the heavy half. Run
  `corepack pnpm@10.34.0 --ignore-workspace test:unit:heavy` on its own.
- **`src/phase1-conformance.test.ts`** (heavy) needs the exact Node version in `.node-version`
  and `rustup` on `PATH`. A newer Node or a toolchain without rustup fails it.
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
