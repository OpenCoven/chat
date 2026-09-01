# Releasing OpenCoven Chat

The release pipeline lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It is driven by a signed tag. Nothing in it writes to `main`, and none of its
jobs are required checks on a pull request — `ci.yml` owns pull-request
verification.

## Prerequisites

A release cannot be cut until all of the following are true.

| Requirement | Why |
| --- | --- |
| The version is identical in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` | The `verify` job fails on any disagreement |
| `bundle.active` is `true` in `src-tauri/tauri.conf.json` | Otherwise the build produces an executable and no installers |
| The `release-signing` environment exists in repository settings | The `build` and `publish` jobs both target it |
| The tag is **annotated** and signed, and GitHub reports it as verified | The `verify` job rejects lightweight tags outright and refuses an unverified signature |

## Cutting a release

```bash
# 1. Confirm main is at the commit you intend to ship.
git fetch origin
git log --oneline -1 origin/main

# 2. Create an annotated, signed tag.
git tag -s v0.0.1 -m "OpenCoven Chat 0.0.1"

# 3. Confirm it signed before pushing.
git tag --verify v0.0.1

# 4. Push the tag. This starts the workflow.
git push origin v0.0.1
```

Watch the run under **Actions → Release**.

## Rehearsing without publishing

`workflow_dispatch` takes an existing tag and a `dry_run` flag that defaults to
`true`. A dry run performs tag verification, version checks, the full
four-platform build, every smoke test, and checksum generation, and then stops
without creating a GitHub Release. The checksums are written to the job summary.

Use this to validate a change to the workflow itself, or to confirm signing
secrets are wired correctly, before a real tag exists.

## What the pipeline does

### `verify` (Ubuntu)

1. Resolves the tag and rejects anything that is not `v<major>.<minor>.<patch>`
   with an optional prerelease suffix.
2. Rejects a lightweight tag outright — it is a pointer with no object of its
   own, so it can never carry a signature.
3. Rejects an annotated tag with no signature block, in those words, because
   that is a different mistake from a signature that failed to verify.
4. Requires GitHub to report the tag object's signature as verified against the
   keys registered to the signer's account.
5. Independently re-verifies the signature with `git verify-tag` when the
   `TAG_ALLOWED_SIGNERS` secret is configured, so that a release is not gated
   on a single source of truth. `git verify-tag` is not used as the *primary*
   check because an SSH-signed tag needs an allowed-signers file that a fresh
   runner does not have, and it would reject a perfectly good tag. If the two
   checks ever disagree, the release is blocked.
6. Checks the tag version against all three manifests and against
   `bundle.active`.
7. Re-runs `lint`, `typecheck`, `test:unit:normal`, and `build` against the
   exact tagged tree — not against the pull-request merge commit, which no
   longer exists in that shape.

Any `0.x` version, or any version with a prerelease suffix, is marked as a
GitHub prerelease.

### `build` (four platforms, `fail-fast: false`)

| Label | Runner | Target | Bundles |
| --- | --- | --- | --- |
| `linux-x86_64` | `ubuntu-latest` | `x86_64-unknown-linux-gnu` | `deb` |
| `macos-aarch64` | `macos-latest` | `aarch64-apple-darwin` | `app`, `dmg` |
| `macos-x86_64` | `macos-13` | `x86_64-apple-darwin` | `app`, `dmg` |
| `windows-x86_64` | `windows-latest` | `x86_64-pc-windows-msvc` | `msi`, `nsis` |

Everything builds natively; there is no cross-compilation. `fail-fast` is off
so that one platform's failure does not destroy the logs that distinguish a
toolchain problem from a source problem.

Each platform is then smoke-tested against the built artifact rather than
against the build's exit status:

- **macOS** — `CFBundleShortVersionString` matches the tag,
  `CFBundleIdentifier` is `ai.opencoven.chat`, and `lipo -archs` confirms the
  executable is actually built for the advertised architecture. When signing is
  configured, `codesign --verify --deep --strict` must pass and `spctl` is
  reported.
- **Linux** — the `.deb` `Version` field matches the tag and the payload
  contains an executable under `/usr/bin`.
- **Windows** — when signing is configured, `Get-AuthenticodeSignature` must
  report `Valid` for every installer.
- **All** — any artifact under 1 MiB fails the run. A bundler that fails
  without a non-zero exit status has happened before.

### `publish` (Ubuntu)

Downloads every platform's artifacts, recomputes `SHA256SUMS.txt` over the
exact bytes being published, generates release notes with a commit list since
the previous tag, and creates the GitHub Release with `gh release create
--verify-tag`. It refuses to run if a release already exists for the tag.

This is the only job with `contents: write`.

## Signing secrets

All signing material belongs to the `release-signing` environment, not to
repository secrets, so that a fork cannot reach it and a reviewer can gate
every signed build.

| Secret | Platform | Effect if absent |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | macOS | Bundle is unsigned; Gatekeeper refuses it without an override |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | — |
| `APPLE_SIGNING_IDENTITY` | macOS | — |
| `APPLE_ID` | macOS | Bundle is signed but not notarized |
| `APPLE_PASSWORD` | macOS | App-specific password for notarization |
| `APPLE_TEAM_ID` | macOS | — |
| `WINDOWS_CERTIFICATE` | Windows | Installers are unsigned; SmartScreen warns |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows | — |
| `TAG_ALLOWED_SIGNERS` | all | Local `git verify-tag` re-verification is skipped; GitHub's verification stands alone |

`APPLE_CERTIFICATE` and `WINDOWS_CERTIFICATE` are base64-encoded PFX/P12 files.
`TAG_ALLOWED_SIGNERS` is the contents of an OpenSSH `allowed_signers` file, one
`principal namespaces=... <key-type> <key>` line per key permitted to sign a
release tag.

A release with no signing material configured still succeeds. This is
deliberate — the project has to be able to cut a build before the certificates
exist — but every unsigned platform emits a loud workflow warning.

On Windows the certificate is imported into `Cert:\CurrentUser\My` and its
thumbprint is written into a `--config` overlay
(`src-tauri/release-signing.conf.json`), which is removed afterwards. The
tracked `tauri.conf.json` is never modified, so the tagged tree and the built
tree stay identical.

## Auto-update

There is none, on purpose. `src-tauri/tauri.conf.json` does not configure the
`updater` plugin, `createUpdaterArtifacts` is `false`, and enabling it without
the plugin fails the Tauri build outright. The workflow therefore produces no
`latest.json` and no `.sig` files.

Turning auto-update on is a separate change that must, in order:

1. Add the `tauri-plugin-updater` dependency and its capability entry.
2. Generate an updater keypair and store the private key as a secret.
3. Set `createUpdaterArtifacts` to `true`.
4. Add a step to this workflow that publishes the update manifest.

Publishing an update manifest before then would advertise updates that no
shipped client reads.

## Failure playbook

| Symptom | Cause |
| --- | --- |
| `... is a lightweight tag` | Created with `git tag` instead of `git tag -s` |
| `... is annotated but carries no signature` | Created with `git tag -a`, not `git tag -s` |
| `Tag 'x' is not verified` | Signed with a key not registered to the signer's GitHub account |
| `git verify-tag failed ... even though GitHub reported` | The key is registered on GitHub but is not in `TAG_ALLOWED_SIGNERS`. Do not release until this is explained |
| `... declares 0.1.0, but the tag says 0.0.1` | A manifest was missed during the version bump |
| `bundle.active = false` | Bundling is disabled in `tauri.conf.json` |
| `Found no release artifacts under ...` | The bundler produced nothing; read the build log above the collection step |
| `... is only N bytes` | A bundler failed silently |
| `A release already exists for ...` | Delete the release, or cut a new tag. Never reuse a tag that has been published |

Re-running a failed release is safe up to the point where the GitHub Release is
created. After that, delete the release before re-running.
