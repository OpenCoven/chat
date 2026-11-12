import { describe, expect, test } from 'vitest';
import {
  checkAgentDocPaths,
  codeSpanPath,
  extractReferences,
} from '../scripts/agent-doc-paths.mjs';

describe('agent doc paths', () => {
  test('every path the agent docs name exists', () => {
    // A failure lists doc:line, the missing path and why. Fix the doc, or
    // restore the file if the rename was a mistake.
    expect(checkAgentDocPaths()).toEqual([]);
  });

  test('treats repo paths and named files as paths', () => {
    expect(codeSpanPath('src/coven/chat-app.tsx')).toBe('src/coven/chat-app.tsx');
    expect(codeSpanPath('src/coven/')).toBe('src/coven/');
    expect(codeSpanPath('docs/release-notes/v0.0.2.md:17')).toBe('docs/release-notes/v0.0.2.md');
    expect(codeSpanPath('src-tauri/src/lib.rs:10-20')).toBe('src-tauri/src/lib.rs');
    expect(codeSpanPath('chat_canonical.rs')).toBe('chat_canonical.rs');
  });

  test('skips commands, symbols, placeholders and paths outside the repo', () => {
    for (const span of [
      'git commit -S',
      'REPLAY_LIMIT',
      'emptyThreadText(connected, familiarName)',
      '.worktrees/<short-name>',
      '~/.claude/settings.json',
      '../coven-code',
      '--stream-json-input',
      'OpenCoven/coven-code',
      'fix/123-example-slug',
      'https://github.com/OpenCoven/chat',
      'claurst-*',
      '.artifacts/ledger.md',
      'v0.1.2',
    ]) {
      expect(codeSpanPath(span), span).toBeNull();
    }
  });

  test('reads code spans and relative links, not fenced blocks or web links', () => {
    const markdown = [
      'See `src/ui/composer.tsx` and [the notes](docs/agent-notes.md#symptom).',
      '```',
      'src/not-checked.ts',
      '`src/also-not-checked.ts`',
      '```',
      'Ignore [the web](https://example.com) and [a heading](#where).',
    ].join('\n');
    expect(extractReferences(markdown)).toEqual([
      { kind: 'code', line: 1, path: 'src/ui/composer.tsx' },
      { kind: 'link', line: 1, path: 'docs/agent-notes.md' },
    ]);
  });
});
