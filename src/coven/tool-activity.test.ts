import { describe, expect, it } from 'vitest';
import { segmentToolCalls } from './tool-activity';

describe('segmentToolCalls', () => {
  it.each([
    '`⚒ Bash(example)`',
    '``Example ` ⚒ Bash(example)``',
    '~~~text\n⚒ Bash(example)\n~~~',
    '~~~text\n⚒ Bash(incomplete',
  ])('leaves literal Markdown tool examples intact: %s', (example) => {
    expect(segmentToolCalls(example)).toEqual([{ kind: 'text', text: example }]);
  });

  it('separates actual tools beside inline examples without altering shell backticks', () => {
    expect(segmentToolCalls('Use `⚒ Read(example)`.\n⚒ Bash(echo `pwd`)')).toEqual([
      { kind: 'text', text: 'Use `⚒ Read(example)`.\n' },
      { kind: 'tool', name: 'Bash', args: 'echo `pwd`' },
    ]);
  });

  it.each(['⚒', '⚒\uFE0E', '⚒\uFE0F', '✶', '✳'])(
    'separates concatenated %s calls from surrounding prose',
    (marker) => {
      expect(segmentToolCalls(`Before.${marker} Bash(echo ok)${marker} Read(a.ts)After.`)).toEqual([
        { kind: 'text', text: 'Before.' },
        { kind: 'tool', name: 'Bash', args: 'echo ok' },
        { kind: 'tool', name: 'Read', args: 'a.ts' },
        { kind: 'text', text: 'After.' },
      ]);
    },
  );

  it.each(['⚒', '✶', '✳'])('preserves quoted and nested arguments for %s', (marker) => {
    const args = '  echo ")" && printf \'(\' && (echo "⚒ Read(example)")  ';
    expect(segmentToolCalls(`${marker} Bash(${args})Done.`)).toEqual([
      { kind: 'tool', name: 'Bash', args },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('preserves raw whitespace including multiline arguments', () => {
    const args = ' \tfirst\nsecond  ';
    expect(segmentToolCalls(`⚒ Edit(${args})`)).toEqual([{ kind: 'tool', name: 'Edit', args }]);
  });

  it.each(['⚒', '✶', '✳'])('stops truncated calls at the next %s marker', (marker) => {
    expect(segmentToolCalls(`⚒ Bash(echo ...${marker} Read(a.ts)`)).toEqual([
      { kind: 'tool', name: 'Bash', args: 'echo ...' },
      { kind: 'tool', name: 'Read', args: 'a.ts' },
    ]);
  });

  it('ends a crossed-tools truncated summary at a line break or end of stream', () => {
    expect(segmentToolCalls('⚒ Bash(echo "oops\nDone.')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'echo "oops' },
      { kind: 'text', text: '\nDone.' },
    ]);
    expect(segmentToolCalls('⚒ Read(src/app')).toEqual([
      { kind: 'tool', name: 'Read', args: 'src/app' },
    ]);
  });

  it.each(['```text\n⚒ Bash(echo ok)\n✶ Read(a.ts)\n✳ Edit(b.ts)\n```', '```text\n⚒ Read(a.ts)'])(
    'preserves fenced examples including unclosed streamed fences',
    (fence) => {
      const text = `Example:\n\n${fence}`;
      expect(segmentToolCalls(text)).toEqual([{ kind: 'text', text }]);
    },
  );

  it('keeps every argument character when a truncated marker ends at a newline', () => {
    expect(segmentToolCalls('✶ Read(src/app.ts\nDone.')).toEqual([
      { kind: 'tool', name: 'Read', args: 'src/app.ts' },
      { kind: 'text', text: '\nDone.' },
    ]);
  });

  it('does not swallow the next marker after a truncated one', () => {
    expect(segmentToolCalls('✶ Bash(gh api user ...✶ Read(src/app.ts)')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'gh api user ...' },
      { kind: 'tool', name: 'Read', args: 'src/app.ts' },
    ]);
  });

  it('treats later balanced parentheses in prose as prose, not as the closing paren', () => {
    const segments = segmentToolCalls('✶ Bash(gh api user/orgs ...\n\nThat worked (mostly).');
    expect(segments[0]).toEqual({ kind: 'tool', name: 'Bash', args: 'gh api user/orgs ...' });
    expect(segments[1]).toEqual({ kind: 'text', text: '\n\nThat worked (mostly).' });
  });

  it('treats a closing paren after a paragraph break as prose', () => {
    expect(segmentToolCalls('✶ Bash(gh api user ...\n\nDone (finally).')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'gh api user ...' },
      { kind: 'text', text: '\n\nDone (finally).' },
    ]);
  });

  it('ignores parentheses inside quoted arguments', () => {
    expect(segmentToolCalls('✶ Bash(echo ")" && printf \'(\') ok')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'echo ")" && printf \'(\'' },
      { kind: 'text', text: ' ok' },
    ]);
  });

  it('treats a backslash-escaped quote as part of the quoted argument', () => {
    expect(segmentToolCalls('✶ Bash(echo "a\\")b") done')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'echo "a\\")b"' },
      { kind: 'text', text: ' done' },
    ]);
  });

  it('still ends an unterminated quote at the line boundary', () => {
    expect(segmentToolCalls('✶ Bash(echo "oops\nNext line (prose).')).toEqual([
      { kind: 'tool', name: 'Bash', args: 'echo "oops' },
      { kind: 'text', text: '\nNext line (prose).' },
    ]);
  });

  it('does not let a lone apostrophe swallow the closing paren', () => {
    expect(segmentToolCalls("✶ Read(notes/Sam's plan.md) done")).toEqual([
      { kind: 'tool', name: 'Read', args: "notes/Sam's plan.md" },
      { kind: 'text', text: ' done' },
    ]);
  });
});
