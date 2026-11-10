// The packaged suite's deterministic model stand-in, plus two replies the
// native lane needs: one that streams slowly enough to cancel a real run while
// it is still going (#504 row 7), and one carrying an address with a user name,
// which the review must refuse to open (#515). It also serves the packaged
// suite's approval script (`approvalStep`), which asks the real engine to write a
// real file, so the engine and not this fixture decides what each turn may do.
// Every word is synthetic.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  ADDRESSES,
  APPROVAL_DONE,
  APPROVAL_NO_NOTE,
  APPROVAL_REFUSED,
  APPROVAL_SUMMARY,
  APPROVAL_UNASKED,
  approvalStep,
  replyFor as packagedReply,
  streamStep,
  TABLE,
} from '../packaged-acceptance/model-fixture.mjs';

export {
  ADDRESSES,
  APPROVAL_DONE,
  APPROVAL_NO_NOTE,
  APPROVAL_REFUSED,
  APPROVAL_SUMMARY,
  APPROVAL_UNASKED,
  TABLE,
};
export const USERINFO = 'https://name@example.com/';
/** The heading of an ordinary reply to a message sent while a request waits (#573). */
export const MOVED_ON = 'Moving on';
export const SLOW_LINES = 120;

const EXTRA = {
  reviewrace: `A held reply.\n\n[Completion boundary](${ADDRESSES.query})`,
  userinfo: `One more address.\n\n- [Named login](${USERINFO})`,
  moveon: `## ${MOVED_ON}\n\nNothing to write.`,
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

/**
 * The newest token decides, as in the packaged fixture. Chat replays a chat's
 * recent turns ahead of each message (`build_replay`), so an older turn's token
 * can sit behind this message's own. `askAt` is where the newest `[[ask …]]`
 * starts: an allowed turn's own words carry no token, so the request it answers
 * reaches the fixture only through the replay.
 */
export function newestToken(messages) {
  const text = lastText(messages);
  const native = [
    ...text.matchAll(/\[\[(links|table|other|slow|userinfo|reviewrace|moveon)\]\]/g),
  ].at(-1);
  return { token: native?.[1], at: native?.index ?? -1, askAt: text.lastIndexOf('[[ask ') };
}

function events(res, model) {
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
  const delta = (text) =>
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
  const finish = () => {
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };
  return { delta, finish };
}

/** Starts the endpoint on 127.0.0.1 and resolves to { port, close }. */
export function startModelFixture({ log } = {}) {
  const heldReviews = new Set();
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
      const isMessage = req.method === 'POST' && path === '/v1/messages';
      const newest = newestToken(parsed.messages);
      const askWins = !newest.token || newest.askAt > newest.at;
      const step = isMessage && askWins ? approvalStep(parsed.messages) : undefined;
      const token = step ? 'ask' : newest.token;
      if (log) {
        // `step` says what an approval turn was served: `write` is a real Write
        // call for the engine to run or refuse, `text` the turn's closing reply.
        const served = step ? { step: step.tool ? 'write' : 'text' } : {};
        appendFileSync(
          log,
          `${JSON.stringify({ at: Date.now(), method: req.method, path, token: token ?? null, ...served })}\n`,
        );
      }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: 'Not served.' },
          }),
        );
        return;
      }
      if (step) {
        if (parsed.stream) {
          streamStep(res, parsed.model, step);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: step.tool
              ? [
                  {
                    type: 'tool_use',
                    id: `toolu_fixture_${Date.now()}`,
                    name: step.tool.name,
                    input: step.tool.input,
                  },
                ]
              : [{ type: 'text', text: step.text }],
            stop_reason: step.tool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      const text = EXTRA[token] ?? packagedReply(parsed.messages);
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [{ type: 'text', text: token === 'slow' ? 'Slow reply.' : text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      const stream = events(res, parsed.model);
      if (token === 'reviewrace') {
        // No timer releases this reply: the native lane first observes its
        // review, then explicitly permits the real engine process to finish.
        stream.delta(text);
        heldReviews.add(stream.finish);
        res.on('close', () => heldReviews.delete(stream.finish));
        return;
      }
      if (token !== 'slow') {
        stream.delta(text);
        stream.finish();
        return;
      }
      // One line a second for two minutes: a run that is plainly still going
      // when the lane presses Stop run. A closed connection ends it early.
      let line = 0;
      const timer = setInterval(() => {
        line += 1;
        if (res.destroyed || line > SLOW_LINES) {
          clearInterval(timer);
          if (!res.destroyed) stream.finish();
          return;
        }
        stream.delta(`Slow line ${line}.\n\n`);
      }, 1_000);
      res.on('close', () => clearInterval(timer));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        finishReview: () => {
          const pending = [...heldReviews];
          heldReviews.clear();
          for (const finish of pending) finish();
          return pending.length;
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
