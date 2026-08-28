import {
  NativeBoundaryError,
  type NativeDiagnosticCode,
  type NativeDiagnostics,
} from './native-boundary';

type PresentedCheck = Readonly<{
  label: string;
  status: 'Available' | 'Unavailable';
  detail: string;
}>;

export type PresentedDiagnostics = Readonly<{
  platform: string;
  checks: readonly PresentedCheck[];
}>;

export type PresentedError = Readonly<{
  title: string;
  detail: string;
  diagnosticId: string;
}>;

const COMPONENT_LABELS = {
  cave_credential_custody: 'Credential storage',
  cave_protected_authority: 'Protected Cave connection',
  coven_unix_peer_identity: 'Local Coven identity',
  coven_windows_pipe_identity: 'Local Coven identity',
} as const;

const ERROR_COPY: Readonly<
  Record<NativeDiagnosticCode, Readonly<{ title: string; detail: string }>>
> = {
  body_limit: {
    title: 'Response too large',
    detail: 'OpenCoven returned more data than this view can safely accept.',
  },
  conflict: {
    title: 'Action could not finish',
    detail: 'The local OpenCoven state changed while the action was running.',
  },
  credential_update_in_progress: {
    title: 'Credential update in progress',
    detail: 'Wait a moment, then retry the same safe step.',
  },
  incompatible_version: {
    title: 'Update required',
    detail: 'This Chat build is not compatible with the local OpenCoven service.',
  },
  internal_error: {
    title: 'OpenCoven error',
    detail: 'The local service could not complete the request.',
  },
  invalid_request: {
    title: 'Action unavailable',
    detail: 'Chat could not safely prepare that request.',
  },
  invalid_response: {
    title: 'Invalid response',
    detail: 'Chat rejected an unexpected response from the native boundary.',
  },
  not_found: {
    title: 'Not found',
    detail: 'The requested OpenCoven item is no longer available.',
  },
  operation_in_progress: {
    title: 'Action already in progress',
    detail: 'Wait for the current action to finish before trying again.',
  },
  owner_mismatch: {
    title: 'Local identity changed',
    detail: 'Chat refused a local service that did not match the expected owner.',
  },
  pairing_denied: {
    title: 'Connection not approved',
    detail: 'The pairing request was denied. Start a new request to try again.',
  },
  pairing_expired: {
    title: 'Connection request expired',
    detail: 'Start a new pairing request to continue.',
  },
  pairing_pending: {
    title: 'Approval still pending',
    detail: 'Approve the request in Cave, then check again.',
  },
  platform_security_unavailable: {
    title: 'Secure connection unavailable',
    detail: 'This build cannot establish the required protected local connection yet.',
  },
  rate_limited: {
    title: 'Please wait',
    detail: 'Too many requests were made. Wait briefly before trying again.',
  },
  reconcile_required: {
    title: 'Refreshing data',
    detail: 'This view changed while loading and is being refreshed.',
  },
  scope_denied: {
    title: 'Read access unavailable',
    detail: 'The local credential does not allow this read.',
  },
  secret_store_delete_failed: {
    title: 'Could not forget credential',
    detail: 'Secure credential storage could not remove the local credential.',
  },
  secret_store_read_failed: {
    title: 'Could not read credential',
    detail: 'Secure credential storage could not read the local credential.',
  },
  secret_store_rollback_failed: {
    title: 'Credential cleanup required',
    detail: 'Chat could not safely finish local credential cleanup.',
  },
  secret_store_write_failed: {
    title: 'Could not save credential',
    detail: 'Secure credential storage could not save the approved credential.',
  },
  secure_store_unavailable: {
    title: 'Credential storage unavailable',
    detail: 'Secure credential storage is unavailable on this device.',
  },
  service_unavailable: {
    title: 'Connection unavailable',
    detail: 'OpenCoven could not be reached. Try again when the local service is available.',
  },
  stale_record: {
    title: 'Local service changed',
    detail: 'Chat refused a stale local service record.',
  },
  timeout: {
    title: 'Connection timed out',
    detail: 'The local OpenCoven service did not respond in time.',
  },
  unauthorized: {
    title: 'Connection revoked',
    detail: 'This device no longer has access. Pair it again to continue.',
  },
  unsafe_endpoint: {
    title: 'Unsafe local service',
    detail: 'Chat refused a local endpoint that did not meet its trust requirements.',
  },
  unsupported_operation: {
    title: 'Feature unavailable',
    detail: 'The local OpenCoven service does not support this operation.',
  },
};

function platformLabel(platform: NativeDiagnostics['platform']): string {
  if (platform === 'darwin') {
    return 'macOS';
  }
  if (platform === 'win32') {
    return 'Windows';
  }
  return platform === 'linux' ? 'Linux' : 'Unsupported platform';
}

function checkDetail(code: NativeDiagnosticCode | undefined): string {
  if (code === undefined) {
    return 'Available to the native OpenCoven boundary.';
  }
  return ERROR_COPY[code].detail;
}

export function presentDiagnostics(diagnostics: NativeDiagnostics): PresentedDiagnostics {
  return {
    platform: `${platformLabel(diagnostics.platform)} · ${diagnostics.architecture}`,
    checks: diagnostics.checks.map((check) => ({
      label: COMPONENT_LABELS[check.component],
      status: check.status === 'available' ? 'Available' : 'Unavailable',
      detail: checkDetail(check.code),
    })),
  };
}

export function presentError(error: unknown): PresentedError {
  if (error instanceof NativeBoundaryError) {
    const copy = ERROR_COPY[error.code];
    return {
      ...copy,
      diagnosticId: error.diagnosticId,
    };
  }
  return {
    ...ERROR_COPY.service_unavailable,
    diagnosticId: 'local-diagnostic',
  };
}

export function presentErrorCode(code: string, diagnosticId: string): PresentedError {
  const copy = Object.hasOwn(ERROR_COPY, code)
    ? ERROR_COPY[code as NativeDiagnosticCode]
    : {
        title: 'Connection needs attention',
        detail: 'Reconnect to verify the local OpenCoven service.',
      };
  return {
    ...copy,
    diagnosticId,
  };
}

export function presentConnectionState(state: string): string {
  switch (state) {
    case 'idle':
      return 'Not connected';
    case 'discovering':
      return 'Finding OpenCoven';
    case 'incompatible':
      return 'Update required';
    case 'pairing_required':
      return 'Approval required';
    case 'pairing':
      return 'Waiting for approval';
    case 'ready':
      return 'Connected';
    case 'revoked':
      return 'Access revoked';
    case 'offline':
      return 'Offline';
    default:
      return 'Needs attention';
  }
}
