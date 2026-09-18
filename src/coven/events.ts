import type { CovenRunEvent } from '../lib/coven-runtime';
import type { AttachmentMetadata } from './attachments';

export type ChatMessage = {
  id: string;
  role: string;
  text: string;
  attachments?: AttachmentMetadata[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectEvents(events: readonly CovenRunEvent[]): {
  sessionId: string;
  error: string;
  messages: ChatMessage[];
} {
  let sessionId = '';
  let error = '';
  const messages: ChatMessage[] = [];
  let deltaMessage: (typeof messages)[number] | undefined;
  let deltaSession: unknown;
  for (const [index, event] of events.entries()) {
    if (event.type === 'text_delta' && typeof event.text === 'string') {
      if (!event.text) continue;
      if (!deltaMessage || deltaSession !== event.session_id) {
        deltaMessage = { id: String(index), role: 'assistant', text: '' };
        deltaSession = event.session_id;
        messages.push(deltaMessage);
      }
      deltaMessage.text += event.text;
      continue;
    }
    deltaMessage = undefined;
    if (event.type === 'output' && typeof event.text === 'string' && event.text) {
      messages.push({ id: String(index), role: 'output', text: event.text });
    }
    if ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
    }
    if (event.type === 'result' && event.is_error === true) {
      error =
        typeof event.error === 'string'
          ? event.error
          : 'Coven reported a failed run. Inspect the session with the Coven CLI for details.';
    }
    const importedSystem = event.type === 'system' && event.source === 'cave-import';
    // Chat's own disclosure that a turn carried replayed history (see
    // `replay_notice` in the Rust backend); it renders as a plain notice line.
    const replayNotice =
      event.type === 'system' && event.subtype === 'notice' && event.source === 'chat-replay';
    if (
      (event.type !== 'user' && event.type !== 'assistant' && !importedSystem && !replayNotice) ||
      !record(event.message)
    )
      continue;
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => record(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      // Assistant blocks are Markdown; a blank line keeps them as paragraphs.
      .join(event.type === 'assistant' ? '\n\n' : '\n');
    const attachments =
      event.type === 'user' && Array.isArray(event.attachments)
        ? event.attachments
            .filter(
              (file): file is AttachmentMetadata =>
                record(file) &&
                typeof file.name === 'string' &&
                file.name.length <= 180 &&
                typeof file.size === 'number' &&
                Number.isInteger(file.size) &&
                file.size >= 0 &&
                file.size <= 64 * 1024,
            )
            .slice(0, 4)
            .map(({ name, size }) => ({ name, size }))
        : [];
    if (text || attachments.length)
      messages.push({
        id: String(index),
        role: replayNotice ? 'notice' : event.type,
        text,
        ...(attachments.length ? { attachments } : {}),
      });
  }
  return { sessionId, error, messages };
}
