export const CAVE_CLIENT_BOUNDARY = Object.freeze({
  packageName: '@opencoven/cave-client',
  status: 'documented-only',
  note: 'Phase 0 documents the typed package boundary only; runtime code still avoids private Cave schemas and source-relative SDK links.',
  verification:
    'Until package publication is explicitly approved, the cross-repository canary verifies packed @opencoven/cave-client tarballs in a temporary install copy instead of adding a local path dependency.',
});
