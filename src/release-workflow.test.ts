import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(projectRoot, '.github/workflows/release.yml'), 'utf8');
const releasingGuide = readFileSync(resolve(projectRoot, 'docs/releasing.md'), 'utf8');
const securityPolicy = readFileSync(resolve(projectRoot, 'SECURITY.md'), 'utf8');

function job(name: string, nextName?: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  const end = nextName === undefined ? workflow.length : workflow.indexOf(`  ${nextName}:`, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to isolate release workflow job ${name}`);
  }
  return workflow.slice(start, end);
}

describe('release workflow specification', () => {
  test('supports safe rehearsals and verifies the exact remote tag', () => {
    const verify = job('verify-tag', 'build');
    const build = job('build', 'publish');
    const publish = job('publish');

    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*?dry_run:[\s\S]*?default: true/);
    expect(workflow).toContain(
      '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$',
    );
    expect(verify).toContain('GitHub could not verify the signature');
    expect(verify).toContain('is annotated but carries no GPG/SSH signature');
    expect(verify).toContain(`git rev-parse "\${TAG}^{commit}"`);
    expect(verify).toContain('moved after the workflow event');
    expect(verify).toContain('which is not reachable from origin/main');
    expect(verify.indexOf('actions/setup-node@')).toBeLessThan(verify.indexOf('node -p'));
    expect(publish.indexOf('actions/setup-node@')).toBeLessThan(publish.indexOf("node <<'EOF'"));
    expect(build).toContain(`ref: \${{ needs.verify-tag.outputs.sha }}`);
    expect(publish).toContain(`ref: \${{ needs.verify-tag.outputs.sha }}`);
    expect(workflow).toContain("if: needs.verify-tag.outputs.dry_run != 'true'");
    expect(workflow).toContain("if: needs.verify-tag.outputs.dry_run == 'true'");
  });

  test('keeps release artifact and publication hardening in place', () => {
    const verify = job('verify-tag', 'build');
    const build = job('build', 'publish');
    const publish = job('publish');

    expect(verify).toContain('bundle?.active === true');
    for (const command of ['lint', 'typecheck', 'test:unit:normal', 'build']) {
      expect(verify).toContain(`corepack pnpm ${command}`);
    }
    expect(verify).toContain('0.*|*-*) prerelease=true');
    expect(build).toContain('runner: macos-15-intel');
    expect(build).toContain('lipo -archs');
    expect(build).toContain(`dpkg-deb --field "\${deb}" Version`);
    expect(build).toContain('dpkg-deb --contents');
    expect(build).toContain('minimum_size=$((1024 * 1024))');
    expect(build).toContain('certificateThumbprint');
    expect(build).toContain('Get-AuthenticodeSignature');
    expect(build).toContain("if ($signature.Status -ne 'Valid')");
    expect(publish).toMatch(
      /runs-on: ubuntu-latest\s+timeout-minutes: 20\s+environment: release-signing/,
    );
    expect(publish).toContain(`gh release view "\${TAG}"`);
    expect(publish).toContain('--verify-tag');
    expect(publish).toContain('--draft');
    expect(publish).toContain(`gh release edit "\${TAG}"`);
    expect(publish).toContain('Duplicate release asset name');
    expect(publish).toContain('Updater signature is empty');
    expect(publish.indexOf('Generate latest.json updater manifest')).toBeLessThan(
      publish.indexOf('Generate and verify SHA256SUMS'),
    );
    expect(workflow).not.toMatch(/^\s*-\s+run:\s+pnpm\b/m);
    expect(workflow).not.toMatch(/^\s*pnpm exec tauri build/m);
  });

  test('documents conditional updates and the current storage boundary', () => {
    expect(releasingGuide).toContain('conditionally generates the updater manifest');
    expect(releasingGuide).toContain('leave `dry_run` at its default value of `true`');
    expect(releasingGuide).not.toMatch(/^\s*pnpm\b/m);
    expect(securityPolicy).not.toContain('currently `0.0.1`');
    expect(securityPolicy).toContain('## Scope');
    expect(securityPolicy).toContain('does not persist authenticated conversation bodies in');
    expect(securityPolicy).toContain('IndexedDB');
  });
});
