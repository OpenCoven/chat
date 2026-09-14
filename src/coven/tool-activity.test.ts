import { describe, expect, it } from 'vitest';
import { segmentToolCalls } from './tool-activity';

describe('segmentToolCalls', () => {
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
});
