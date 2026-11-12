import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/ci/ubuntu-apt.sh');
const WORKFLOWS = ['release', 'packaged-acceptance', 'native-acceptance'].map(
  (name) => `.github/workflows/${name}.yml`,
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of a hosted runner's apt sources, under a fake root. */
const MIRROR_LIST = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n';
const SOURCES = [
  'deb mirror+file:/etc/apt/apt-mirrors.txt jammy main restricted universe',
  'deb http://security.ubuntu.com/ubuntu jammy-security main restricted universe',
  'deb https://packages.microsoft.com/ubuntu/22.04/prod jammy main',
  '',
].join('\n');

/**
 * Runs the script against a fake apt root, with stand-ins for sudo, apt-get and
 * apt-cache on PATH. Each `apt-get update` is one mirror tried, and
 * `servedFrom` says from which try on apt has a candidate for the packages.
 */
function run(args: string[], servedFrom: number, installFails = false) {
  const bin = mkdtempSync(join(tmpdir(), 'ubuntu-apt-'));
  dirs.push(bin);
  const log = join(bin, 'calls.log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Like sudo, it takes VAR=value before the command.
  stub('sudo', 'exec env "$@"');
  stub(
    'apt-get',
    `printf '%s\\n' "apt-get $*" >> "${log}"
if [[ " $* " == *" update "* ]]; then echo x >> "${bin}/tries"; exit 0; fi
${installFails ? 'exit 100' : 'exit 0'}`,
  );
  stub(
    'apt-cache',
    `tries=$(wc -l < "${bin}/tries" | tr -d ' ')
if [ "$tries" -ge ${servedFrom} ]; then echo "  Candidate: 1.0"; else echo "  Candidate: (none)"; fi`,
  );
  const root = join(bin, 'root');
  mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
  writeFileSync(join(root, 'etc/apt/apt-mirrors.txt'), MIRROR_LIST);
  writeFileSync(join(root, 'etc/apt/sources.list'), SOURCES);
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBUNTU_APT_ROOT: root },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {}
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  return {
    ...result,
    calls,
    mirrorList: read('etc/apt/apt-mirrors.txt'),
    sources: read('etc/apt/sources.list'),
  };
}

describe('scripts/ci/ubuntu-apt.sh', () => {
  it('installs through kernel.org when it serves the packages', () => {
    const result = run(['libfuse2', 'file'], 1);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Ubuntu mirror: installed through https://mirrors.edge.kernel.org/ubuntu',
    );
    expect(result.calls.at(-1)).toMatch(/install -y libfuse2 file$/);
  });

  it("moves on to Canonical's archive when kernel.org can't be reached", () => {
    // 2026-11-11: kernel.org's mirror was unreachable from hosted runners, and
    // every AppImage job failed with "Unable to locate package".
    const result = run(['libwebkit2gtk-4.1-dev'], 2);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no candidate for libwebkit2gtk-4.1-dev');
    expect(result.stdout).toContain(
      'Ubuntu mirror: installed through http://archive.ubuntu.com/ubuntu',
    );
    expect(result.calls.filter((call) => call.includes(' install '))).toHaveLength(1);
    // Ubuntu's sources point at the mirror that worked; other repositories are left alone.
    expect(result.mirrorList).toBe('http://archive.ubuntu.com/ubuntu\n');
    expect(result.sources).toContain('deb mirror+file:/etc/apt/apt-mirrors.txt jammy main');
    expect(result.sources).toContain('deb http://archive.ubuntu.com/ubuntu jammy-security main');
    expect(result.sources).not.toContain('kernel.org');
    expect(result.sources).toContain('https://packages.microsoft.com/ubuntu/22.04/prod');
  });

  it('tries the next mirror when an install fails, and fails once none is left', () => {
    const result = run(['file'], 1, true);
    expect(result.status).toBe(1);
    expect(result.calls.filter((call) => call.includes(' install '))).toHaveLength(3);
    expect(result.stdout).toContain('::error::No Ubuntu mirror served: file');
  });

  it('only chooses a mirror with --select-only', () => {
    const result = run(['--select-only', 'xvfb'], 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Ubuntu mirror: using http://azure.archive.ubuntu.com/ubuntu');
    expect(result.calls.some((call) => call.includes(' install '))).toBe(false);
  });

  it('is what the Linux jobs use, with no mirror pinned in the workflows', () => {
    for (const workflow of WORKFLOWS) {
      const text = readFileSync(workflow, 'utf8');
      expect(text, workflow).toContain('bash scripts/ci/ubuntu-apt.sh');
      expect(text, workflow).not.toContain('mirrors.edge.kernel.org');
      expect(text, workflow).not.toMatch(/^\s*sudo apt-get (update|install)/m);
    }
  });
});
