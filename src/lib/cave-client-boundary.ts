export const CAVE_CLIENT_BOUNDARY = Object.freeze({
  packageName: '@opencoven/cave-client',
  status: 'installed-packed-candidate',
  note: 'Runtime code imports only the public managed entrypoint from the checked-in packed candidate and avoids private Cave schemas and source-relative SDK links.',
  verification:
    'The dependency is pinned to reviewed tarball bytes from contract-canary.lock.json and never resolves through a workspace or registry fallback.',
});
