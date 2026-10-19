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

  it('copies from inside the dialog the reader is in, where a modal leaves the page inert', async () => {
    stubClipboard(undefined);
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    const seen: { tag?: string; inDialog?: boolean; selected?: string } = {};
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        const active = document.activeElement;
        if (active) seen.tag = active.tagName;
        seen.inDialog = Boolean(active?.closest('dialog') === dialog);
        if (active instanceof HTMLTextAreaElement)
          seen.selected = active.value.slice(active.selectionStart, active.selectionEnd);
        return true;
      }),
    });
    try {
      await expect(copyText('https://example.com/docs')).resolves.toBe(true);
      expect(seen).toEqual({
        tag: 'TEXTAREA',
        inDialog: true,
        selected: 'https://example.com/docs',
      });
      expect(document.activeElement).toBe(button);
      expect(dialog.querySelector('textarea')).toBeNull();
    } finally {
      dialog.remove();
    }
  });

  it('reports failure when the copy target cannot take focus, whatever the command says', async () => {
    stubClipboard(undefined);
    vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(() => {});
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(() => {});
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    await expect(copyText('https://example.com/docs')).resolves.toBe(false);
  });
});
