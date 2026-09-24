import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_TITLE, setWindowTitle, windowTitle } from './window-title';

const setTitle = vi.hoisted(() => vi.fn());
const describeWindow = vi.hoisted(() => ({ missing: false }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => {
    if (describeWindow.missing) throw new TypeError('metadata is undefined');
    return { setTitle };
  },
}));

describe('windowTitle', () => {
  it('names the familiar, and counts runs that ended elsewhere', () => {
    expect(windowTitle(undefined, 0)).toBe(APP_TITLE);
    expect(windowTitle('Astra', 0)).toBe('Astra — OpenCoven Chat');
    expect(windowTitle('Astra', 2)).toBe('(2) Astra — OpenCoven Chat');
    expect(windowTitle(undefined, 1)).toBe('(1) OpenCoven Chat');
  });
});

describe('setWindowTitle', () => {
  afterEach(() => {
    setTitle.mockReset();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('sets only the document title outside the desktop host', () => {
    setWindowTitle('Astra — OpenCoven Chat');
    expect(document.title).toBe('Astra — OpenCoven Chat');
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('sets the native title too inside the host, and logs a refusal', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTitle.mockRejectedValueOnce(new Error('not allowed'));
    setWindowTitle('Bram — OpenCoven Chat');
    expect(setTitle).toHaveBeenCalledWith('Bram — OpenCoven Chat');
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });

  it('never throws when the host has not described the window', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    describeWindow.missing = true;
    try {
      expect(() => setWindowTitle('Cass — OpenCoven Chat')).not.toThrow();
      expect(document.title).toBe('Cass — OpenCoven Chat');
      expect(error).toHaveBeenCalled();
    } finally {
      describeWindow.missing = false;
      error.mockRestore();
    }
  });
});
