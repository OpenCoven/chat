export const CAVE_CLIENT_BOUNDARY = Object.freeze({
  packageName: '@opencoven/cave-client',
  status: 'managed-native-adapter',
  note: 'The SDK-managed webview boundary uses frozen packed artifacts and leaves discovery parsing, Client v1 schemas, and credentials outside UI code.',
  verification:
    'The contract canary verifies the locked packed artifact digests and rejects workspace or source-relative package contamination.',
});
