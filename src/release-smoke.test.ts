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
  expectedUpdaterArtifacts,
  smokeTestRelease,
} from '../scripts/release-smoke.mjs';
import { buildUpdaterManifest } from '../scripts/updater-manifest.mjs';

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

/** A complete release directory: every installer plus SHA256SUMS. */
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

type Conf = Record<string, unknown> & { plugins?: Record<string, unknown> };

/** The tagged tree without the updater, whatever the live config says. */
const withoutUpdater = () =>
  rootWith((conf) => {
    delete (conf as Conf).plugins?.updater;
  });

/** The tagged tree with the updater configured, as the release overlay expects. */
const withUpdater = () =>
  rootWith((conf) => {
    const typed = conf as Conf;
    typed.plugins = {
      ...typed.plugins,
      updater: {
        pubkey: 'test-public-key',
        endpoints: ['https://github.com/OpenCoven/chat/releases/download/updater/latest.json'],
      },
    };
  });

const smoke = (
  releaseDir: string,
  options: {
    root?: string;
    tag?: string;
    allowUnsigned?: boolean;
    windowsSigning?: 'signed' | 'unsigned';
    updater?: 'on' | 'off';
  } = {},
) =>
  smokeTestRelease({
    releaseDir,
    root: options.root ?? withoutUpdater(),
    version: VERSION,
    ...options,
  });

describe('release smoke test', () => {
  it('passes a complete unsigned release with the updater off, and says so', () => {
    const report = smoke(release(), { tag: `v${VERSION}`, allowUnsigned: true });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.installers).toEqual(expectedInstallers(VERSION));
    expect(report.updater.state).toBe('disabled');
    expect(report.signing.state).toBe('unsigned');
    expect(report.signing.windows.state).toBe('unsigned');
  });

  it('reports signing as required when the run did not allow unsigned artifacts', () => {
    expect(smoke(release()).signing.state).toBe('required');
  });

  it('reports the Windows installers as unsigned unless the build job signed them', () => {
    // Windows ships unsigned by decision (#411), so the default is the truth
    // and `signed` has to be stated by the publish job from the build job's
    // output. An allow_unsigned rehearsal is unsigned whatever it claims.
    expect(smoke(release()).signing.windows).toMatchObject({ state: 'unsigned' });
    expect(smoke(release(), { windowsSigning: 'unsigned' }).signing.windows.reason).toContain(
      'SmartScreen',
    );
    expect(smoke(release(), { windowsSigning: 'signed' }).signing.windows).toMatchObject({
      state: 'signed',
    });
    expect(
      smoke(release(), { windowsSigning: 'signed', allowUnsigned: true }).signing.windows.state,
    ).toBe('unsigned');
    expect(() => smoke(release(), { windowsSigning: 'maybe' as unknown as 'signed' })).toThrow(
      'windowsSigning must be one of signed, unsigned',
    );
  });

  it('names installers the way GitHub serves them', () => {
    // GitHub turns each space in an uploaded name into a dot, as the v0.0.3
    // downloads show. The Windows names are Tauri's: `_x64_en-US.msi` from
    // WiX and `_x64-setup.exe` from NSIS.
    expect(expectedInstallers('0.0.5')).toEqual([
      'OpenCoven.Chat_0.0.5_aarch64.dmg',
      'OpenCoven.Chat_0.0.5_x64.dmg',
      'OpenCoven.Chat_0.0.5_x64_en-US.msi',
      'OpenCoven.Chat_0.0.5_x64-setup.exe',
      'OpenCoven.Chat_0.0.5_amd64.AppImage',
      'OpenCoven.Chat_0.0.5_amd64.deb',
    ]);
  });

  it('maps every updater artifact to its installer key, with one default per platform', () => {
    // tauri-cli 2.11.4 signs the Windows and Linux installers themselves and
    // archives only the macOS app; tauri-plugin-updater 2.12 looks up
    // `{os}-{arch}-{installer}` before `{os}-{arch}`.
    expect(Object.fromEntries(expectedUpdaterArtifacts('0.0.6'))).toEqual({
      'aarch64-apple-darwin-OpenCoven.Chat.app.tar.gz': ['darwin-aarch64-app', 'darwin-aarch64'],
      'x86_64-apple-darwin-OpenCoven.Chat.app.tar.gz': ['darwin-x86_64-app', 'darwin-x86_64'],
      'OpenCoven.Chat_0.0.6_x64_en-US.msi': ['windows-x86_64-msi'],
      'OpenCoven.Chat_0.0.6_x64-setup.exe': ['windows-x86_64-nsis', 'windows-x86_64'],
      'OpenCoven.Chat_0.0.6_amd64.AppImage': ['linux-x86_64-appimage', 'linux-x86_64'],
      'OpenCoven.Chat_0.0.6_amd64.deb': ['linux-x86_64-deb'],
    });
  });

  it('refuses an installer that kept the space in its name', () => {
    // SHA256SUMS would then list a name nobody can download.
    const name = `OpenCoven Chat_${VERSION}_x64.dmg`;
    expect(smoke(release({ [name]: 'installer' })).failures).toContain(
      `Unexpected release asset: ${name}.`,
    );
  });

  it('refuses a Windows installer with an unexpected locale or architecture', () => {
    // The names come from Tauri's bundler; a change there would otherwise
    // publish an installer SHA256SUMS and the notes do not name.
    for (const suffix of ['x64_de-DE.msi', 'arm64-setup.exe']) {
      const name = `OpenCoven.Chat_${VERSION}_${suffix}`;
      expect(smoke(release({ [name]: 'installer' })).failures).toContain(
        `Unexpected release asset: ${name}.`,
      );
    }
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
    const stray = `OpenCoven.Chat_9.9.9_x64.dmg`;
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

  it('fails updater assets while the updater is off', () => {
    const [mac] = [...expectedUpdaterArtifacts(VERSION).keys()];
    const msi = expectedInstallers(VERSION)[2] as string;
    const failures = smoke(
      release({ [mac as string]: 'archive', [`${msi}.sig`]: 'sig', 'latest.json': '{}' }),
    ).failures;
    expect(failures).toContain(
      `Updater asset ${mac} is present but the updater is off for this run.`,
    );
    expect(failures).toContain(
      `Updater asset ${msi}.sig is present but the updater is off for this run.`,
    );
    expect(failures).toContain('latest.json is present but the updater is off for this run.');
  });

  it('refuses an updater the tagged tree does not configure', () => {
    expect(smoke(release(), { updater: 'on' }).failures).toContain(
      'The build reported the updater on, but src-tauri/tauri.conf.json has no plugins.updater.',
    );
    expect(() => smoke(release(), { updater: 'maybe' as unknown as 'on' })).toThrow(
      'updater must be one of on, off',
    );
  });

  describe('once the tree configures the updater', () => {
    const TAG = `v${VERSION}`;
    /** A release the build produced with the updater on, and the feed the publish job writes. */
    function updaterRelease() {
      const dir = release();
      const names = [...expectedInstallers(VERSION)];
      for (const name of expectedUpdaterArtifacts(VERSION).keys()) {
        if (!names.includes(name)) {
          writeFileSync(join(dir, name), `archive ${name}`);
          names.push(name);
        }
        writeFileSync(join(dir, `${name}.sig`), `signature of ${name}\n`);
        names.push(`${name}.sig`);
      }
      const manifest = buildUpdaterManifest({
        releaseDir: dir,
        version: VERSION,
        tag: TAG,
        repo: 'OpenCoven/chat',
        notes: 'notes',
        pubDate: '2026-10-18T00:00:00.000Z',
      });
      writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest));
      names.push('latest.json');
      writeChecksums(dir, names);
      return { dir, names, manifest };
    }
    const rewrite = (dir: string, names: string[], manifest: unknown) => {
      writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest));
      writeChecksums(dir, names);
    };

    it('passes signed artifacts with the feed the publish job writes', () => {
      const { dir, manifest } = updaterRelease();
      const report = smoke(dir, { root: withUpdater(), tag: TAG, updater: 'on' });
      expect(report.failures).toEqual([]);
      expect(report.updater).toMatchObject({ state: 'enabled', manifest: true });
      expect(Object.keys(manifest.platforms).sort()).toEqual(
        [...expectedUpdaterArtifacts(VERSION).values()].flat().sort(),
      );
      expect(manifest.platforms['windows-x86_64']).toEqual(
        manifest.platforms['windows-x86_64-nsis'],
      );
      expect(manifest.platforms['linux-x86_64-deb']?.url).toBe(
        `https://github.com/OpenCoven/chat/releases/download/${TAG}/OpenCoven.Chat_${VERSION}_amd64.deb`,
      );
      // The feed carries the signature's contents, not a path to it.
      expect(manifest.platforms['darwin-aarch64']?.signature).toBe(
        `signature of aarch64-apple-darwin-OpenCoven.Chat.app.tar.gz`,
      );
    });

    it('fails an artifact without its signature, and a signature with no artifact', () => {
      const { dir, names } = updaterRelease();
      const deb = `OpenCoven.Chat_${VERSION}_amd64.deb`;
      const dmg = `OpenCoven.Chat_${VERSION}_aarch64.dmg`;
      rmSync(join(dir, `${deb}.sig`));
      writeFileSync(join(dir, `${dmg}.sig`), 'stray');
      writeChecksums(dir, [...names.filter((name) => name !== `${deb}.sig`), `${dmg}.sig`]);
      const failures = smoke(dir, { root: withUpdater(), tag: TAG, updater: 'on' }).failures;
      expect(failures).toContain(`Updater artifact ${deb} has no signature.`);
      expect(failures).toContain(`Signature ${dmg}.sig matches no updater artifact.`);
    });

    it('fails a feed that omits a platform, points elsewhere or carries another signature', () => {
      const { dir, names, manifest } = updaterRelease();
      const exe = `OpenCoven.Chat_${VERSION}_x64-setup.exe`;
      const platforms = { ...manifest.platforms } as Record<
        string,
        { signature: string; url: string }
      >;
      delete platforms['linux-x86_64-deb'];
      platforms['windows-x86_64-nsis'] = {
        signature: platforms['windows-x86_64-nsis']?.signature as string,
        url: `https://github.com/OpenCoven/chat/releases/download/v0.0.1/${exe}`,
      };
      platforms['darwin-x86_64'] = {
        url: platforms['darwin-x86_64']?.url as string,
        signature: 'forged',
      };
      platforms['windows-aarch64'] = platforms['windows-x86_64'] as {
        signature: string;
        url: string;
      };
      rewrite(dir, names, { ...manifest, platforms });
      const failures = smoke(dir, { root: withUpdater(), tag: TAG, updater: 'on' }).failures;
      expect(failures).toContain('latest.json has no linux-x86_64-deb entry.');
      expect(failures).toContain(
        `latest.json windows-x86_64-nsis does not point at ${exe} in this release.`,
      );
      expect(failures).toContain(
        'latest.json darwin-x86_64 signature differs from x86_64-apple-darwin-OpenCoven.Chat.app.tar.gz.sig.',
      );
      expect(failures).toContain('latest.json names unexpected platform windows-aarch64.');
    });

    it('fails a production run that produced no updater artifacts', () => {
      expect(smoke(release(), { root: withUpdater() }).failures).toContain(
        'src-tauri/tauri.conf.json configures the updater, but this run produced no updater artifacts. TAURI_SIGNING_PRIVATE_KEY and its password are required on the production path.',
      );
    });

    it('lets an allow_unsigned rehearsal without the key go, and says why', () => {
      const report = smoke(release(), { root: withUpdater(), allowUnsigned: true });
      expect(report.failures).toEqual([]);
      expect(report.updater).toEqual({
        state: 'disabled',
        reason:
          'allow_unsigned rehearsal without the updater signing key; no updater artifacts or latest.json',
      });
    });

    it('refuses to write a feed with a missing or empty signature', () => {
      const { dir } = updaterRelease();
      const appImage = `OpenCoven.Chat_${VERSION}_amd64.AppImage`;
      writeFileSync(join(dir, `${appImage}.sig`), '  \n');
      const build = () =>
        buildUpdaterManifest({
          releaseDir: dir,
          version: VERSION,
          tag: TAG,
          repo: 'OpenCoven/chat',
          notes: 'notes',
          pubDate: 'now',
        });
      expect(build).toThrow(`Updater signature ${appImage}.sig is empty.`);
      rmSync(join(dir, `${appImage}.sig`));
      expect(build).toThrow(`Updater artifact ${appImage} has no signature.`);
    });
  });

  it('exits non-zero from the command line on a failure and zero on a clean release', () => {
    const script = join(projectRoot, 'scripts/release-smoke.mjs');
    const root = withoutUpdater();
    const clean = spawnSync(
      process.execPath,
      [script, '--dir', release(), '--version', VERSION, '--root', root, '--allow-unsigned'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({
      ok: true,
      signing: { state: 'unsigned', windows: { state: 'unsigned' } },
    });
    const signedWindows = spawnSync(
      process.execPath,
      [
        script,
        '--dir',
        release(),
        '--version',
        VERSION,
        '--root',
        root,
        '--windows-signing',
        'signed',
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(signedWindows.status).toBe(0);
    expect(JSON.parse(signedWindows.stdout)).toMatchObject({
      signing: { state: 'required', windows: { state: 'signed' } },
    });
    const badFlag = spawnSync(
      process.execPath,
      [script, '--dir', release(), '--version', VERSION, '--windows-signing', 'maybe'],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(badFlag.status).toBe(1);
    expect(badFlag.stderr).toContain('windowsSigning must be one of signed, unsigned');
    const broken = release();
    rmSync(join(broken, 'SHA256SUMS'));
    const failed = spawnSync(
      process.execPath,
      [script, '--dir', broken, '--version', VERSION, '--root', root],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('::error::SHA256SUMS is missing.');
  });
});
