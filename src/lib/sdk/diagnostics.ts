export type NativeSdkDiagnosticCode =
  | 'aborted'
  | 'body_limit'
  | 'conflict'
  | 'credential_update_in_progress'
  | 'incompatible_version'
  | 'internal_error'
  | 'invalid_request'
  | 'invalid_response'
  | 'not_found'
  | 'pairing_denied'
  | 'pairing_expired'
  | 'pairing_pending'
  | 'rate_limited'
  | 'reconcile_required'
  | 'scope_denied'
  | 'service_unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported_operation';

export type NativeSdkDiagnostic = Readonly<{
  code: NativeSdkDiagnosticCode;
  retryable: boolean;
  message: string;
}>;

const SAFE_NATIVE_DIAGNOSTIC_CODES = new Set<NativeSdkDiagnosticCode>([
  'aborted',
  'body_limit',
  'conflict',
  'credential_update_in_progress',
  'incompatible_version',
  'internal_error',
  'invalid_request',
  'invalid_response',
  'not_found',
  'pairing_denied',
  'pairing_expired',
  'pairing_pending',
  'rate_limited',
  'reconcile_required',
  'scope_denied',
  'service_unavailable',
  'timeout',
  'unauthorized',
  'unsupported_operation',
]);
const FORBIDDEN_NATIVE_FIELD = /(?:bearer|secret|authorization|cookie|token|header|cause|path)/iu;
const MAX_NODES = 4_096;
const MAX_STRING_LENGTH = 64 * 1024;

function invalidNativeResult(): never {
  const diagnostic: NativeSdkDiagnostic = {
    code: 'invalid_response',
    retryable: false,
    message: 'Cave response was invalid.',
  };
  throw Object.freeze(diagnostic);
}

export function snapshotNativeResult(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let strings = 0;

  function snapshot(candidate: unknown): unknown {
    nodes += 1;
    if (nodes > MAX_NODES) {
      return invalidNativeResult();
    }

    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number') {
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
        return invalidNativeResult();
      }
      return candidate;
    }

    if (typeof candidate === 'string') {
      strings += candidate.length;
      if (strings > MAX_STRING_LENGTH) {
        return invalidNativeResult();
      }
      return candidate;
    }

    if (typeof candidate !== 'object' || seen.has(candidate)) {
      return invalidNativeResult();
    }

    seen.add(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);

    if (Array.isArray(candidate)) {
      const lengthDescriptor = descriptors.length;
      if (
        prototype !== Array.prototype ||
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        typeof lengthDescriptor.value !== 'number' ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return invalidNativeResult();
      }
      const length = lengthDescriptor.value;
      if (
        length > MAX_NODES - nodes ||
        keys.length !== length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length),
        )
      ) {
        return invalidNativeResult();
      }

      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
          return invalidNativeResult();
        }
        output.push(snapshot(descriptor.value));
      }
      return Object.freeze(output);
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return invalidNativeResult();
    }

    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') {
        return invalidNativeResult();
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        FORBIDDEN_NATIVE_FIELD.test(key) ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return invalidNativeResult();
      }
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: snapshot(descriptor.value),
        writable: false,
      });
    }
    return Object.freeze(output);
  }

  try {
    return snapshot(value);
  } catch {
    return invalidNativeResult();
  }
}

export function nativeUnavailable(): NativeSdkDiagnostic {
  return Object.freeze({
    code: 'service_unavailable',
    retryable: true,
    message: 'Cave service was unavailable.',
  });
}

function diagnosticMessage(code: NativeSdkDiagnosticCode): string {
  switch (code) {
    case 'aborted':
      return 'Cave request was aborted.';
    case 'body_limit':
      return 'Cave response exceeded its size limit.';
    case 'reconcile_required':
      return 'Cave authority proof failed.';
    case 'timeout':
      return 'Cave request timed out.';
    case 'service_unavailable':
      return 'Cave service was unavailable.';
    default:
      return 'Cave request failed.';
  }
}

export function snapshotNativeDiagnostic(value: unknown): NativeSdkDiagnostic {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return nativeUnavailable();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return nativeUnavailable();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const codeDescriptor = descriptors.code;
    const retryableDescriptor = descriptors.retryable;
    const rawCode =
      codeDescriptor !== undefined && Object.hasOwn(codeDescriptor, 'value')
        ? codeDescriptor.value
        : undefined;
    const rawRetryable =
      retryableDescriptor !== undefined && Object.hasOwn(retryableDescriptor, 'value')
        ? retryableDescriptor.value
        : undefined;
    const retryable = rawRetryable === true;
    if (
      typeof rawCode !== 'string' ||
      !SAFE_NATIVE_DIAGNOSTIC_CODES.has(rawCode as NativeSdkDiagnosticCode)
    ) {
      return nativeUnavailable();
    }
    const code = rawCode as NativeSdkDiagnosticCode;
    return Object.freeze({
      code,
      retryable,
      message: diagnosticMessage(code),
    });
  } catch {
    return nativeUnavailable();
  }
}
