import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The acceptance harness checks a downloaded installer against the release's
// SHA256SUMS. From v0.1.3 on, SHA256SUMS also lists each updater signature
// (`<installer>.sig`), and a prefix match on the name picked that line up as
// well, so the check failed on a file it never downloaded (#705).
const FILES = [
  'scripts/native-acceptance/lane-linux.sh',
  'scripts/native-acceptance/lane-mac.sh',
  '.github/workflows/packaged-acceptance.yml',
];
const LOOKUP = `awk -v name="$asset" '$2 == name' SHA256SUMS`;
const OLD_LOOKUP = `grep -F "  \${asset}" SHA256SUMS`;

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function lookup(command: string, asset: string, sums: string): string {
  dir = mkdtempSync(join(tmpdir(), 'checksum-lookup-'));
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  return execFileSync('bash', ['-c', command], { cwd: dir, env: { ...process.env, asset } })
    .toString()
    .trim();
}

const SUMS = [
  `${'a'.repeat(64)}  Coven.Chat_0.1.3_amd64.deb`,
  `${'b'.repeat(64)}  Coven.Chat_0.1.3_amd64.deb.sig`,
  `${'c'.repeat(64)}  Coven.Chat_0.1.3_x64_en-US.msi`,
  `${'d'.repeat(64)}  Coven.Chat_0.1.3_x64_en-US.msi.sig`,
  '',
].join('\n');

describe('the acceptance harness finds an installer in SHA256SUMS', () => {
  it('takes only the line naming that exact file, not its .sig', () => {
    expect(lookup(LOOKUP, 'Coven.Chat_0.1.3_amd64.deb', SUMS)).toBe(
      `${'a'.repeat(64)}  Coven.Chat_0.1.3_amd64.deb`,
    );
    expect(lookup(LOOKUP, 'Coven.Chat_0.1.3_x64_en-US.msi', SUMS)).toBe(
      `${'c'.repeat(64)}  Coven.Chat_0.1.3_x64_en-US.msi`,
    );
    expect(lookup(LOOKUP, 'Coven.Chat_0.1.3_amd64.AppImage', SUMS)).toBe('');
  });

  it('is what every lookup in the harness uses', () => {
    // The old prefix match returns both lines, which is the failure #705 saw.
    expect(lookup(OLD_LOOKUP, 'Coven.Chat_0.1.3_amd64.deb', SUMS)).toContain('.deb.sig');
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).toContain(LOOKUP);
      expect(text, file).not.toContain(OLD_LOOKUP);
    }
  });
});
