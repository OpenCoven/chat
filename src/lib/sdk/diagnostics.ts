export type NativeSdkDiagnostic = Readonly<{
  code: 'native_unavailable' | 'invalid_native_result';
  retryable: boolean;
  message: string;
}>;

const SECRET_FIELD = /(?:bearer|secret|authorization|cookie|token|header)/iu;
const MAX_NODES = 4_096;
const MAX_STRING_LENGTH = 64 * 1024;

function invalidNativeResult(): never {
  const diagnostic: NativeSdkDiagnostic = {
    code: 'invalid_native_result',
    retryable: false,
    message: 'Native Cave result was invalid.',
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
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          descriptors[key] === undefined ||
          !Object.hasOwn(descriptors[key], 'value'),
      )
    ) {
      return invalidNativeResult();
    }

    if (Array.isArray(candidate)) {
      const expected = new Set([
        'length',
        ...Array.from({ length: candidate.length }, (_, index) => String(index)),
      ]);
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !expected.has(key))
      ) {
        return invalidNativeResult();
      }
      return Object.freeze(candidate.map(snapshot));
    }

    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (SECRET_FIELD.test(key) || !Object.hasOwn(descriptor, 'value')) {
        return invalidNativeResult();
      }
      output[key] = snapshot(descriptor.value);
    }
    return Object.freeze(output);
  }

  return snapshot(value);
}

export function nativeUnavailable(): NativeSdkDiagnostic {
  return Object.freeze({
    code: 'native_unavailable',
    retryable: true,
    message: 'Native Cave operation was unavailable.',
  });
}
