import { normalizeRejectionMessage } from './rejection-message';

const FALLBACK_MESSAGE = 'The native app_identity command failed.';

describe('normalizeRejectionMessage', () => {
  it('returns a non-empty string rejection', () => {
    expect(normalizeRejectionMessage(' invoke failed: raw string ', FALLBACK_MESSAGE)).toBe(
      'invoke failed: raw string',
    );
  });

  it('returns a non-empty message property from an object payload', () => {
    expect(
      normalizeRejectionMessage(
        { message: ' invoke failed: serialized payload ', code: 'E_NATIVE' },
        FALLBACK_MESSAGE,
      ),
    ).toBe('invoke failed: serialized payload');
  });

  it('returns an Error message', () => {
    expect(
      normalizeRejectionMessage(
        new Error(' invoke failed: missing handler ', {
          cause: { message: 'secret cause should stay hidden' },
        }),
        FALLBACK_MESSAGE,
      ),
    ).toBe('invoke failed: missing handler');
  });

  it('falls back for unknown payloads without exposing object contents', () => {
    expect(
      normalizeRejectionMessage({ code: 'E_NATIVE', secret: 'hidden' }, FALLBACK_MESSAGE),
    ).toBe(FALLBACK_MESSAGE);
    expect(normalizeRejectionMessage(['invoke failed'], FALLBACK_MESSAGE)).toBe(FALLBACK_MESSAGE);
    expect(normalizeRejectionMessage('   ', FALLBACK_MESSAGE)).toBe(FALLBACK_MESSAGE);
  });
});
