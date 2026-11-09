import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const supervisor = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/unix-producer-supervisor.sh'),
  'utf8',
);

test.skipIf(process.platform === 'win32')(
  'staged Rust tools dispatch through an env-wrapped manager',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'opencoven-rust-launcher-'));
    try {
      const manager = join(root, 'manager');
      const launcher = join(root, 'source');
      // Homebrew's env launcher explicitly invokes rustup, regardless of argv[0].
      writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
      writeFileSync(launcher, `#!/bin/sh\nexec "${manager}" "$@"\n`, { mode: 0o700 });
      const start = supervisor.indexOf('cp "$rustup_executable" "$trusted_rustup"');
      const end = supervisor.indexOf('\nif [[ "$host_os" == Darwin ]]', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const staged = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
trusted_root=$1
rustup_executable=$2
trusted_rustup="$trusted_root/rustup"
trusted_cargo="$trusted_root/cargo"
trusted_rustc="$trusted_root/rustc"
${supervisor.slice(start, end)}
chmod 500 "$trusted_rustup" "$trusted_cargo" "$trusted_rustc"`,
          'test',
          root,
          launcher,
        ],
        { encoding: 'utf8' },
      );
      expect(staged.status, staged.stderr).toBe(0);
      for (const tool of ['cargo', 'rustc']) {
        const result = spawnSync(
          join(root, tool),
          ['--version', 'argument with spaces', '$(not-a-command)'],
          { encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          `run\n1.95.0\n${tool}\n--version\nargument with spaces\n$(not-a-command)\n`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
