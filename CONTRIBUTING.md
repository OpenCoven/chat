# Contributing to OpenCoven Chat

Thanks for wanting to help. OpenCoven Chat is a Tauri desktop client with a
deliberately narrow native surface and a cryptographic conformance lock, so a
few of the rules below are stricter than a typical web project. Read the
sections that apply to your change before you open a pull request.

## Before you start

- For anything larger than a bug fix or a docs correction, open an issue first
  and describe the change. Large unsolicited pull requests are hard to land.
- Check the open pull requests — a lane may already exist for what you want.
- Security issues do **not** go through pull requests. See
  [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements:

- Node.js 24.18.1 (the package engine accepts `>=24.18.0 <25`)
- pnpm 10.34.0 via Corepack (`corepack enable`)
- Rust 1.95.0 with `clippy` and `rustfmt` (see
  [`rust-toolchain.toml`](rust-toolchain.toml))
- [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) for
  your platform

The complete pin list is in
[`docs/developer-toolchains.md`](docs/developer-toolchains.md).

```bash
corepack enable
pnpm install:clean
pnpm dev          # browser fallback and explicit mock routes
pnpm app:dev      # production Tauri desktop path
```

The browser build cannot connect to Cave. The production desktop path
initializes native identity and manages the Cave connection used for canonical
chat reads.

## Branching and pull requests

`main` is the integration branch; release tags are cut only from `main`. Base
every change on current `origin/main`, use a short-lived branch, and open a
pull request:

```bash
git worktree add -b <type>/<short-name> .worktrees/<short-name> origin/main
cd .worktrees/<short-name>
```

Use a descriptive prefix such as `feat/`, `fix/`, `chore/`, `docs/`, `ci/`,
`refactor/`, or `test/`.

Release preparation is maintainer-owned. Version changes land through a pull
request; maintainers then create a signed, annotated `v*` tag from the merged
commit on `main`. Do not create or move release tags from a topic branch.

Pull request expectations:

- One logical change per pull request. Split unrelated work into lanes.
- Describe what changed, why, and how you verified it. Paste the commands you
  ran and their results.
- Keep the diff free of unrelated formatting churn.
- Update documentation in the same pull request as the behaviour it describes.

## Commits must be signed

Project policy requires every commit to be cryptographically signed and to
show as **Verified** on GitHub. Maintainers may ask you to replace unsigned
commits before merging.

Confirm your signing configuration before your first commit:

```bash
git config --get user.signingkey   # must identify your signing key
git config --get gpg.format        # blank means the OpenPGP default
git commit -S -m "feat: short imperative summary"
git show --show-signature --no-patch HEAD
```

Prefer a `type: summary` first line in the imperative mood, kept under 72
characters, with detail in the body.

## Verification

For code changes, run the baseline checks before pushing:

```bash
corepack pnpm typecheck          # TypeScript, no emit
corepack pnpm lint               # Biome, must be clean
corepack pnpm test               # unit suites (normal + heavy; heavy is slow)
corepack pnpm build              # production web build
```

If you touched Rust:

```bash
corepack pnpm cargo:fmt
corepack pnpm cargo:clippy       # warnings are denied
corepack pnpm cargo:test
```

End-to-end tests use Playwright and bind a fixed preview port:

```bash
corepack pnpm test:e2e
```

New behaviour needs a test. Bug fixes need a regression test that fails before
the fix.

Documentation-only changes do not require the broad code, test, and build
suite. Run `git diff --check`, keep prose wrapped at 100 columns, and verify
new or changed links. The current Biome configuration does not process these
governance documents, so do not report `pnpm lint` as validation for them.

```bash
git diff --check
```

## Code style

Source and configuration formatting and linting are enforced by
[Biome](https://biomejs.dev) — two-space indentation, 100-column lines, single
quotes in TypeScript, double quotes in JSX. Run `corepack pnpm format` rather
than hand-formatting supported files. Do not disable lint rules with blanket
suppressions; a `biome-ignore` must be a single line directly above the
diagnostic and must carry a reason.

Comment only what needs clarification. Prefer explicit types at module
boundaries and narrow, well-named modules over large ones.

## The conformance lock

`phase1-conformance.lock.json` cryptographically pins the Phase 1 authority
graph: the Chat, SDK, Cave, Coven, and harness revisions; selected Chat host
files; selected harness scripts and the two governed workflow files
(`.github/workflows/ci.yml` and `.github/workflows/client-v1-conformance.yml`);
release and evidence metadata; and the Windows supervisor artifact. It does
not pin every file under `src-tauri/` or `scripts/`. If your change touches a
listed authority path, coordinate with a maintainer before repinning.

Authority changes normally land in two stages:

1. Land the functional change without pointing the lock at an unreachable
   topic-branch commit.
2. After the canonical merge or squash commit is reachable, land a follow-up
   pin that updates the relevant revisions, Git objects, digests, and lock-test
   expectations. Documentation byte-count and digest rows change only when
   their governed producer bytes change.

If you are not sure whether your change is pinned, say so in the pull request
and a maintainer will help. Do not repin speculatively.

## Security-sensitive areas

Changes in these areas get extra scrutiny and should be proposed in an issue
first:

- The Tauri capability set and any new native command.
- Keyring, pairing, or credential handling in `src-tauri/`.
- Anything that widens what the webview can reach.
- The release and packaging workflows.

The native surface is intentionally minimal. "It would be convenient" is not
sufficient justification for widening it.

## Code of conduct

Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License, as described in [`LICENSE`](LICENSE).
