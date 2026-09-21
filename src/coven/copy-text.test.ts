import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copy-text';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard when the webview offers it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to the legacy command when the async clipboard is missing or refuses', async () => {
    stubClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    await expect(copyText('legacy')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();

    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(copyText('again')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(2);
  });

  it('reports failure instead of claiming success when neither path works', async () => {
    stubClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    await expect(copyText('nope')).resolves.toBe(false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
    await expect(copyText('nope')).resolves.toBe(false);
  });
});
