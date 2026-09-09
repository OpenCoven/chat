import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const supervisor = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/unix-producer-supervisor.sh'),
  'utf8',
);
const start = supervisor.indexOf('set +e\nwait "$producer_pid"');
const end = supervisor.indexOf('\ndelete_producer_account ||', start);
const completion = supervisor.slice(start, end);

describe('Unix producer completion diagnostics', () => {
  test.each(['Linux', 'Darwin'])('%s reports child failure before draining containment', (host) => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
host_os=$1
producer_uid=40000
cgroup_relative=test-cgroup
timed_out=0
producer_contained=1
containment_proved=0
drain_linux_cgroup() { echo drained >&2; }
lock_macos_account() { :; }
drain_macos_uid() { echo drained >&2; }
(exit 23) &
producer_pid=$!
${completion}`,
        'test',
        host,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'unix-producer-supervisor: restricted producer exited with status 23\n' +
        'drained\n' +
        'unix-producer-supervisor: restricted production failed\n',
    );
  });

  test('does not report a failure for a successful child', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
host_os=Linux
cgroup_relative=test-cgroup
timed_out=0
producer_contained=1
containment_proved=0
drain_linux_cgroup() { :; }
(exit 0) &
producer_pid=$!
${completion}`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
