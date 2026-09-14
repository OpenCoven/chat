import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, readAttachments } from './attachments';

function file(name: string, bytes: Uint8Array) {
  const selected = new File([], name);
  Object.defineProperties(selected, {
    size: { value: bytes.length },
    arrayBuffer: { value: async () => bytes.buffer },
  });
  return selected;
}

describe('real text attachment selection', () => {
  it('returns original bytes, not a fabricated upload URL', async () => {
    const bytes = new TextEncoder().encode('real text\n<>&');
    const [result] = await readAttachments([file('notes.txt', bytes)]);
    expect(result).toEqual({ id: expect.any(String), name: 'notes.txt', bytes: [...bytes] });
  });

  it('rejects binary types, invalid UTF-8, nul bytes, oversized files and excess count', async () => {
    await expect(readAttachments([file('image.png', new Uint8Array([1]))])).rejects.toThrow(
      'not supported',
    );
    await expect(readAttachments([file('a.txt', new Uint8Array([255]))])).rejects.toThrow('UTF-8');
    await expect(readAttachments([file('a.txt', new Uint8Array([0]))])).rejects.toThrow('binary');
    await expect(
      readAttachments([file('a.txt', new Uint8Array(MAX_ATTACHMENT_BYTES + 1))]),
    ).rejects.toThrow('64 KiB');
    await expect(
      readAttachments(Array.from({ length: 5 }, () => file('a.txt', new Uint8Array()))),
    ).rejects.toThrow('4 files');
  });
});
