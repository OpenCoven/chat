# The contract canary's counterpart token

`CANARY_TOKEN` is read by every cross-repository checkout in
`.github/workflows/ci.yml`: six checkouts in two jobs, each at the revision its
lock file pins.

- `Contract canary` (`contract-canary.lock.json`): `OpenCoven/sdk` and
  `OpenCoven/coven-cave`.
- `Phase 1 real-authority conformance` (`phase1-conformance.lock.json`):
  `OpenCoven/sdk` twice (the SDK and its evidence revision),
  `OpenCoven/coven-cave` and `OpenCoven/coven`. This job runs on pushes to
  `main` and on pull requests labelled `ci:full`.

## Why a token is needed

A workflow's default `GITHUB_TOKEN` is scoped to the repository it runs in. It
can read a counterpart only while that counterpart is public. When one is
switched to private, the checkout fails with:

```
remote: Repository not found.
fatal: repository 'https://github.com/OpenCoven/sdk/' not found
```

GitHub answers 404 rather than 403 so it does not confirm a private
repository's existence to an unauthorized caller, which is why the message is
identical to the repository genuinely not existing — and why this failure has
been misdiagnosed more than once.

The result is that this repository's CI goes red for reasons that have nothing
to do with its own code, whenever someone changes a setting elsewhere.

## Setting it up

**1. Create a fine-grained personal access token.**

At <https://github.com/settings/personal-access-tokens/new>:

| Field | Value |
|---|---|
| Resource owner | `OpenCoven` |
| Repository access | Only select repositories: `sdk`, `coven-cave`, `coven` |
| Repository permissions | Contents: **Read-only** |
| Expiration | As short as your rotation habit allows |

Read-only Contents is the whole requirement. Both jobs clone and read; neither
writes to a counterpart. Grant nothing else. A token that can write to
`coven-cave` can rewrite Cave's authority fixtures from a CI job in another
repository.

**2. Store it as a repository secret.**

```bash
gh secret set CANARY_TOKEN -R OpenCoven/chat
```

Paste the token when prompted. It is never echoed and never committed.

**3. Confirm it took effect.**

Re-run the `Contract canary` job with a counterpart private. It should pass.

## How the workflow uses it

```yaml
token: ${{ secrets.CANARY_TOKEN || github.token }}
```

The fallback is deliberate. With no secret set, both jobs use the default
token, which works while the counterparts are public. Adding the secret removes
the dependency on their visibility without any further change.

> **Warning:** an expired token breaks the jobs. `||` falls back only when the
> secret is unset or empty. An expired token is still a value, so checkout sends
> it and GitHub refuses it, even for a public counterpart. `Contract canary` is
> a required check, so this blocks every merge until you rotate or delete the
> token.

## Rotation

A fine-grained token expires. Rotate it before the expiry date: re-run
`gh secret set CANARY_TOKEN -R OpenCoven/chat` with a fresh token. Nothing in
the workflow changes. To fall back to the default token on purpose, delete the
secret with `gh secret delete CANARY_TOKEN -R OpenCoven/chat`.

`src/specification-guards.test.ts` asserts that all six cross-repository
checkouts in `ci.yml` carry the token expression, so removing it fails the test
suite rather than silently restoring the coupling.
