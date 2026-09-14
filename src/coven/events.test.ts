import { describe, expect, it } from 'vitest';
import { projectEvents } from './events';

describe('genuine Coven event projection', () => {
  it('preserves explicitly imported Cave system text without displaying runtime system metadata', () => {
    const message = { role: 'system', content: [{ type: 'text', text: 'Cave system notice' }] };
    expect(
      projectEvents([
        { type: 'system', source: 'cave-import', message },
        { type: 'system', subtype: 'init', message },
      ]).messages,
    ).toEqual([{ id: '0', role: 'system', text: 'Cave system notice' }]);
  });
  it('restores attachment-only history metadata without exposing bytes or trusting invalid entries', () => {
    expect(
      projectEvents([
        {
          type: 'user',
          source: 'chat-input',
          message: { role: 'user', content: [{ type: 'text', text: '' }] },
          attachments: [
            { name: 'notes.txt', size: 10 },
            { name: 'bad.txt', size: -1 },
            { name: 'huge.txt', size: 65537 },
            { name: 123, size: 2 },
          ],
        },
      ]).messages,
    ).toEqual([
      {
        id: '0',
        role: 'user',
        text: '',
        attachments: [{ name: 'notes.txt', size: 10 }],
      },
    ]);
  });
  it('accumulates genuine coven-code text deltas into one assistant message per run', () => {
    expect(
      projectEvents([
        { type: 'system', subtype: 'init', session_id: 'first' },
        { type: 'text_delta', session_id: 'first', text: 'Hello' },
        { type: 'text_delta', session_id: 'first', text: ' world' },
        { type: 'result', session_id: 'first', cost_usd: 0 },
        { type: 'result', session_id: 'first', is_error: false },
        { type: 'system', subtype: 'init', session_id: 'second' },
        { type: 'text_delta', session_id: 'second', text: 'Next response' },
      ]).messages,
    ).toEqual([
      { id: '1', role: 'assistant', text: 'Hello world' },
      { id: '6', role: 'assistant', text: 'Next response' },
    ]);
  });

  it('renders only actual user/assistant text blocks and extracts the session identity', () => {
    expect(
      projectEvents([
        { type: 'system', subtype: 'init', session_id: 'new-session' },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'Actual request' }] },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Actual answer' },
              { type: 'tool_use', name: 'shell' },
            ],
          },
        },
        { type: 'tool', content: 'not an assistant message' },
      ]),
    ).toEqual({
      sessionId: 'new-session',
      error: '',
      messages: [
        { id: '1', role: 'user', text: 'Actual request' },
        { id: '2', role: 'assistant', text: 'Actual answer' },
      ],
    });
  });

  it('keeps consecutive assistant text blocks as separate paragraphs while user text stays literal', () => {
    expect(
      projectEvents([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First thought' },
              { type: 'tool_use', name: 'shell' },
              { type: 'text', text: 'Second thought' },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        },
      ]).messages,
    ).toEqual([
      { id: '0', role: 'assistant', text: 'First thought\n\nSecond thought' },
      { id: '1', role: 'user', text: 'line one\nline two' },
    ]);
  });

  it('surfaces run failure and never turns metadata or unknown data into a reply', () => {
    const result = projectEvents([
      { type: 'assistant', message: { content: [{ type: 'image', source: 'unknown' }] } },
      { type: 'result', is_error: true, error: 'Credentials missing', session_id: 's' },
    ]);
    expect(result.error).toBe('Credentials missing');
    expect(result.messages).toEqual([]);
  });

  it('shows older CLI output without pretending it is an assistant message', () => {
    expect(
      projectEvents([
        { type: 'output', text: 'Recorded CLI output', session_id: 'old' },
        { type: 'recorded', kind: 'unknown', payload: { text: 'not chat text' } },
      ]).messages,
    ).toEqual([{ id: '0', role: 'output', text: 'Recorded CLI output' }]);
  });
});
