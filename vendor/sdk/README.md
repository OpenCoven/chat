# Packed SDK runtime artifacts

These tarballs are generated from OpenCoven/sdk commit
`acc38488f00860d246c3c553375634d64806eabb` by
`scripts/create-release-artifacts.mjs`.

| Package | Size | SHA-256 |
| --- | ---: | --- |
| `@opencoven/sdk-core@0.1.0` | 33,284 bytes | `9a574e8bd5178ce2aa20db97e8a741c7c9569515546a2d3089406f41a9d040fe` |
| `@opencoven/cave-client@0.1.0` | 81,543 bytes | `c44544adf8e712d6be1e8686788e63aa0133eb318274d1fb1926138a7da148c0` |

`package.json` and `pnpm-lock.yaml` resolve both OpenCoven packages through
these relative files. `src/sdk-packed-runtime.test.ts` verifies their bytes
against `contract-canary.lock.json`; the cross-repository canary independently
rebuilds the complete four-package release set.
