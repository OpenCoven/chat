import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type CapabilityFile = {
  $schema?: string;
  permissions: unknown[];
  windows: string[];
};

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const projectRoot = process.cwd();

function readText(relativePath: string) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T;
}

function listRuntimeSourceFiles(relativePath: string): string[] {
  const absolutePath = resolve(projectRoot, relativePath);
  const entries = readdirSync(absolutePath);
  const files: string[] = [];

  for (const entry of entries) {
    const childRelativePath = `${relativePath}/${entry}`;
    const childAbsolutePath = resolve(projectRoot, childRelativePath);
    const stats = statSync(childAbsolutePath);

    if (stats.isDirectory()) {
      files.push(...listRuntimeSourceFiles(childRelativePath));
      continue;
    }

    if (
      !/\.(ts|tsx)$/.test(entry) ||
      /\.test\.(ts|tsx)$/.test(entry) ||
      childRelativePath.endsWith('vite-env.d.ts')
    ) {
      continue;
    }

    files.push(childRelativePath);
  }

  return files.sort();
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

  it('derives native identity name and identifier from tauri.conf.json', () => {
    const buildScript = readText('src-tauri/build.rs');
    const metadata = readText('src-tauri/src/metadata.rs');

    expect(buildScript).toContain('cargo:rerun-if-changed=tauri.conf.json');
    expect(buildScript).toContain('OPENCOVEN_PRODUCT_NAME');
    expect(buildScript).toContain('OPENCOVEN_APP_IDENTIFIER');
    expect(metadata).toContain('env!("OPENCOVEN_PRODUCT_NAME")');
    expect(metadata).toContain('env!("OPENCOVEN_APP_IDENTIFIER")');
  });

  it('pins Playwright to a dedicated fresh preview server', () => {
    const playwrightConfig = readText('playwright.config.ts');
    const packageManifest = readJson<PackageManifest>('package.json');

    expect(playwrightConfig).toContain("const previewUrl = 'http://127.0.0.1:4174';");
    expect(playwrightConfig).toMatch(/reuseExistingServer:\s*false/);
    expect(playwrightConfig).toMatch(/command:\s*'corepack pnpm build && corepack pnpm preview'/);
    expect(packageManifest.scripts?.['install:clean']).toBe(
      'corepack pnpm install --frozen-lockfile',
    );
    expect(packageManifest.scripts?.test).toBe('vitest run');
    expect(packageManifest.scripts?.preview).toContain('--port 4174');
  });

  it('keeps runtime source free from ad hoc Cave networking primitives', () => {
    const disallowedPatterns = [
      /\bfetch\s*\(/,
      /\bHeaders\b/,
      /\bAuthorization\b/,
      /\bBearer\b/,
      /https?:\/\//,
    ];

    const violations: string[] = [];

    for (const file of listRuntimeSourceFiles('src')) {
      const source = readText(file);

      for (const pattern of disallowedPatterns) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('documents the package boundary without a local cave-client dependency', () => {
    const packageManifest = readJson<PackageManifest>('package.json');
    const readme = readText('README.md');
    const boundary = readText('src/lib/cave-client-boundary.ts');

    expect(packageManifest.dependencies?.['@opencoven/cave-client']).toBeUndefined();
    expect(packageManifest.devDependencies?.['@opencoven/cave-client']).toBeUndefined();
    expect(boundary).toContain('cross-repository canary verifies packed');
    expect(boundary).toContain('instead of adding a local path dependency');
    expect(readme).toContain('cross-repository canary');
    expect(readme).toContain('packed `@opencoven/cave-client` tarballs');
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
