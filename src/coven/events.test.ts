import { describe, expect, it } from 'vitest';
import { projectEvents, RAW_LIMIT, RAW_TRUNCATED, summarizeToolInput } from './events';

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
  it('shows the replay disclosure as a notice and hides other runtime system frames', () => {
    const message = {
      role: 'system',
      content: [{ type: 'text', text: 'Chat replayed the last 2 turns into this message.' }],
    };
    expect(
      projectEvents([
        { type: 'system', subtype: 'init', session_id: 'run' },
        { type: 'system', subtype: 'notice', source: 'chat-replay', session_id: 'run', message },
        { type: 'system', subtype: 'notice', session_id: 'run', message },
        { type: 'text_delta', session_id: 'run', text: 'Reply' },
      ]).messages,
    ).toEqual([
      { id: '1', role: 'notice', text: 'Chat replayed the last 2 turns into this message.' },
      { id: '3', role: 'assistant', text: 'Reply' },
    ]);
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
        { id: '2-1', role: 'tool', text: 'shell', tool: { name: 'shell', args: '' } },
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
      { id: '0', role: 'assistant', text: 'First thought' },
      { id: '0-1', role: 'tool', text: 'shell', tool: { name: 'shell', args: '' } },
      { id: '0-2', role: 'assistant', text: 'Second thought' },
      { id: '1', role: 'user', text: 'line one\nline two' },
    ]);
  });

  it('joins uninterrupted assistant text blocks as paragraphs', () => {
    expect(
      projectEvents([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First thought' },
              { type: 'text', text: 'Second thought' },
            ],
          },
        },
      ]).messages,
    ).toEqual([{ id: '0', role: 'assistant', text: 'First thought\n\nSecond thought' }]);
  });

  it('turns the engine tool_start frame into a row that splits streamed prose', () => {
    // coven-code in --print mode reports only the tool name (main.rs `tool_start`).
    expect(
      projectEvents([
        { type: 'system', subtype: 'init', session_id: 'run' },
        { type: 'text_delta', session_id: 'run', text: 'Looking.' },
        { type: 'tool_start', session_id: 'run', tool: 'Bash' },
        { type: 'text_delta', session_id: 'run', text: 'Found it.' },
        { type: 'tool_start', session_id: 'run' },
      ]).messages,
    ).toEqual([
      { id: '1', role: 'assistant', text: 'Looking.' },
      { id: '2', role: 'tool', text: 'Bash', tool: { name: 'Bash', args: '' } },
      { id: '3', role: 'assistant', text: 'Found it.' },
    ]);
  });

  it('summarises structured tool input like the engine notice and keeps the full input', () => {
    const input = { command: 'ls -la\n# second line', description: 'List files' };
    const [row] = projectEvents([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }] },
      },
    ]).messages;
    expect(row).toEqual({
      id: '0',
      role: 'tool',
      text: 'Bash',
      tool: { id: 'toolu_1', name: 'Bash', args: 'ls -la', raw: JSON.stringify(input, null, 2) },
    });
    expect(summarizeToolInput({ other: 'x'.repeat(100) }).args).toHaveLength(81);
    const large = summarizeToolInput({ content: 'y'.repeat(RAW_LIMIT) }).raw;
    expect(large.endsWith(RAW_TRUNCATED)).toBe(true);
    expect(large).toHaveLength(RAW_LIMIT + RAW_TRUNCATED.length);
    expect(summarizeToolInput({ content: 'y'.repeat(100) }).raw).not.toContain('truncated');
    expect(summarizeToolInput({}).args).toBe('');
    expect(summarizeToolInput('plain').args).toBe('"plain"');
  });

  it('settles a row from the protocol tool_result frame or a Claude-style user block', () => {
    const messages = projectEvents([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } },
            { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'false' } },
          ],
        },
      },
      { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'file body' }] },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'exit 1' }],
        },
      },
      { type: 'tool_result', tool_use_id: 'missing', content: 'ignored' },
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(['tool', 'tool']);
    expect(messages[0]?.tool).toMatchObject({ id: 'a', result: 'file body' });
    expect(messages[0]?.tool?.isError).toBeUndefined();
    expect(messages[1]?.tool).toMatchObject({ id: 'b', result: 'exit 1', isError: true });
  });

  it('settles a bridge tool_end by id, then by the latest open row of that name', () => {
    const messages = projectEvents([
      { type: 'tool_start', tool_name: 'Bash', tool_id: 't1', input: { command: 'a' } },
      { type: 'tool_start', tool: 'Bash' },
      { type: 'tool_end', tool_name: 'Bash', result: 'second done' },
      { type: 'tool_end', tool_id: 't1', result: 'first done', is_error: true },
    ]).messages;
    expect(messages[1]?.tool).toMatchObject({ name: 'Bash', result: 'second done' });
    expect(messages[0]?.tool).toMatchObject({ id: 't1', result: 'first done', isError: true });
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
