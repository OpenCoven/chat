# Releasing OpenCoven Chat

This document is the runbook for cutting a public release of **OpenCoven Chat**
(`ai.opencoven.chat`). Releases are driven entirely by pushing a **signed,
annotated `v*` tag**. The `.github/workflows/release.yml` pipeline does the
rest: it verifies the tag, builds signed installers for macOS, Windows, and
Linux, checksums them, conditionally generates the updater manifest when
auto-update is configured, and publishes a GitHub Release.

The first public release is **v0.0.1**.

---

## 1. Release checklist

Run through this in order. Every step is runnable as written.

1. **Start from a clean, up-to-date `main`.**

   ```bash
   git checkout main
   git pull --ff-only
   git status   # must be clean
   ```

2. **Bump the version in all three manifests to the same value.** The release
   workflow fails if these disagree with the tag. Update:

   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`

   ```bash
   # confirm they match, e.g. for 0.0.1
   node -p "require('./package.json').version"
   node -p "require('./src-tauri/tauri.conf.json').version"
   grep -m1 '^version' src-tauri/Cargo.toml
   ```

   Also confirm bundling is enabled in `src-tauri/tauri.conf.json`
   (`bundle.active: true` with the platform targets), otherwise `tauri build`
   produces no installers.

3. **Land the bump through a pull request** (see branch protection in §7). Do
   not tag off an unmerged branch.

4. **Verify locally that the app builds and tests pass.**

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm lint
   corepack pnpm typecheck
   corepack pnpm test:unit
   corepack pnpm app:build   # local sanity build
   ```

5. **Make sure the updater signing keypair exists** and its public key is in
   `src-tauri/tauri.conf.json` (see §4). Without it, auto-update cannot be
   verified by clients.

6. **Create a signed, annotated tag** on the merge commit (see §2):

   ```bash
   git checkout main && git pull --ff-only
   git tag -s v0.0.1 -m "OpenCoven Chat v0.0.1"
   git verify-tag v0.0.1
   ```

7. **Push the tag.** This is the point of no return — it starts the release.

   ```bash
   git push origin v0.0.1
   ```

8. **Watch the `Release` workflow.** It will:
   - verify the tag is signed and version-consistent,
   - rerun lint, typechecking, unit tests, and the web build against the tagged
     tree,
   - build installers on each platform and smoke-test them,
   - generate `SHA256SUMS` and, only when signed updater artifacts exist,
     `latest.json`,
   - publish the GitHub Release (a **pre-release** if the tag has a suffix such
     as `-rc.1` or `-beta`, or if its major version is `0`).

9. **Verify the published release**: download an installer and check it against
   the published checksums.

   ```bash
   shasum -a 256 -c SHA256SUMS
   ```

10. **Publish the release notes.** The workflow writes a fixed body — a line
    naming the version and the `shasum` command — and reads nothing from this
    repository. The human-written notes live in `docs/release-notes/` and have
    to be applied deliberately:

    ```bash
    gh release edit v0.0.1 --notes-file docs/release-notes/v0.0.1.md
    ```

    Do this even for a pre-release. The generated body does not say what
    changed, and the Releases page is where people look first.

11. **Announce** the release per the usual OpenCoven channels.

---

## 2. Creating and verifying a signed tag

Releases require an **annotated** tag (`-a` / `-s`, not a lightweight tag) that
carries a **GPG or SSH signature**. The workflow rejects anything else.

Create a signed tag:

```bash
git tag -s v0.0.1 -m "OpenCoven Chat v0.0.1"
```

`-s` signs with your configured signing key. This machine signs with SSH:

```bash
git config --get gpg.format        # ssh
git config --get user.signingkey   # your signing key
```

Verify before pushing:

```bash
git verify-tag v0.0.1
```

For **SSH-signed** tags, `git verify-tag` needs an allowed-signers file:

```bash
git config gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
# each line: "<principal-email> namespaces=\"git\" ssh-ed25519 AAAA..."
```

In CI, GitHub's tag API must report the annotated tag signature as verified.
When the optional `TAG_ALLOWED_SIGNERS` secret is configured, the `verify-tag`
job independently runs `git verify-tag` for SSH-signed tags. A disagreement
blocks the release. Without that secret, GitHub's successful verification is
the authority; the workflow never treats an unverifiable tag as releasable.

Delete a bad *local* tag before it is pushed:

```bash
git tag -d v0.0.1
```

## Dry-run rehearsal

The workflow can be run manually against an existing signed tag. In
**Actions → Release → Run workflow**, select the branch containing the workflow
change, enter the tag, and leave `dry_run` at its default value of `true`.

A dry run verifies the remote tag, checks out its exact commit, reruns the
release-relevant tests, builds and smoke-tests all four native targets,
generates and verifies checksums, and then stops without creating or modifying
a GitHub Release. Use this path to validate workflow changes and signing-secret
wiring before the next real tag push.

**Dispatch runs the workflow from the branch you select, not from the tag.**
The build still checks out the tag's commit, so a workflow fix on `main` can be
rehearsed against a tag that predates it. Select `main` unless you are
deliberately testing an older pipeline.

`allow_unsigned=true` does not itself skip signing: it only lets the run
continue past the gate when platform secrets are *missing*. With all eight
present the switch is a no-op and the Apple and Authenticode paths run
normally.

The distinction matters when rehearsing before the certificates exist. On such
a run, each platform whose secrets are absent builds unsigned — no
notarization, no Authenticode — so a green result says nothing about whether
signing works. Those paths stay unexercised until a run has the material. Once
the secrets are configured, rehearse once more *without* the switch before a
real release.

> The pipeline was first proven end to end on 2026-09-17 (four platform builds,
> six installers, checksums verified, `publish` executed). Getting there took
> four fixes to latent failures that no rehearsal had ever reached, each hidden
> behind the one before it. `src/release-workflow.test.ts` guards them; run it
> when you change this workflow.

---

## 3. Required secrets

All signing secrets live in the GitHub deployment **environment**
`release-signing`. Configure them under **Settings → Environments →
release-signing**.

**A missing platform signing secret fails the release.** The `verify-tag` job
refuses to continue when any of the eight Apple and Windows secrets below is
absent, before the tag is checked out and long before the platform builds
start. This used to be a warning, and a warning is the wrong shape for it: the
default outcome of a missing secret was a *published* unsigned release and a
yellow annotation nobody reads. An unsigned `.app` will not open past
Gatekeeper, an unsigned `.msi` is flagged by SmartScreen, and the tag cannot be
reused to correct it — `verify-tag` refuses to replace an existing Release, so
the version is spent.

To build deliberately unsigned artifacts — rehearsing the pipeline before the
certificates exist, for instance — dispatch the workflow manually with
`allow_unsigned=true`. That switch is dispatch-only: the `inputs` context does
not exist on a tag push, so the production path cannot reach it.

Two secrets are exempt, for different reasons. `TAURI_SIGNING_PRIVATE_KEY` is
not required because auto-update is opt-in and currently disabled (§ 4), so its
absence is the expected state rather than an omission. `TAG_ALLOWED_SIGNERS` is
optional because GitHub API verification is always required; when present, it
adds an independent local SSH check.

| Secret | Purpose | Environment |
| ------ | ------- | ----------- |
| `APPLE_CERTIFICATE` | base64 of the Apple Developer ID `.p12` (macOS code signing) | `release-signing` |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` | `release-signing` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: OpenCoven (TEAMID)` | `release-signing` |
| `APPLE_ID` | Apple ID used for notarization | `release-signing` |
| `APPLE_PASSWORD` | app-specific password for that Apple ID | `release-signing` |
| `APPLE_TEAM_ID` | Apple Developer Team ID | `release-signing` |
| `WINDOWS_CERTIFICATE` | base64 of the Authenticode code-signing `.pfx` | `release-signing` |
| `WINDOWS_CERTIFICATE_PASSWORD` | password for the `.pfx` | `release-signing` |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key (signs updater artifacts) | `release-signing` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the updater private key | `release-signing` |
| `TAG_ALLOWED_SIGNERS` | allowed-signers file contents for verifying SSH-signed tags | `release-signing` |
| `GITHUB_TOKEN` | provided automatically by Actions; used to publish the release | n/a (built-in) |

> The workflow references these **by name only**. Never commit any secret value
> to the repository.

---

## 4. Auto-update status and how to enable it

> **v0.0.1 ships WITHOUT auto-update.** This repository currently has **no
> `plugins.updater`** section and no updater public key, and
> `src-tauri/tauri.conf.json` sets `bundle.createUpdaterArtifacts: false`.
> Setting it to `true` without the plugin configured makes `tauri build` fail
> with:
>
> ```
> failed to build bundler settings: failed to get updater configuration:
> plugins > updater doesn't exist
> ```
>
> Because of this, the release workflow produces **no `.sig` files and no
> `latest.json`** today, and it does **not** fail on their absence — the
> updater manifest step is opt-in and simply skips (`::notice::`) when no
> updater artifacts exist. Users of v0.0.1 update by downloading a newer
> release manually.

### Enabling auto-update (later release)

When you are ready to ship auto-update, do this once and the release workflow
picks it up automatically:

1. **Generate the updater keypair:**

   ```bash
   corepack pnpm tauri signer generate -w ~/.tauri/opencoven-chat-updater.key
   ```

   This prints a **public key** and writes the **private key** to the path
   given (with a passphrase you choose).

2. **Add the updater plugin to `src-tauri/tauri.conf.json`** with the public
   key and the release feed endpoint (this is what makes the config exist so
   the bundler stops failing):

   ```jsonc
   {
     "plugins": {
       "updater": {
         "pubkey": "<PUBLIC KEY FROM STEP 1>",
         "endpoints": [
           "https://github.com/OpenCoven/chat/releases/latest/download/latest.json"
         ]
       }
     }
   }
   ```

3. **Flip `bundle.createUpdaterArtifacts` to `true`** in
   `src-tauri/tauri.conf.json`.

4. **Store the private key** as the `TAURI_SIGNING_PRIVATE_KEY` secret and its
   passphrase as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, both in the
   `release-signing` environment.

After that, `tauri build` emits `.app.tar.gz` / `.nsis.zip` / `.AppImage.tar.gz`
archives plus `.sig` files, the release workflow assembles `latest.json` from
them, and clients begin auto-updating.

Keep the private key offline and backed up. If it is lost, existing installs
can no longer verify updates and must be reinstalled from a fresh release built
with a new key.

---

## 5. Artifacts produced

The product name contains a space, so installer filenames look like
`OpenCoven Chat_0.0.1_aarch64.dmg`. Always quote artifact paths in scripts.

Per release, the workflow publishes:

- **macOS**: `OpenCoven Chat.app` (packaged) + `.dmg` for `aarch64` and
  `x86_64`, signed and notarized when Apple secrets are present. The Intel
  target runs natively on GitHub's `macos-15-intel` runner rather than
  cross-compiling on Apple silicon.
- **Windows**: `.msi` and NSIS `.exe` for `x86_64`, Authenticode-signed when
  the Windows secret is present.
- **Linux**: `.AppImage` and `.deb` for `x86_64`.
- **`SHA256SUMS`**: checksums for every asset. Verify with
  `shasum -a 256 -c SHA256SUMS`.
- **`latest.json`**: the Tauri updater manifest — **only when auto-update is
  enabled** (see §4). Absent for v0.0.1.

---

## 6. Rollback procedure

A release cannot be un-shipped from users who already downloaded it, but its
**discoverability and auto-update propagation can be stopped quickly**. Act in
this order.

### 6.1 Stop auto-update propagation first

This is the most urgent step, because the updater is the only channel that
pushes a bad build to users who did nothing.

> **Not applicable to v0.0.1**, which ships without auto-update (no
> `latest.json`; see §4). If auto-update is still disabled, skip to §6.2.

1. **Delete the bad release's `latest.json` asset.** This stops new clients
   from fetching that manifest, although caches and clients that already read
   it may still retain it. Do not point the manifest at an older version:
   updater version checks do not provide a reliable downgrade path.
2. Prepare a **superseding release** (see 6.3) with a higher version. That is
   the only reliable way to move auto-updaters forward.

### 6.2 Mark the bad GitHub Release

```bash
# Convert the release to a draft so it disappears from the Releases page:
gh release edit v0.0.1 --draft

# or delete the release (keeps the tag unless you also delete it):
gh release delete v0.0.1 --yes
```

If you delete the release but keep the tag, the tag can still be referenced;
prefer marking it clearly:

```bash
gh release edit v0.0.1 --prerelease --title "OpenCoven Chat v0.0.1 (WITHDRAWN — do not use)"
```

### 6.3 Delete or supersede the tag

**Preferred: supersede.** Do not reuse a version number. Fix the defect, bump
to the next patch (e.g. `v0.0.2`), and cut a fresh signed release. Re-releasing
under the same tag breaks anyone who already has the old artifacts and
checksums.

**If the tag must be removed** (e.g. it was pushed by mistake and no artifacts
were distributed):

```bash
# delete the remote tag
git push --delete origin v0.0.1
# delete it locally
git tag -d v0.0.1
```

Deleting a tag that people may have already fetched is disruptive; only do it
immediately after a mistaken push, before distribution.

### 6.4 Communicate the rollback

- Edit the (withdrawn) release notes to state plainly that the version is
  withdrawn, why, and which version to use instead.
- Post to the OpenCoven announcement channels used for the original release.
- If the issue is a security vulnerability, open/adjust a **private security
  advisory** (see `SECURITY.md`) and publish it once the fix ships.

### 6.5 Users who already auto-updated

- They cannot be silently downgraded. Ship a **superseding release** with a
  higher version and a fixed build; the updater moves them forward on next
  check.
- If the bad build is actively harmful, provide clear manual-remediation
  instructions in the release notes and advisory (e.g. download and install the
  superseding version from the Releases page, verifying `SHA256SUMS`).
- Keep the last known-good installers available on their original release so
  users can manually reinstall if needed.

---

## 7. Branch protection

`main` **is** protected. Pull requests are required, force pushes and deletions
are refused, and these checks must pass before a merge:

- `Changed paths`
- `Web checks`
- `Rust`
- `E2E`
- `Desktop build`
- `Contract canary`
- `Unix producer supervisor (linux-x64)`
- `Windows supervisor behavior`

Protection is configured by a repository admin under **Settings → Branches**.
No automation in this repository applies it, and none should: a workflow that
can edit its own merge requirements is not a control.

Read the current rules rather than trusting this list, which goes stale:

```bash
gh api repos/OpenCoven/chat/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, signed: .required_signatures.enabled}'
```

> **Required signed commits are now enabled.** `required_signatures` is
> `true`, so every `git commit` for this repository needs `-S`.
>
> This narrows the gap between "the tag is signed" and "the history it points
> at is" — it does not close it. Protection governs commits pushed to `main`
> from now on; it does not retroactively validate ancestors already in the
> history, and the pipeline still verifies only the tag object. A signed tag
> can therefore still point at a history containing older unsigned commits.

These rules are the guarantee the release pipeline assumes: that what is tagged
on `main` has passed CI and is composed of non-rewritten history.
