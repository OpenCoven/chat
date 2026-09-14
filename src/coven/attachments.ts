export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 4;
export const ATTACHMENT_ACCEPT =
  '.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rs,.go,.sh,.log,.toml';
export type ChatAttachment = { id: string; name: string; bytes: number[] };
export type AttachmentMetadata = { name: string; size: number };

export async function readAttachments(files: readonly File[]): Promise<ChatAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw new Error('Attach at most 4 files per message.');
  return Promise.all(
    files.map(async (file) => {
      if (
        new TextEncoder().encode(file.name).length > 180 ||
        /[\\/:]/.test(file.name) ||
        Array.from(file.name).some(
          (char) =>
            char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        )
      ) {
        throw new Error(
          'Attachment names must be at most 180 UTF-8 bytes without path separators or control characters.',
        );
      }
      if (!/\.(txt|md|csv|json|ya?ml|xml|html|css|[jt]sx?|py|rs|go|sh|log|toml)$/i.test(file.name))
        throw new Error(
          'Only UTF-8 text/code files are supported. Images, PDFs and other binary files are not supported by this Coven engine.',
        );
      if (file.size > MAX_ATTACHMENT_BYTES)
        throw new Error(`${file.name}: maximum attachment size is 64 KiB.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_ATTACHMENT_BYTES)
        throw new Error(`${file.name}: maximum attachment size is 64 KiB.`);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`${file.name}: attachment must contain valid UTF-8 text.`);
      }
      if (bytes.includes(0)) throw new Error(`${file.name}: binary content is not supported.`);
      return { id: crypto.randomUUID(), name: file.name, bytes: Array.from(bytes) };
    }),
  );
}
