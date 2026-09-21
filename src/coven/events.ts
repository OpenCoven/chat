import type { CovenRunEvent } from '../lib/coven-runtime';
import type { AttachmentMetadata } from './attachments';

/**
 * A tool call the runtime reported as data rather than prose. `args` is the
 * one-line summary shown in the row; `raw` is the full input for the details.
 * `result` arrives later, from a `tool_result` frame matched by `id`, or from a
 * `tool_end` matched by id or name.
 */
export type ToolCall = {
  id?: string;
  name: string;
  args: string;
  raw?: string;
  result?: string;
  isError?: boolean;
};

export type ChatMessage = {
  id: string;
  role: string;
  text: string;
  attachments?: AttachmentMetadata[];
  tool?: ToolCall;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text carried by a content field that is either a string or an array of text blocks. */
function contentText(content: unknown, separator: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => record(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(separator);
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];
const SUMMARY_LIMIT = 80;
const RAW_LIMIT = 16 * 1024;

/**
 * The one-line argument summary uses the same key preference as the engine's
 * own `⚒ Name(arg)` notice, so a structured call reads like a prose one.
 */
export function summarizeToolInput(input: unknown): { args: string; raw: string } {
  const raw = input === undefined ? '' : JSON.stringify(input, null, 2).slice(0, RAW_LIMIT);
  if (!record(input))
    return { args: raw.length > SUMMARY_LIMIT ? `${raw.slice(0, SUMMARY_LIMIT)}…` : raw, raw };
  const preferred = SUMMARY_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  const line =
    preferred?.split('\n')[0] ?? (Object.keys(input).length ? JSON.stringify(input) : '');
  const args = line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}…` : line;
  return { args, raw };
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
  const toolCall = (id: string, name: string, input: unknown, toolUseId?: string): ChatMessage => {
    const summary = summarizeToolInput(input);
    return {
      id,
      role: 'tool',
      text: name,
      tool: {
        ...(toolUseId ? { id: toolUseId } : {}),
        name,
        args: summary.args,
        ...(summary.raw ? { raw: summary.raw } : {}),
      },
    };
  };
  const settle = (match: (tool: ToolCall) => boolean, result: string, isError: boolean) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const tool = messages[index]?.tool;
      if (tool && tool.result === undefined && match(tool)) {
        tool.result = result;
        if (isError) tool.isError = true;
        return;
      }
    }
  };
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
    // coven-code reports a tool it runs itself as `tool_start` with the name
    // only in `--print` mode; the bridge shape adds `tool_name`, `tool_id` and
    // `input`. A tool call ends the current run of prose either way.
    if (event.type === 'tool_start') {
      const name = typeof event.tool === 'string' ? event.tool : event.tool_name;
      if (typeof name !== 'string' || !name) continue;
      deltaMessage = undefined;
      messages.push(
        toolCall(
          String(index),
          name,
          event.input,
          typeof event.tool_id === 'string' ? event.tool_id : undefined,
        ),
      );
      continue;
    }
    if (event.type === 'tool_end') {
      const name = typeof event.tool_name === 'string' ? event.tool_name : '';
      const id = typeof event.tool_id === 'string' ? event.tool_id : '';
      settle(
        (tool) => (id ? tool.id === id : tool.name === name),
        typeof event.result === 'string' ? event.result : contentText(event.result, '\n'),
        event.is_error === true,
      );
      continue;
    }
    // The Coven CLI protocol's tool outcome frame, keyed by the tool_use id.
    if (event.type === 'tool_result' && typeof event.tool_use_id === 'string') {
      const id = event.tool_use_id;
      settle((tool) => tool.id === id, contentText(event.content, '\n'), event.is_error === true);
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
    if (event.type === 'assistant') {
      // Text blocks join as Markdown paragraphs; a tool_use block between them
      // splits the prose so the row sits where the call happened.
      let text: string[] = [];
      let part = 0;
      // The first piece keeps the event's own id so a plain text reply is
      // addressed exactly as before; later pieces are numbered within it.
      const nextId = () => (part++ === 0 ? String(index) : `${index}-${part - 1}`);
      const flush = () => {
        if (text.length)
          messages.push({ id: nextId(), role: 'assistant', text: text.join('\n\n') });
        text = [];
      };
      for (const block of content) {
        if (!record(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
          flush();
          messages.push(
            toolCall(
              nextId(),
              block.name,
              block.input,
              typeof block.id === 'string' ? block.id : undefined,
            ),
          );
        }
      }
      flush();
      continue;
    }
    // A Claude Code harness returns tool outcomes as tool_result blocks inside
    // a user frame; they settle the matching row and are never shown as text.
    if (event.type === 'user') {
      for (const block of content) {
        if (
          record(block) &&
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string'
        ) {
          const id = block.tool_use_id;
          settle(
            (tool) => tool.id === id,
            contentText(block.content, '\n'),
            block.is_error === true,
          );
        }
      }
    }
    const text = contentText(content, '\n');
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
