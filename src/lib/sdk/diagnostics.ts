export type NativeSdkDiagnostic = Readonly<{
  code: 'service_unavailable' | 'invalid_response';
  retryable: boolean;
  message: string;
}>;

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
