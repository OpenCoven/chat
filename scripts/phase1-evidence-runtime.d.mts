export type OperatorFilesystemState = Record<
  'cave-home' | 'coven-home' | 'projects',
  { path: string; sha256: string }
>;

export function captureOperatorFilesystemState(options: {
  caveHome: string;
  covenHome: string;
}): OperatorFilesystemState;

export function buildIsolationEvidence(options: {
  operatorBefore: OperatorFilesystemState;
  operatorAfter: OperatorFilesystemState;
  nativeBeforeSha256: string;
  nativeAfterSha256: string;
  opaqueIds: string[];
}): {
  strategy: 'process-owned-temporary-roots';
  network: 'loopback-only';
  sourceCheckoutDependency: false;
  workspaceLinkDependency: false;
  retainedPrivatePaths: false;
  retainedSocketHandles: false;
  roots: Array<{
    id: 'cave-home' | 'coven-home' | 'consumer-home' | 'native-credential-store';
    opaqueId: string;
    ownershipVerified: true;
    removedAfterRun: true;
  }>;
  operatorState: Array<{
    id: 'cave-home' | 'coven-home' | 'native-credential-store' | 'projects';
    beforeSha256: string;
    afterSha256: string;
  }>;
};
