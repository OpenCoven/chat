// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectedInstallers,
  expectedUpdaterArchives,
  smokeTestRelease,
} from '../scripts/release-smoke.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
  .version as string;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function writeChecksums(dir: string, names: string[]) {
  const lines = names.map((name) => {
    const digest = createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

/** A complete release directory: the six installers plus SHA256SUMS. */
function release(extra: Record<string, string> = {}) {
  const dir = tempDir('release-smoke-');
  const files: Record<string, string> = {};
  for (const name of expectedInstallers(VERSION)) files[name] = `installer ${name}`;
  Object.assign(files, extra);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  writeChecksums(dir, Object.keys(files));
  return dir;
}

/** A copy of the version and identity sources, for mutating configuration. */
function rootWith(mutate: (conf: Record<string, unknown>) => void) {
  const root = tempDir('release-smoke-root-');
  mkdirSync(join(root, 'src-tauri'));
  cpSync(join(projectRoot, 'package.json'), join(root, 'package.json'));
  cpSync(join(projectRoot, 'src-tauri/Cargo.toml'), join(root, 'src-tauri/Cargo.toml'));
  const conf = JSON.parse(readFileSync(join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  mutate(conf);
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify(conf));
  return root;
}

const smoke = (
  releaseDir: string,
  options: { root?: string; tag?: string; allowUnsigned?: boolean } = {},
) =>
  smokeTestRelease({ releaseDir, root: options.root ?? projectRoot, version: VERSION, ...options });

describe('release smoke test', () => {
  it('passes a complete unsigned release with the updater off, and says so', () => {
    const report = smoke(release(), { tag: `v${VERSION}`, allowUnsigned: true });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.installers).toEqual(expectedInstallers(VERSION));
    expect(report.updater.state).toBe('disabled');
    expect(report.signing.state).toBe('unsigned');
  });

  it('reports signing as required when the run did not allow unsigned artifacts', () => {
    expect(smoke(release()).signing.state).toBe('required');
  });

  it('matches the installer names the rehearsal release actually produced', () => {
    expect(expectedInstallers('0.0.1')).toEqual([
      'OpenCoven Chat_0.0.1_aarch64.dmg',
      'OpenCoven Chat_0.0.1_x64.dmg',
      'OpenCoven Chat_0.0.1_x64_en-US.msi',
      'OpenCoven Chat_0.0.1_x64-setup.exe',
      'OpenCoven Chat_0.0.1_amd64.AppImage',
      'OpenCoven Chat_0.0.1_amd64.deb',
    ]);
  });

  it.each(expectedInstallers('X').map((_, index) => index))(
    'fails when installer %i is missing',
    (index) => {
      const dir = release();
      const name = expectedInstallers(VERSION)[index] as string;
      rmSync(join(dir, name));
      writeChecksums(
        dir,
        expectedInstallers(VERSION).filter((entry) => entry !== name),
      );
      expect(smoke(dir).failures).toContain(`Missing installer: ${name}.`);
    },
  );

  it('fails an empty installer', () => {
    const dir = release();
    const name = expectedInstallers(VERSION)[0] as string;
    writeFileSync(join(dir, name), '');
    writeChecksums(dir, expectedInstallers(VERSION));
    expect(smoke(dir).failures).toContain(`Installer is empty: ${name}.`);
  });

  it('fails an asset from another version or product', () => {
    const stray = `OpenCoven Chat_9.9.9_x64.dmg`;
    expect(smoke(release({ [stray]: 'old' })).failures).toContain(
      `Unexpected release asset: ${stray}.`,
    );
  });

  it('fails a checksum that does not match the bytes', () => {
    const dir = release();
    writeFileSync(join(dir, expectedInstallers(VERSION)[1] as string), 'tampered');
    expect(smoke(dir).failures).toContain(
      `SHA256SUMS digest for ${expectedInstallers(VERSION)[1]} does not match its bytes.`,
    );
  });

  it('fails an asset SHA256SUMS does not cover, and an entry with no asset', () => {
    const dir = release();
    const names = expectedInstallers(VERSION);
    writeChecksums(dir, names.slice(1));
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      `${readFileSync(join(dir, 'SHA256SUMS'), 'utf8')}${'0'.repeat(64)}  ghost.dmg\n`,
    );
    const failures = smoke(dir).failures;
    expect(failures).toContain(`SHA256SUMS does not cover ${names[0]}.`);
    expect(failures).toContain('SHA256SUMS lists ghost.dmg, which is not a release asset.');
  });

  it('fails malformed and duplicate SHA256SUMS lines', () => {
    const dir = release();
    const text = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
    const first = text.split('\n')[0] as string;
    writeFileSync(join(dir, 'SHA256SUMS'), `${text}${first}\nnot a checksum\n`);
    const failures = smoke(dir).failures;
    expect(failures).toContain(
      `SHA256SUMS lists ${expectedInstallers(VERSION)[0]} more than once.`,
    );
    expect(failures.some((failure) => /line \d+ is not a SHA-256 entry/.test(failure))).toBe(true);
  });

  it('fails a missing SHA256SUMS', () => {
    const dir = release();
    rmSync(join(dir, 'SHA256SUMS'));
    expect(smoke(dir).failures).toContain('SHA256SUMS is missing.');
  });

  it('fails when the tag disagrees with the tagged tree', () => {
    expect(smoke(release(), { tag: 'v9.9.9' }).failures).toContain(
      `Version "9.9.9" from tag does not match ${VERSION}.`,
    );
  });

  it('fails when tauri.conf.json disagrees with the other version sources', () => {
    const root = rootWith((conf) => {
      conf.version = '9.9.9';
    });
    expect(smoke(release(), { root }).failures).toContain(
      `Version "9.9.9" from tauri.conf.json does not match ${VERSION}.`,
    );
  });

  it('fails a changed product identifier', () => {
    const root = rootWith((conf) => {
      conf.identifier = 'ai.example.chat';
    });
    expect(smoke(release(), { root }).failures).toContain(
      'identifier is "ai.example.chat", not ai.opencoven.chat.',
    );
  });

  it('fails updater assets while createUpdaterArtifacts is off', () => {
    const archive = [...expectedUpdaterArchives(VERSION).keys()][2] as string;
    const failures = smoke(
      release({ [archive]: 'zip', [`${archive}.sig`]: 'sig', 'latest.json': '{}' }),
    ).failures;
    expect(failures).toContain(
      `Updater asset ${archive} is present but createUpdaterArtifacts is off.`,
    );
    expect(failures).toContain(
      `Updater asset ${archive}.sig is present but createUpdaterArtifacts is off.`,
    );
    expect(failures).toContain('latest.json is present but createUpdaterArtifacts is off.');
  });

  describe('once the updater is enabled', () => {
    const on = () =>
      rootWith((conf) => {
        (conf.bundle as Record<string, unknown>).createUpdaterArtifacts = true;
      });
    function updaterRelease(options: { dropSig?: string; platforms?: string[] } = {}) {
      const archives = expectedUpdaterArchives(VERSION);
      const extra: Record<string, string> = {};
      for (const name of archives.keys()) {
        extra[name] = `archive ${name}`;
        if (options.dropSig !== name) extra[`${name}.sig`] = `signature ${name}`;
      }
      const platforms = options.platforms ?? [...new Set(archives.values())];
      extra['latest.json'] = JSON.stringify({
        version: VERSION,
        platforms: Object.fromEntries(platforms.map((key) => [key, { signature: 's', url: 'u' }])),
      });
      return release(extra);
    }

    it('passes signed archives with a matching latest.json', () => {
      const report = smoke(updaterRelease(), { root: on() });
      expect(report.failures).toEqual([]);
      expect(report.updater).toMatchObject({ state: 'enabled', manifest: true });
    });

    it('fails an updater archive without its signature', () => {
      const archive = [...expectedUpdaterArchives(VERSION).keys()][0] as string;
      expect(smoke(updaterRelease({ dropSig: archive }), { root: on() }).failures).toContain(
        `Updater archive ${archive} has no signature.`,
      );
    });

    it('fails a latest.json that omits a platform', () => {
      expect(
        smoke(
          updaterRelease({ platforms: ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'] }),
          { root: on() },
        ).failures,
      ).toContain('latest.json has no linux-x86_64 entry.');
    });

    it('fails when the updater is on but produced nothing', () => {
      expect(smoke(release(), { root: on() }).failures).toContain(
        'createUpdaterArtifacts is on but no updater archive was produced.',
      );
    });
  });

  it('exits non-zero from the command line on a failure and zero on a clean release', () => {
    const script = join(projectRoot, 'scripts/release-smoke.mjs');
    const clean = spawnSync(
      process.execPath,
      [script, '--dir', release(), '--version', VERSION, '--allow-unsigned'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, signing: { state: 'unsigned' } });
    const broken = release();
    rmSync(join(broken, 'SHA256SUMS'));
    const failed = spawnSync(process.execPath, [script, '--dir', broken, '--version', VERSION], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('::error::SHA256SUMS is missing.');
  });
});
