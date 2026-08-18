# The contract canary's counterpart token

The `Contract canary` CI job checks out two counterpart repositories at the
revisions pinned in `contract-canary.lock.json`:

- `OpenCoven/sdk`
- `OpenCoven/coven-cave`

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
| Repository access | Only select repositories: `sdk`, `coven-cave` |
| Repository permissions | Contents: **Read-only** |
| Expiration | As short as your rotation habit allows |

Read-only Contents is the whole requirement. The canary clones and reads; it
never writes to a counterpart. Grant nothing else — a token that can write to
`coven-cave` is a token that can rewrite Cave's authority fixtures from a CI
job in another repository.

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

The fallback is deliberate. With no secret set, the job behaves exactly as it
did before — working while the counterparts are public. Adding the secret
removes the dependency on their visibility without any further change.

That also means an expired token degrades rather than breaks: the job falls
back to the default token and keeps working for as long as the counterparts are
public.

## Rotation

A fine-grained token expires. When it does, the canary quietly returns to
depending on counterpart visibility, and will fail the next time one goes
private. Re-running `gh secret set CANARY_TOKEN` with a fresh token is the only
step; nothing in the workflow changes.

`src/specification-guards.test.ts` asserts both cross-repository checkouts carry
the token expression, so removing it fails the test suite rather than silently
restoring the coupling.
