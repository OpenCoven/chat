import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type CapabilityFile = {
  $schema?: string;
  permissions: unknown[];
  windows: string[];
};

type PackageManifest = {
  scripts?: Record<string, string>;
};

const projectRoot = process.cwd();

function readText(relativePath: string) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T;
}

describe('Phase 0 specification guards', () => {
  it('ignores sibling worktrees from the repository root', () => {
    const output = execFileSync(
      'git',
      ['-C', projectRoot, 'check-ignore', '-v', '.worktrees/spec-gap-probe'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('.gitignore');
    expect(output).toContain('/.worktrees');
  });

  it('keeps the default Tauri capability least-privileged for app_identity', () => {
    const capability = JSON.parse(
      readText('src-tauri/capabilities/default.json'),
    ) as CapabilityFile;

    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toEqual(['allow-app-identity']);

    for (const permission of capability.permissions) {
      expect(typeof permission).toBe('string');

      if (typeof permission !== 'string') {
        continue;
      }

      expect(permission).not.toMatch(/:default$/);
      expect(permission).not.toMatch(/^(shell|fs|filesystem|opener|http|https|network):/);
    }
  });

  it('keeps the capability schema resolvable from a fresh checkout', () => {
    const capability = readJson<CapabilityFile>('src-tauri/capabilities/default.json');
    const schemaPath = resolve(projectRoot, 'src-tauri/capabilities', capability.$schema ?? '');

    expect(capability.$schema).toBe('../gen/schemas/desktop-schema.json');
    expect(existsSync(schemaPath)).toBe(true);
    expect(readText('.gitignore')).toContain('!src-tauri/gen/schemas/desktop-schema.json');
    expect(
      execFileSync(
        'git',
        [
          '-C',
          projectRoot,
          'check-ignore',
          '-v',
          '--no-index',
          'src-tauri/gen/schemas/desktop-schema.json',
        ],
        {
          encoding: 'utf8',
        },
      ),
    ).toContain('!src-tauri/gen/schemas/desktop-schema.json');
  });

  it('autogenerates app command permissions only for app_identity', () => {
    const buildScript = readText('src-tauri/build.rs');

    expect(buildScript).toMatch(/AppManifest::new\(\)\s*\.commands\(&\["app_identity"\]\)/);
  });

  it('pins Playwright to a dedicated fresh preview server', () => {
    const playwrightConfig = readText('playwright.config.ts');
    const packageManifest = readJson<PackageManifest>('package.json');

    expect(playwrightConfig).toContain("const previewUrl = 'http://127.0.0.1:4174';");
    expect(playwrightConfig).toMatch(/reuseExistingServer:\s*false/);
    expect(playwrightConfig).toMatch(/command:\s*'corepack pnpm build && corepack pnpm preview'/);
    expect(packageManifest.scripts?.preview).toContain('--port 4174');
  });

  it('runs the desktop entrypoint in CI with Linux Tauri dependencies', () => {
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toMatch(/name:\s*Desktop build/);
    expect(workflow).toMatch(/sudo apt-get update/);
    expect(workflow).toMatch(/sudo apt-get install -y[\s\S]*libwebkit2gtk-4\.1-dev/);
    expect(workflow).toContain('libayatana-appindicator3-dev');
    expect(workflow).toContain('librsvg2-dev');
    expect(workflow).toContain('libxdo-dev');
    expect(workflow).toContain('patchelf');
    expect(workflow).toMatch(/- run: pnpm app:build/);
  });
});
