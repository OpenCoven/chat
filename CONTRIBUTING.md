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

- Node.js 22+ (24 recommended)
- pnpm 10.34.0 via Corepack (`corepack enable`)
- Rust stable toolchain (see [`rust-toolchain.toml`](rust-toolchain.toml))
- Tauri desktop prerequisites for your platform

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # web layer only, in a browser
corepack pnpm app:dev      # full Tauri desktop shell
```

The app runs standalone. A Coven Cave connection is optional and is opted into
from the source bar inside the app.

## Branching and pull requests

`main` is the release branch. Use a short-lived branch and a pull request for
every change:

```bash
git worktree add -b <type>/<short-name> .worktrees/<short-name> origin/main
cd .worktrees/<short-name>
```

Branch name prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `ci/`, `refactor/`,
`test/`.

Pull request expectations:

- One logical change per pull request. Split unrelated work into lanes.
- Describe what changed, why, and how you verified it. Paste the commands you
  ran and their results.
- Keep the diff free of unrelated formatting churn.
- Update documentation in the same pull request as the behaviour it describes.

## Commits must be signed

Every commit must be cryptographically signed and show as **Verified** on
GitHub. Unsigned commits will be rejected.

```bash
git commit -S -m "feat: short imperative summary"
```

Confirm your signing configuration before your first commit:

```bash
git config --get user.signingkey   # must return a key
git config --get gpg.format        # ssh, openpgp, or x509
git log -1 --show-signature        # must report a good signature
```

Commit messages use a `type: summary` first line in the imperative mood, kept
under 72 characters, with detail in the body.

## Verification

Run these before pushing. Pull requests that fail them will not be merged.

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

## Code style

Formatting and linting are enforced by [Biome](https://biomejs.dev) — two-space
indentation, 100-column lines, single quotes in TypeScript, double quotes in
JSX. Run `corepack pnpm format` rather than hand-formatting. Do not disable
lint rules with blanket suppressions; a `biome-ignore` must be a single line
directly above the diagnostic and must carry a reason.

Comment only what needs clarification. Prefer explicit types at module
boundaries and narrow, well-named modules over large ones.

## The conformance lock

`phase1-conformance.lock.json` cryptographically pins the Rust host, the
contents of `scripts/`, and two workflow files (`ci.yml` and
`client-v1-conformance.yml`). If your change touches any pinned path, the
conformance suite will fail until the lock is repinned, which is a two-commit
process:

1. Commit the functional change on its own.
2. Commit a second change updating the pinned revision, tree, and blob hashes
   to that first commit, plus the byte-count and digest rows in
   [`docs/phase1-conformance.md`](docs/phase1-conformance.md) and the
   expectations in `src/phase1-conformance-lock.test.ts`.

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
