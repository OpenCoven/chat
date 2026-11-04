# Releasing OpenCoven Chat

You release the **OpenCoven Chat** desktop app (`ai.opencoven.chat`) by pushing
a **signed, annotated `v*` tag**. The `.github/workflows/release.yml` pipeline
does the rest: it verifies the tag, builds installers for macOS, Windows and
Linux (signed and notarized on macOS), checksums them, and
generates the updater feed when the tagged tree configures auto-update,
then publishes a GitHub Release and moves the feed to it. This runbook covers the steps around that
push. The iPhone companion ships through TestFlight instead
([iPhone companion › TestFlight](iphone-companion.md#testflight)).

**Windows ships unsigned for now** (decided 2026-10-14). Windows was left out of
v0.0.2 on #356, and v0.0.5 is the first release with Windows installers.

Certificate authorities have issued code-signing keys only on hardware tokens or
cloud HSMs since June 2023, so the exportable `.pfx` that `WINDOWS_CERTIFICATE`
expects is no longer obtainable. Choosing a hosted signing route is #411.

Until it is chosen, the `.msi` and `.exe` carry no Authenticode signature.
Windows SmartScreen shows "Windows protected your PC" the first time one runs,
and the person installing it chooses **More info**, then **Run anyway**. The
generated release body and the release notes both say so.

The build job refuses nothing on Windows except a half-set of the two
`WINDOWS_*` secrets. When both are present, it signs the installers and verifies
the signature, with no other change. The app itself works on Windows: runs are
contained in a kill-on-close Job Object, so Stop ends the whole process tree.

The first public release is **v0.0.2**.

There is no v0.0.1 release. A signed `v0.0.1` tag was pushed on 2026-09-16,
but its release run stopped at the signing gate because the `release-signing`
environment held no secrets, so nothing was published. The tag stays on the
remote as history, and the version is not reused (§ 6.3).

---

## 1. Release checklist

Run through this in order. First set `VERSION` to the tag you are releasing.
The commands in this document use it, so run them in the same shell:

```bash
VERSION=v0.0.6   # the tag you are releasing
```

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
   # each must show $VERSION without the leading v
   node -p "require('./package.json').version"
   node -p "require('./src-tauri/tauri.conf.json').version"
   grep -m1 '^version' src-tauri/Cargo.toml
   ```

   **Verify the package contract.** The release workflow runs this before any
   platform build, so run it locally first:

   ```bash
   node scripts/verify-package.mjs
   ```

   It enforces what the configuration declares: product name and identifier,
   the 1180×780 default and 480×520 minimum window, a strict CSP with no
   network origins in `connect-src`, the installer targets and icons, the
   main window's capability allowlist, and no shell, filesystem, HTTP or
   opener plugin. It also holds the first release's decisions recorded on issue #356:
   no updater (see § 4) and no deep-link protocol. A release that enables
   either changes that decision in `scripts/verify-package.mjs` in the same
   change that configures it.

   Also confirm bundling is enabled in `src-tauri/tauri.conf.json`
   (`bundle.active: true` with the platform targets), otherwise `tauri build`
   produces no installers.

3. **Land the bump through a pull request** (see branch protection in § 7).
   Don't tag off an unmerged branch.

4. **Verify locally that the app builds and tests pass.**

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm lint
   corepack pnpm typecheck
   corepack pnpm test:unit
   corepack pnpm app:build   # local sanity build
   ```

5. **Check the updater key.** If `src-tauri/tauri.conf.json` has a
   `plugins.updater` section, `release-signing` must hold
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   (§ 3, § 4). `verify-tag` refuses the release otherwise. A tree without
   `plugins.updater` needs neither.

6. **Create a signed, annotated tag** on the merge commit (see § 2):

   ```bash
   git checkout main && git pull --ff-only
   git tag -s "$VERSION" -m "OpenCoven Chat $VERSION"
   git verify-tag "$VERSION"
   ```

7. **Push the tag.**

   > **Warning:** this is the point of no return. Pushing the tag starts the
   > release.

   ```bash
   git push origin "$VERSION"
   ```

8. **Watch the `Release` workflow.** It will:
   - verify the tag is signed and version-consistent,
   - rerun lint, typechecking, unit tests, and the web build against the tagged
     tree,
   - build installers on each platform and smoke-test them,
   - when the updater is on, write `latest.json` from the signed updater
     artifacts (`scripts/updater-manifest.mjs`), then generate `SHA256SUMS`,
   - smoke-test the assembled release with `scripts/release-smoke.mjs`: all six
     installers present once and non-empty, `SHA256SUMS` covering every asset
     and matching its bytes, the tag, `package.json`, `tauri.conf.json` and
     `Cargo.toml` versions agreeing, the product name and identifier
     unchanged, and either no updater asset at all (updater off) or every
     updater artifact signed with `latest.json` pointing at each one (updater
     on). The job summary states the updater and signing state, including an
     `allow_unsigned` rehearsal and whether the Windows installers were signed,
   - publish the GitHub Release (a **pre-release** if the tag has a suffix such
     as `-rc.1` or `-beta`, or if its major version is `0`),
   - when the updater is on, move the auto-update feed (the `updater`
     release, § 4) to this version and read it back by the URL installed apps
     use.

9. **Verify the published release**: download an installer and `SHA256SUMS`,
   then check the installer against it. Run this in the folder that holds both.
   `--ignore-missing` skips the installers you did not download; without it,
   `shasum` reports them as missing and fails.

   ```bash
   shasum -a 256 -c --ignore-missing SHA256SUMS
   ```

10. **Publish the release notes.** The workflow writes a fixed body: a line
    naming the version, the `shasum` command, whether the Windows installers
    are signed, and whether the release has a `latest.json`. It reads nothing
    from `docs/release-notes/`. The human-written notes live there, and you
    apply them yourself:

    ```bash
    gh release edit "$VERSION" --notes-file "docs/release-notes/$VERSION.md"
    ```

    Do this even for a pre-release. The generated body does not say what
    changed, and the Releases page is where people look first.

11. **Announce** the release per the usual OpenCoven channels.

---

## 2. Creating and verifying a signed tag

Releases require an **annotated** tag (`-a` / `-s`, not a lightweight tag) that
carries a **GPG or SSH signature**. The workflow rejects anything else.

Create a signed tag (`VERSION` is set at the top of § 1):

```bash
git tag -s "$VERSION" -m "OpenCoven Chat $VERSION"
```

`-s` signs with your configured signing key. To check which format and key Git
uses (this example signs with SSH):

```bash
git config --get gpg.format        # ssh
git config --get user.signingkey   # your signing key
```

Verify before pushing:

```bash
git verify-tag "$VERSION"
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
git tag -d "$VERSION"
```

## Dry-run rehearsal

You can run the workflow manually against an existing signed tag. In
**Actions → Release → Run workflow**, select `main`, enter the tag, and
leave `dry_run` at its default value of `true`.

A dry run verifies the remote tag, checks out its exact commit, reruns the
release-relevant tests, builds and smoke-tests all three native targets,
generates and verifies checksums, and then stops without creating or modifying
a GitHub Release. Use this path to validate workflow changes and signing-secret
wiring before the next real tag push.

> **Note:** a dry run from a feature branch can't reach the signing secrets.
> The `release-signing` environment admits only `main` and `v*` tags (§ 3), so
> land a workflow change on `main` first, then rehearse it.

**Dispatch runs the workflow from the branch you select, not from the tag.**
The build still checks out the tag's commit, so a workflow fix on `main` can be
rehearsed against a tag that predates it. Select `main`, or select the tag
itself to test the older pipeline it carries.

`allow_unsigned=true` does not itself skip signing: it only lets the run
continue past the gate when platform secrets are *missing*. With the four Apple
signing secrets and one complete notarization set present (§ 3), the switch is
a no-op and the Apple signing and notarization paths run normally.

An `allow_unsigned` run never publishes. `verify-tag` refuses one dispatched
with `dry_run=false`, before anything is built, and the publish step refuses it
again. To publish, dispatch without the switch or push the tag.

The production path never builds unsigned either. `verify-tag`'s secrets gate
runs once per workflow run, so a re-run of failed jobs re-reads the secrets in
the build job instead. That job refuses to continue when the Apple material is
incomplete and the run was not dispatched with `allow_unsigned`, and its
artifact check runs `codesign` and `spctl` whatever the signing step reported.
This closed a real gap: on 2026-10-07 an `APPLE_ID` saved as an empty value
let a re-run of v0.0.2 build unsigned and publish (#356).

The disk images are notarized too, not only the app inside them. Tauri
notarizes and staples the `.app`, then builds the `.dmg` around it without
submitting it, so v0.0.2 and v0.0.3 shipped images that `spctl --type open`
rejects as "Unnotarized Developer ID" (#407). The app inside was still
accepted, so nobody was blocked. `Notarize and staple the disk images` now
submits each `.dmg` with the same credentials, staples the ticket and checks
it, and the artifact check refuses an image without one.

> **Note:** when you rehearse before the certificates exist, a green result
> says nothing about whether signing works. Each platform whose secrets are
> absent builds unsigned (no notarization, no Authenticode), and those paths
> stay unexercised until a run has the material. Once the secrets are
> configured, rehearse once more *without* the switch before a real release.

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

The environment's deployment policy admits only the `main` branch and tags
matching `v*`. A workflow run from any other branch stops before its first job
that needs the environment, so it never sees a signing secret. Check the policy
with:

```bash
gh api repos/OpenCoven/chat/environments/release-signing/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.type) \(.name)"'
```

The iPhone companion's TestFlight job (`.github/workflows/ios.yml`) uses this
environment too. It reads `APPLE_API_ISSUER`, `APPLE_API_KEY` and
`APPLE_API_KEY_BASE64`, so rotating that key affects both pipelines. See
[iPhone companion › TestFlight](iphone-companion.md#testflight).

**A missing Apple signing secret fails the release.** The `verify-tag` job
refuses to continue when the Apple signing material is incomplete, before the
tag is checked out and long before the platform builds start. The secrets fall
into three groups:

- **Signing (required):** `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID`.
- **Notarization (required, one complete set):** either the App Store Connect
  API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_BASE64`), which
  is preferred and used when present, or an Apple ID with an app-specific
  password (`APPLE_ID`, `APPLE_PASSWORD`).
- **Windows (optional):** the two `WINDOWS_*` secrets. Windows ships unsigned
  by decision (see the top of this document), and the build job signs the
  Windows installers only when both are set.
- **Updater (required once the tree configures it):**
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Once
  `src-tauri/tauri.conf.json` has `plugins.updater`, `verify-tag` reads that
  from the verified commit and refuses a release without both, and the build
  job refuses again on a re-run. A tag whose tree has no `plugins.updater`
  needs neither.

The API key is preferred because it's a team credential. On 2026-10-06, four
app-specific passwords in a row were rejected with `401 Invalid credentials`
because the Apple ID was not on the team.

For the Apple secrets this used to be a warning, and a warning is the wrong
shape for it: the default outcome of a missing secret was a *published* unsigned
release and a yellow annotation nobody reads. An unsigned `.app` won't open past
Gatekeeper, and the tag can't be reused to correct it: `verify-tag` refuses to
replace an existing Release, so the version is spent.

To build deliberately unsigned artifacts (to rehearse the pipeline before the
certificates exist, for instance), dispatch the workflow manually with
`allow_unsigned=true` and `dry_run=true`. That switch is dispatch-only: the
`inputs` context does not exist on a tag push, so the production path cannot
reach it. It is also rehearsal-only: a run that sets it never publishes a
release (see the dry-run rehearsal above).

`TAG_ALLOWED_SIGNERS` is optional because GitHub API verification is always
required; when present, it adds an independent local SSH check.

The environment accepts only the `main` branch and `v*` tags (deployment
policy set 2026-10-18), so a workflow on any other branch can't read these
secrets.

| Secret | Purpose | Environment |
| ------ | ------- | ----------- |
| `APPLE_CERTIFICATE` | base64 of the Apple Developer ID `.p12` (macOS code signing) | `release-signing` |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` | `release-signing` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: OpenCoven (TEAMID)` | `release-signing` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (notarization, preferred; also TestFlight uploads) | `release-signing` |
| `APPLE_API_KEY` | App Store Connect API key ID, e.g. `BR9FQPGJ5N` (notarization and TestFlight) | `release-signing` |
| `APPLE_API_KEY_BASE64` | base64 of the `AuthKey_<id>.p8` private key (notarization and TestFlight) | `release-signing` |
| `APPLE_ID` | Apple ID used for notarization (alternative to the API key) | `release-signing` |
| `APPLE_PASSWORD` | app-specific password for that Apple ID (alternative to the API key) | `release-signing` |
| `APPLE_TEAM_ID` | Apple Developer Team ID | `release-signing` |
| `WINDOWS_CERTIFICATE` | base64 of an Authenticode code-signing `.pfx` (optional: with its password set, the Windows installers are signed; otherwise they ship unsigned, see #411) | `release-signing` |
| `WINDOWS_CERTIFICATE_PASSWORD` | password for the `.pfx` (optional; set both or neither) | `release-signing` |
| `ES_USERNAME` | SSL.com account username for eSigner (optional: with all four `ES_*` set, the Windows installers are signed through eSigner; see below) | `release-signing` |
| `ES_PASSWORD` | SSL.com account password | `release-signing` |
| `ES_CREDENTIAL_ID` | the eSigner credential ID of the OV code-signing certificate | `release-signing` |
| `ES_TOTP_SECRET` | the base32 secret from eSigner's automated-signing enrollment, from which CodeSignTool makes each one-time code | `release-signing` |
| `WINDOWS_PUBLISHER` (variable) | the publisher name the Windows certificate carries; required whenever the Windows installers are signed | `release-signing` |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key; signs every updater artifact (required once the tree configures the updater, § 4) | `release-signing` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the updater private key (required with it) | `release-signing` |
| `TAG_ALLOWED_SIGNERS` | allowed-signers file contents for verifying SSH-signed tags | `release-signing` |
| `GITHUB_TOKEN` | provided automatically by Actions; used to publish the release | n/a (built-in) |

> **Warning:** the workflow references these **by name only**. Never commit any
> secret value to the repository.

### Signing the Windows installers

Certificate authorities stopped issuing code-signing certificates as exportable
`.pfx` files in June 2023. The private key now stays in a hardware token or a
cloud HSM, so Windows signing goes through a service (#411). Val chose **SSL.com
eSigner** on 2026-10-18. The account is not set up yet, so the installers still
ship unsigned. The build job supports two ways, and refuses a configuration that
sets both:

1. **eSigner**: all four `ES_*` secrets. The build downloads SSL.com's
   CodeSignTool, pinned by version and SHA-256, and runs it on the runner's Java
   21. It also writes a small wrapper that Tauri runs, as
   `bundle.windows.signCommand`, on every file it signs: the app executable as
   well as both installers. The wrapper fails if CodeSignTool's output reports
   an error, even when its exit code is 0.
2. **A `.pfx`**: `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`. The
   certificate is imported into the runner's store, and Tauri signs with it
   through `signtool`.

A partial set of either way's secrets fails the build rather than shipping
unsigned. Either way, set `WINDOWS_PUBLISHER` to the name on the certificate,
`Soul Protocol LLC` for eSigner. The build then checks that every installer has
a `Valid` Authenticode signature from that publisher. With neither way
configured, the installers ship unsigned and the release notes say so.

**Setting up eSigner (once the OV certificate is issued):**

1. In the SSL.com account, enroll the certificate in eSigner for **automated
   signing**. The enrollment shows a QR code and its base32 secret. Store that
   secret as `ES_TOTP_SECRET`, not in an authenticator app.
2. Find the credential ID, under the certificate's eSigner details or with
   CodeSignTool's `get_credential_ids`, and store it as `ES_CREDENTIAL_ID`.
3. Store the account's username and password as `ES_USERNAME` and
   `ES_PASSWORD`, and set the `WINDOWS_PUBLISHER` variable.
4. Rehearse: dispatch the workflow from `main` against an existing tag with
   `dry_run=true`, and check the Windows job's log for `ok: … is signed by …`
   on both installers.
5. Then add the four `ES_*` names to `verify-tag`'s required list, so a missing
   one refuses a release instead of shipping unsigned.

Each signing uses one of the account's eSigner signings: three or more per
release (the app executable and both installers). Certificates now last at most
460 days, so expect to renew yearly. eSigner keeps the same credential ID across
a renewal, but check it.

---

## 4. Auto-update

Decided on #356 on 2026-10-18: Chat turns auto-update on from the next
release. No release up to v0.0.6 has an updater, so their users update by
downloading a newer release, once, to a version that has one.

### How it works

- **The app** carries `tauri-plugin-updater` and, in
  `src-tauri/tauri.conf.json`, a `plugins.updater` section with the public key
  and one endpoint:
  `https://github.com/OpenCoven/chat/releases/download/updater/latest.json`.
  `scripts/verify-package.mjs` holds that configuration.
- **The base config keeps `bundle.createUpdaterArtifacts: false`.** With it on,
  every `tauri build` needs the private key, including CI's desktop build and
  your local `app:build`. A release whose tree configures the updater, and
  whose `release-signing` holds the key, turns it on with an overlay
  (`Configure updater artifacts`) passed as a second `--config`.
- **What the build signs.** With the overlay, Tauri signs the `.msi`,
  `-setup.exe`, `.AppImage` and `.deb` themselves and writes a `.sig` beside
  each. It archives only the macOS app, as `.app.tar.gz` plus `.sig`, which the
  build job prefixes with its target. These are Tauri v2's names; the
  `.msi.zip`, `.nsis.zip` and `.AppImage.tar.gz` forms are its deprecated
  `"v1Compatible"` mode, which this pipeline does not use.
- **The feed.** `scripts/updater-manifest.mjs` writes `latest.json`, with a
  `{os}-{arch}-{installer}` entry for every artifact (`darwin-aarch64-app`,
  `windows-x86_64-msi`, `windows-x86_64-nsis`, `linux-x86_64-appimage`,
  `linux-x86_64-deb`, and so on). It also writes one `{os}-{arch}` default per
  platform: the app on macOS, NSIS on Windows, the AppImage on Linux.
  `tauri-plugin-updater` 2.12 looks for the installer-specific entry first, so
  each install updates with the installer type it was installed with. Every
  entry's `signature` is the `.sig` file's contents and its `url` is the
  artifact in that version's release. `scripts/release-smoke.mjs` checks the
  feed against the same table before anything is published.
- **The pointer release.** Every Chat release is a pre-release, and GitHub's
  `releases/latest` skips pre-releases, so apps don't read a version's own
  `latest.json`. They read the one asset of a fixed release tagged `updater`
  (a pre-release, never marked latest). After a release publishes, the
  workflow replaces that asset (`--clobber`) and reads it back by the URL apps
  use. A dry run or an `allow_unsigned` rehearsal never touches it. The
  version's own `latest.json` stays as a release asset, covered by
  `SHA256SUMS`, as a record of what the feed served.

### The signing key

1. **Generate it offline:**

   ```bash
   corepack pnpm tauri signer generate -w ~/.tauri/opencoven-chat-updater.key
   ```

   It prints the **public key** and writes the **private key**, encrypted with
   a password you choose, to the given path. Use a password: the workflow
   requires `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
2. **The public key** goes into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json`.
3. **The private key and its password** go into `release-signing` as
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
   nowhere else in GitHub.
4. **Back them up outside GitHub** (a password manager). Installed copies accept
   only updates signed by this key: **if it is lost, every installed copy is
   stranded** until it is reinstalled by hand from a release built with a new
   key.
5. **To rotate it,** ship a release that carries the new public key, signed
   with the old key, then switch the secrets to the new key for the releases
   after it.

### The first updater release

A release can only be updated *into* by a copy that already has the updater.
The first release with the updater is therefore installed by hand, and
proving the update journey takes two updater releases: install the first,
publish the second, and watch the first find, verify and install it. Rehearse
the pipeline before that with a [dry run](#dry-run-rehearsal) against a tag
whose tree configures the updater, and check what the dry run built.

---

## 5. Artifacts produced

The product name contains a space, so the build produces names like
`OpenCoven Chat_0.0.3_aarch64.dmg`. GitHub serves an uploaded asset with each
space replaced by a dot, so the publish job renames every asset that way
(`OpenCoven.Chat_0.0.3_aarch64.dmg`) before it writes `SHA256SUMS` and
`latest.json`. Both then name the files people download, and
`shasum -a 256 -c SHA256SUMS` works on a folder of downloads. Releases up to
v0.0.3 listed the spaced names, so their downloads must be renamed back before
`shasum -c`. Always quote artifact paths in scripts, since build output still
has the space.

Per release, the workflow publishes:

- **macOS**: a `.dmg` for `aarch64` (`_aarch64.dmg`) and one for `x86_64`
  (`_x64.dmg`). The image and the app inside it are each signed, notarized and
  stapled. The `.app` is not a separate asset. The Intel target runs natively
  on GitHub's `macos-15-intel` runner rather than cross-compiling on Apple
  silicon.
- **Windows**: `.msi` (WiX, `_x64_en-US`) and NSIS `.exe` (`_x64-setup`) for
  `x86_64`, built on `windows-2025`. Unsigned until #411 is settled; the build
  job reads the product name and version back from both installers and
  records the Authenticode state (`NotSigned`, or `Valid` once a certificate
  is configured).
- **Linux**: `.AppImage` and `.deb` for `x86_64`.
- **`SHA256SUMS`**: checksums for every asset. Verify with
  `shasum -a 256 -c --ignore-missing SHA256SUMS` (§ 1, step 9).
- **Updater signatures** (when the updater is on, § 4): a `.sig` beside the
  `.msi`, `-setup.exe`, `.AppImage` and `.deb`, and each Mac's
  `<target>-OpenCoven.Chat.app.tar.gz` with its `.sig`.
- **`latest.json`**: the updater feed for this version, **only when the updater
  is on** (§ 4). Apps read the copy on the `updater` release, not this one.
  Absent from every release up to v0.0.5.

---

## 6. Rollback procedure

You can't un-ship a release from people who already downloaded it, but you can
quickly **hide it and stop auto-update from spreading it**. Act in this order.

### 6.1 Stop auto-update propagation first

This is the most urgent step, because the updater is the only channel that
pushes a bad build to users who did nothing.

> **Note:** releases up to v0.0.5 have no updater. If the bad release has no
> `latest.json`, skip to § 6.2.

Installed apps read only the feed on the `updater` release (§ 4), so that is
the one asset to act on:

1. **Remove the feed:**

   ```bash
   gh release delete-asset updater latest.json --repo OpenCoven/chat --yes
   ```

   Apps then find no update and stay where they are. Copies that already
   downloaded the bad version keep it. The updater does not downgrade.
2. **Never upload an older version's `latest.json` to the feed.** The updater
   offers only versions newer than the installed one, so an older feed offers
   nothing to copies on the bad version, and it hides the problem.
3. **Ship a superseding release** (§ 6.3) with a higher version. Publishing it
   puts a new `latest.json` on the feed, which moves every copy forward, the
   bad version included. That is the only reliable way out.

### 6.2 Mark the bad GitHub Release

> **Warning:** the commands in § 6.2 and § 6.3 act on `$VERSION`. Set it to the
> bad release's tag first (`VERSION=v<bad version>`), and check it with
> `echo "$VERSION"` before you run anything here. A value left over from an
> earlier release withdraws or deletes the wrong one.

```bash
# Convert the release to a draft so it disappears from the Releases page:
gh release edit "$VERSION" --draft

# or delete the release (keeps the tag unless you also delete it):
gh release delete "$VERSION" --yes
```

Deleting the release leaves the tag in place, where it can still be referenced.
Keeping the release and marking it withdrawn is clearer:

```bash
gh release edit "$VERSION" --prerelease --title "OpenCoven Chat $VERSION (WITHDRAWN: do not use)"
```

### 6.3 Delete or supersede the tag

**Preferred: supersede.** Do not reuse a version number. Fix the defect, bump
to the next patch version, and cut a fresh signed release. Re-releasing
under the same tag breaks anyone who already has the old artifacts and
checksums.

**If the tag must be removed** (e.g. it was pushed by mistake and no artifacts
were distributed):

```bash
# delete the remote tag
git push --delete origin "$VERSION"
# delete it locally
git tag -d "$VERSION"
```

> **Warning:** deleting a tag that people may have already fetched is
> disruptive. Only do it immediately after a mistaken push, before
> distribution.

### 6.4 Communicate the rollback

- Edit the (withdrawn) release notes to state plainly that the version is
  withdrawn, why, and which version to use instead.
- Post to the OpenCoven announcement channels used for the original release.
- If the issue is a security vulnerability, open or update a **private security
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

> **Signed commits are required.** `required_signatures` is `true`, so every
> `git commit` for this repository needs `-S`.
>
> This narrows the gap between "the tag is signed" and "the history it points
> at is", but it doesn't close it. Protection governs commits pushed to `main`
> from now on. It doesn't retroactively validate ancestors already in the
> history, and the pipeline still verifies only the tag object. A signed tag
> can therefore still point at a history containing older unsigned commits.

These rules are the guarantee the release pipeline assumes: that what is tagged
on `main` has passed CI and is composed of non-rewritten history.
