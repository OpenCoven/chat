// A local, deterministic stand-in for the Anthropic Messages API. The packaged
// suite points coven-code at it with ANTHROPIC_BASE_URL, so every run is real:
// packaged Chat starts the installed Coven CLI, which starts the engine, which
// streams this reply back through Chat's own capture. Only the model's words are
// fixed. Model-provider behaviour is therefore outside what this suite proves.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';

export const ADDRESSES = {
  query: 'https://example.com/handoff-check?x=1',
  plain: 'http://example.com/',
  ipv6: 'https://[::1]:8080/x',
};

export const TABLE = [
  '| Field | Link |',
  '| :-- | --: |',
  '| a \\| b | [Guide](https://docs.example.test/guide) |',
  `| ${'wide-'.repeat(60)} | \`c|d\` *é* |`,
].join('\n');

const REPLIES = {
  links: [
    'The plan has three steps.',
    '',
    'First, read the source.',
    '',
    `- [Handoff check](${ADDRESSES.query})`,
    `- [Plain address](${ADDRESSES.plain})`,
    `- [Loopback six](${ADDRESSES.ipv6})`,
  ].join('\n'),
  table: `Here it is.\n\n${TABLE}\n\nDone.`,
  other: 'Second familiar here.',
};

function lastText(messages) {
  for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/** Chat replays earlier turns into each prompt, so the newest token decides. */
export function replyFor(messages) {
  const tokens = [...lastText(messages).matchAll(/\[\[(links|table|other)\]\]/g)];
  const token = tokens.at(-1)?.[1];
  return token ? REPLIES[token] : 'Fixture reply.';
}

export const APPROVAL_SUMMARY = 'Write the proof file';
export const APPROVAL_DONE = 'The proof file is written.';
/** Lowercase hex keeps path bytes intact through WebKitWebDriver key input. */
export function writeProofPrompt(path, request) {
  return `[[write ${Buffer.from(path, 'utf8').toString('hex')}]] ${request}`;
}

/** The allowed turn's reply when the engine refused the write anyway. */
export const APPROVAL_REFUSED = 'The engine refused the write:';
/** A heading, so a row can wait for it: this turn's prompt carried no note from Chat. */
export const APPROVAL_NO_NOTE = 'Chat sent no permission note';
/** A heading over a request block that Chat never asked for. */
export const APPROVAL_UNASKED = 'A request nobody asked for';
const REQUEST_BLOCK = [
  '```coven-permission-request',
  JSON.stringify({ summary: APPROVAL_SUMMARY, reason: 'The engine refused it read-only.' }),
  '```',
].join('\n');

function resultText(result) {
  const text =
    typeof result.content === 'string'
      ? result.content
      : (result.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** The newest message a person (or Chat, for them) wrote, past any tool results. */
function lastPrompt(messages) {
  for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
    const text = lastText([messages[index]]);
    if (text) return text;
  }
  return '';
}

/**
 * The approval row's script. It asks the real engine to write a real file on
 * both turns, so the engine, not this fixture, decides what read-only means. The
 * request block goes out only if Chat's note reached the engine, and the write
 * on the allowed turn only if Chat said that turn has access.
 */
export function approvalStep(messages) {
  const prompt = lastPrompt(messages);
  const request = [...prompt.matchAll(/\[\[(ask|write) (\S+)\]\]/g)].at(-1);
  if (!request) return undefined;
  const [, operation, path] = request;
  if (operation === 'write' && !/^(?:[0-9a-f]{2})+$/.test(path)) return undefined;
  const proof = operation === 'write' ? Buffer.from(path, 'hex').toString('utf8') : path;
  if (!isAbsolute(proof)) return undefined;
  const last = messages.at(-1)?.content;
  const result = Array.isArray(last)
    ? last.find((block) => block?.type === 'tool_result')
    : undefined;
  const allowed = prompt.includes('This turn has write access');
  if (!result) {
    return { tool: { name: 'Write', input: { file_path: proof, content: 'allowed turn\n' } } };
  }
  // Say what the engine said, so a refused write reads as one, not as success.
  if (allowed && result.is_error) return { text: `${APPROVAL_REFUSED} ${resultText(result)}` };
  if (allowed) return { text: APPROVAL_DONE };
  // A familiar can write the block without being told how, so the default access row
  // sends one whatever Chat's note said.
  if (prompt.includes('[[request anyway]]')) {
    return { text: `## ${APPROVAL_UNASKED}\n\n${REQUEST_BLOCK}` };
  }
  return {
    text: prompt.includes('coven-permission-request')
      ? `I need write access for that.\n\n${REQUEST_BLOCK}`
      : `## ${APPROVAL_NO_NOTE}`,
  };
}

function stream(res, model, { text, tool }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: tool
      ? { type: 'tool_use', id: `toolu_fixture_${Date.now()}`, name: tool.name, input: {} }
      : { type: 'text', text: '' },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
      : { type: 'text_delta', text },
  });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

export function sendModelStep(res, model, step, streaming) {
  const { text } = step;
  if (streaming) {
    stream(res, model, step);
  } else if (step.tool) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: model,
        content: [
          {
            type: 'tool_use',
            id: `toolu_fixture_${Date.now()}`,
            name: step.tool.name,
            input: step.tool.input,
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  }
}

/** Starts the endpoint on 127.0.0.1 and resolves to { port, close }. */
export function startModelFixture({ port = 0, log } = {}) {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        parsed = {};
      }
      const path = (req.url ?? '').split('?')[0];
      if (log) {
        appendFileSync(log, `${JSON.stringify({ at: Date.now(), method: req.method, path })}\n`);
      }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const step = approvalStep(parsed.messages) ?? { text: replyFor(parsed.messages) };
        sendModelStep(res, parsed.model, step, parsed.stream);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'Not served by the fixture.' },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
