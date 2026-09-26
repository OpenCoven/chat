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
    // The original awk form could never pass: inside an awk regex literal the
    // unescaped `/` in `[^/[:space:]]` ends the literal, so awk died on a
    // syntax error and `!` read that as "no payload" for every .deb. Staging
    // failed earlier for so long that nothing ever reached the assertion.
    expect(build).not.toContain(String.raw`awk '/\.\/usr`);
    // The `./` prefix must stay optional: dpkg-deb on ubuntu-22.04 lists
    // `usr/bin/opencoven-chat` with no leading `./`.
    expect(build).toContain(
      String.raw`grep -qE '^-[rwxsStT-]{2}x.*[[:space:]](\./)?usr/bin/[^[:space:]]'`,
    );
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

  test('stages installers outside the frontend build output', () => {
    const build = job('build', 'publish');

    // `dist/` is Vite's output directory (tauri.conf.json beforeBuildCommand
    // `pnpm build`, frontendDist `../dist`), so it already holds index.html and
    // assets/ by the time bundling ends. Staging installers on top of it made
    // the 1 MiB size floor reject the 399-byte index.html, and uploaded the web
    // assets as release artifacts where they collided across platforms in the
    // publish job's duplicate-name check. Both only ever surfaced in a real
    // pipeline run, which is why they are asserted here.
    expect(build).toContain('STAGE_DIR: release-staging');
    expect(build).toContain(`mkdir -p "\${STAGE_DIR}"`);
    expect(build).toContain(`cp -v "\${f}" "\${STAGE_DIR}/"`);
    expect(build).toContain(`for artifact in "\${STAGE_DIR}"/*; do`);
    expect(build).toContain(`cd "\${STAGE_DIR}"`);
    expect(build).toContain(`path: \${{ env.STAGE_DIR }}/**`);
    expect(build).toContain('Get-ChildItem -Path "$env:STAGE_DIR/*"');

    // macOS runners ship bash 3.2, so `shopt -s globstar` (bash 4.0+) aborts
    // the step under `set -e`. This surfaced only once the macOS build got far
    // enough to stage at all, and nothing here needs `**`.
    expect(build).toMatch(/shopt -s nullglob$/m);
    expect(build).not.toMatch(/shopt -s [^\n]*globstar/);

    // No step may reach back into the frontend output directory.
    for (const forbidden of [
      'mkdir -p dist',
      `cp -v "\${f}" dist/`,
      'for artifact in dist/*',
      'cd dist',
      'path: dist/**',
      "Get-ChildItem -Path 'dist/*'",
    ]) {
      expect(build).not.toContain(forbidden);
    }
  });

  test('never hands Tauri incomplete Apple credentials', () => {
    const build = job('build', 'publish');

    // A missing secret arrives as the empty string rather than an unset
    // variable, and Tauri reads a defined APPLE_CERTIFICATE as "sign this" --
    // then runs `security import` with an empty -P and dies. The unsigned
    // rehearsal that allow_unsigned promises depends on these being removed.
    expect(build).toContain(`MACOS_SIGNED: \${{ steps.signing.outputs.macos_signed }}`);
    expect(build).toMatch(
      /if \[ "\$\{RUNNER_OS\}" = "macOS" \] && \[ "\$\{MACOS_SIGNED\}" != "true" \]; then\s+unset APPLE_CERTIFICATE/,
    );

    // "Signed" has to mean every credential the signing path consumes. Deciding
    // it from the certificate alone let a partial environment claim signed=true
    // under allow_unsigned, skip the unsets, and fail the bundle anyway.
    for (const secret of [
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(build).toMatch(new RegExp(`\\[ -n "\\$\\{${secret}:-\\}" \\]`));
    }
    expect(build).toMatch(/\[ -n "\$\{WINDOWS_CERTIFICATE_PASSWORD:-\}" \]/);
  });

  test('verifies the package contract before the tag check and every platform build', () => {
    const verify = job('verify-tag', 'build');
    const step = verify.indexOf('run: node scripts/verify-package.mjs');
    expect(step).toBeGreaterThan(-1);
    // After checkout (it reads the tagged tree), before the tag check and so
    // before the build job, which needs verify-tag.
    expect(step).toBeGreaterThan(verify.indexOf('uses: actions/checkout@'));
    expect(step).toBeLessThan(
      verify.indexOf('Verify tag is annotated, signed, and version-consistent'),
    );
    expect(job('build', 'publish')).toContain('needs: verify-tag');
  });

  test('refuses to release without platform signing material', () => {
    const verify = job('verify-tag', 'build');

    // The gate belongs in verify-tag, not in build. Failing here costs seconds;
    // failing in build costs four platform runners and burns the tag, which
    // cannot be reused once a Release exists for it.
    expect(verify).toContain('Require signing material');
    expect(verify).toContain('Missing signing secrets in the release-signing environment');

    // Every secret that a signed, notarized release actually needs. Dropping
    // one from the workflow should fail this list, not ship unsigned.
    for (const secret of [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_PASSWORD',
    ]) {
      expect(verify).toContain(secret);
    }

    // The gate runs before the tree is fetched, so a missing secret is not paid
    // for with a checkout, an install and a test run.
    expect(verify.indexOf('Require signing material')).toBeLessThan(
      verify.indexOf('actions/checkout@'),
    );

    // The escape hatch is dispatch-only. `inputs` is empty on a tag push, so a
    // production release cannot opt out of signing however it is triggered.
    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*?allow_unsigned:[\s\S]*?default: false/);
    expect(verify).toContain(`ALLOW_UNSIGNED: \${{ inputs.allow_unsigned }}`);

    // Auto-update is opt-in, so the updater key must not be treated as
    // mandatory; requiring it would block every release until § 4 is done.
    // The name still appears in the comment explaining that exemption, so this
    // checks for the secret actually being bound rather than merely mentioned.
    expect(verify).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\./);
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
