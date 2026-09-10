# Maintained GLib 0.18.5 soundness backport

This is an OpenCoven-maintained backport for
[OpenCoven/chat#188](https://github.com/OpenCoven/chat/issues/188), not a new
upstream release. The package deliberately remains `glib 0.18.5`.

## Source and exact change

- Published archive: <https://static.crates.io/crates/glib/glib-0.18.5.crate>
- Registry record: <https://index.crates.io/gl/ib/glib>
- Archive SHA-256:
  `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Published `.cargo_vcs_info.json` identifies gtk-rs-core commit
  `42b9caf98e03ded086362d9653ca58fe94dc8658`, directory `glib`.
- Original fix:
  [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343),
  commit [`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34).
- Identical proposed 0.18 backport:
  [gtk-rs/gtk-rs-core#2009](https://github.com/gtk-rs/gtk-rs-core/pull/2009),
  commit `ea720152f28e293ef4362ee844ee5cc499f32d2a`. This proposal was closed
  **unmerged**; it is provenance, not upstream maintenance approval.

The complete published crate is retained, including `LICENSE`, `COPYRIGHT`,
tests, `.cargo_vcs_info.json`, and both manifests. Cargo uses the unmodified
published **normalized** `Cargo.toml`, whose sibling dependencies are registry
dependencies rather than Git workspace paths. `Cargo.toml.orig` is retained
only as upstream source material.

The only imported-file modification is in `src/variant_iter.rs`:

```diff
-            let p: *mut libc::c_char = std::ptr::null_mut();
+            let mut p: *mut libc::c_char = std::ptr::null_mut();
 ...
-                &p,
+                &mut p,
```

That file's SHA-256 before and after the patch is respectively:

```text
1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e
a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc
```

`src-tauri/Cargo.toml` patches crates.io GLib to this directory. The application
lockfile changes only GLib's source, without upgrading any package. GLib's
declared minimum Rust version remains 1.70; Chat continues to require 1.95.0.
The existing GTK 0.18 / WebKit 2 dependency generation is preserved.

## Reproduction and optimized regression

From the Chat repository root, on the existing Linux runner with Node, Cargo
1.95.0, `tar`, `pkg-config`, and the project's GTK/WebKit development libraries:

```sh
curl --fail --location https://static.crates.io/crates/glib/glib-0.18.5.crate \
  --output /tmp/glib-0.18.5.crate
node scripts/verify-glib-backport.mjs /tmp/glib-0.18.5.crate
node scripts/verify-glib-backport.mjs /tmp/glib-0.18.5.crate --test
```

The verifier authenticates the archive **before extracting it**, compares the
entire file set and every file's bytes, and permits only the exact upstream
fix. It fails for extra files, missing files, symlinks, or any other change.
Keep provenance and build outputs outside the imported crate directory.

`--test` uses owned temporary copies and separate Cargo target directories
to prevent reuse of same-name/version build artifacts. Before either run,
it installs the committed `vendor/glib-0.18.5.test-Cargo.lock` into both
copies. It runs the published crate's existing 11 `variant_iter` unit tests
with `--locked --release`, requires the unpatched SIGSEGV, then requires
the patched tests to pass. The first run may download the exact locked
dependencies; the patched run additionally uses `--offline`. Neither run
generates or updates a lockfile. Temporary files are removed afterward.
A compiler that does not reproduce the crash fails the before/after
demonstration rather than silently claiming success.

The separate, Cargo-generated test lock has SHA-256:

```text
fa941347aa72e4e7c7076ceb191288a4cc5ee30eea02016bd59c38d50e6b9699
```

It was generated with Rust/Cargo 1.95.0, seeding the pristine crate's temporary
`Cargo.lock` from Chat's application lock and resolving its additional
upstream dev-dependencies with `cargo metadata --offline --format-version 1`.
It preserves the application dependency versions available in that seed,
including GLib's registry sys/macro dependencies. It does not add those
upstream test/benchmark dependencies to Chat's production graph. Updating
this test lock requires an explicit reviewed regeneration and updating the
recorded checksum; routine verification cannot resolve newer versions.

The tempting application-root command
`cargo test --manifest-path src-tauri/Cargo.toml -p glib --release --lib variant_iter --locked`
does **not** run these tests: Cargo rejects GLib because it needs
dev-dependencies and is not a workspace member. The locked temporary-copy
approach runs the actual upstream tests without changing the imported
manifest or making GLib part of Chat's workspace.

The original suite already reproduces this bug; no extra change to the
upstream tests is needed. On 2026-09-09 the pristine suite crashed with SIGSEGV
and all 11 patched tests passed on macOS arm64, Rust 1.95.0, native GLib 2.88.1.
This is **not** Linux desktop acceptance.

On Linux, also inspect the application graph, build the optimized desktop,
and run existing native tests:

```sh
cargo tree --manifest-path src-tauri/Cargo.toml --locked \
  --target x86_64-unknown-linux-gnu -i glib
cargo metadata --manifest-path src-tauri/Cargo.toml --locked \
  --filter-platform x86_64-unknown-linux-gnu --format-version 1
corepack pnpm install --frozen-lockfile
corepack pnpm exec tauri build --ci --no-bundle -- --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked --release \
  --features phase1-conformance --lib \
  --test coven_health_process_boundary --test phase1_native_rpc
```

The graph must contain exactly one `glib`, version `0.18.5`, resolved to
`vendor/glib-0.18.5/Cargo.toml` with no registry source. Its sys/macro
dependencies must remain on the registry. Linux native tests involving
Secret Service or graphical integration still require their established
isolated runtime setup; do not substitute a protected conformance run against
unchanged frozen authority.

The existing Linux `Desktop build` CI job runs the authenticated optimized
before/after check and asserts the resolved package sources before building
the desktop. It then runs the existing native library and process-boundary/RPC
tests in release mode. The job retains its pinned container, Rust toolchain,
and finite deadline; it does not install system packages at run time.
Core dumps are disabled for the intentional pristine-crate crash.
These checks establish development-source Linux behavior, not protected
release-candidate acceptance.

## Advisory status and maintenance boundary

[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) /
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
still identify upstream versions `>=0.15.0,<0.20.0` as affected. A source
backport is not a version-range fix. Neither a clean scanner result that
omits path dependencies nor a persisting version-based finding supersedes
the source evidence. A local audit using the cached advisory database
(`cargo audit --no-fetch --file src-tauri/Cargo.lock --json`) on 2026-09-09
still reported RUSTSEC-2024-0429
as an `unsound` warning for the path package (despite exiting zero).
No advisory is ignored, dismissed, or relabeled here.

OpenCoven owns review and maintenance of these bytes until a compatible
upstream dependency graph replaces them. Reassess this patch when Tauri,
GTK, or WebKit dependencies change; do not treat it as general maintenance
of the EOL GLib 0.18 branch.

The existing `scripts/phase1-conformance-lock.mjs` binds both application
Cargo files in `productionChatAuthorityPaths` and `productionDeltaPaths`.
Protected producer execution also verifies immutable Git identity, file
hashes, and a clean checkout. This backport does not satisfy those frozen
bindings and must not be claimed as an accepted protected candidate.
The vendor path introduces source outside the existing explicit Cargo-file
authority lists; the parent must account for the vendored bytes as part of
the next authorized source/lock binding, not merely update a lockfile hash.
No authority pins, frozen candidates, or source guards are changed by this
backport. Only ordinary Linux CI gains the backport acceptance checks.
