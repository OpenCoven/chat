// A local, deterministic stand-in for the Anthropic Messages API. The packaged
// suite points coven-code at it with ANTHROPIC_BASE_URL, so every run is real:
// packaged Chat starts the installed Coven CLI, which starts the engine, which
// streams this reply back through Chat's own capture. Only the model's words are
// fixed. Model-provider behaviour is therefore outside what this suite proves.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

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

function stream(res, model, text) {
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
    content_block: { type: 'text', text: '' },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
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
        const text = replyFor(parsed.messages);
        if (parsed.stream) {
          stream(res, parsed.model, text);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: parsed.model,
              content: [{ type: 'text', text }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        }
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
