# Vendored noVNC

This directory is `core/` and `vendor/` from the `@novnc/novnc` npm package,
version **1.7.0** (tarball SHA-256
`32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903`), copied
without modification and licensed under the Mozilla Public License 2.0 (see
`LICENSE.txt`).

It is vendored rather than installed because `pnpm-lock.yaml` is pinned by
`phase1-conformance.lock.json`; a dependency change there is a governed
rebinding, not a routine install. The screen viewer imports only
`core/rfb.js`. Biome skips this tree (`biome.json`), and TypeScript sees it
through `rfb.d.ts`.

To upgrade: replace `core/` and `vendor/` with the new release's, update the
version and digest here, and re-run the screen viewer tests.
