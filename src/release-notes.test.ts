import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  changelogLine,
  checkNotes,
  checkReleaseNotes,
  compareTags,
  INDEX,
  listNotes,
  previousTag,
} from '../scripts/release-notes.mjs';

const ready = (tag: string, previous: string | null) =>
  [
    `# OpenCoven Chat ${tag}`,
    '',
    'What changes for you.',
    '',
    '## Before you install',
    '',
    `Check \`OpenCoven.Chat_${tag.slice(1)}_aarch64.dmg\` against \`SHA256SUMS\`.`,
    ...(previous ? ['', changelogLine(previous, tag)] : []),
    '',
  ].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/release-notes'), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

describe('release notes', () => {
  test('every published release has ready notes and an index row', () => {
    // A failure names the file and what to change. The template is in
    // docs/release-notes/README.md.
    expect(checkReleaseNotes()).toEqual([]);
  });

  test('the index lists every notes file', () => {
    const index = readFileSync(INDEX, 'utf8');
    for (const tag of listNotes()) expect(index).toContain(`](${tag}.md)`);
  });

  test('orders tags by version, prereleases before their release', () => {
    expect(
      ['v0.1.0', 'v0.0.10', 'v0.0.9', 'v0.1.0-rc.2', 'v0.1.0-rc.10'].sort(compareTags),
    ).toEqual(['v0.0.9', 'v0.0.10', 'v0.1.0-rc.2', 'v0.1.0-rc.10', 'v0.1.0']);
  });

  test('compares with the previous release, skipping the historical demo', () => {
    const tags = ['v0.0.1-demo.1', 'v0.0.2', 'v0.0.3', 'v0.1.1'];
    expect(previousTag('v0.0.2', tags)).toBeNull();
    expect(previousTag('v0.0.3', tags)).toBe('v0.0.2');
    expect(previousTag('v0.1.2', tags)).toBe('v0.1.1');
  });

  test('a release compares with the previous release, not its own candidates', () => {
    // Someone coming from v0.1.1 wants every change, not only rc.2 → final.
    const tags = ['v0.1.1', 'v0.1.2-rc.1', 'v0.1.2-rc.2', 'v0.1.2'];
    expect(previousTag('v0.1.2', tags)).toBe('v0.1.1');
    expect(previousTag('v0.1.2-rc.2', tags)).toBe('v0.1.2-rc.1');
    expect(previousTag('v0.1.2-rc.1', tags)).toBe('v0.1.1');
  });

  test('reads notes saved with Windows line endings or a byte-order mark', () => {
    const crlf = `﻿${ready('v0.1.2', 'v0.1.1').replaceAll('\n', '\r\n')}`;
    expect(checkNotes('v0.1.2', crlf, { previous: 'v0.1.1', index: '](v0.1.2.md)' })).toEqual([]);
  });

  test('accepts notes that follow the template', () => {
    expect(
      checkNotes('v0.1.2', ready('v0.1.2', 'v0.1.1'), {
        previous: 'v0.1.1',
        index: '](v0.1.2.md)',
      }),
    ).toEqual([]);
  });

  test('names each missing part', () => {
    const problems = checkNotes('v0.1.2', 'Some notes about OpenCoven.Chat_0.1.1_x64.dmg. TODO\n', {
      previous: 'v0.1.1',
      index: '',
    });
    expect(problems).toEqual([
      `add a row for v0.1.2 to ${INDEX}`,
      'start the file with the line "# OpenCoven Chat v0.1.2"',
      'add a "## Before you install" section (see the template in the index)',
      'say how to check a download against SHA256SUMS',
      'an installer filename names version 0.1.1; this release is 0.1.2',
      'replace the placeholder "TODO"',
      `end the file with the line: ${changelogLine('v0.1.1', 'v0.1.2')}`,
    ]);
  });

  test("rejects the template's own placeholders", () => {
    const copied = `${ready('v0.1.2', 'v0.1.1')}\nCheck OpenCoven.Chat_X.Y.Z_aarch64.dmg.\n`;
    expect(checkNotes('v0.1.2', copied, { previous: null, index: '](v0.1.2.md)' })).toEqual([
      'replace the placeholder "X.Y.Z"',
    ]);
  });

  test('a release being prepared fails until its notes exist', () => {
    const index = '[v0.1.1](v0.1.1.md)\n';
    const root = repo({
      'docs/release-notes/README.md': index,
      'docs/release-notes/v0.1.1.md': ready('v0.1.1', null),
    });
    expect(checkReleaseNotes(root, 'v0.1.2')).toEqual([
      { file: 'docs/release-notes/v0.1.2.md', problem: `write it from the template in ${INDEX}` },
    ]);
    writeFileSync(join(root, 'docs/release-notes/v0.1.2.md'), ready('v0.1.2', 'v0.1.1'));
    writeFileSync(join(root, INDEX), `${index}[v0.1.2](v0.1.2.md)\n`);
    expect(checkReleaseNotes(root, 'v0.1.2')).toEqual([]);
  });

  test('the index may not link notes that do not exist', () => {
    const root = repo({ 'docs/release-notes/README.md': '[v0.1.2](v0.1.2.md)\n' });
    expect(checkReleaseNotes(root)).toEqual([
      { file: INDEX, problem: 'links v0.1.2.md, which does not exist' },
    ]);
  });
});
