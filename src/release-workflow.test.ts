import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** The shell of the step that `marker` starts, as `os` runs it. */
function stepScript(jobText: string, marker: string, os = 'Linux'): string {
  const step = jobText.slice(jobText.indexOf(marker));
  const body: string[] = [];
  for (const line of step.slice(step.indexOf('run: |')).split('\n').slice(1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n').replaceAll(`\${{ runner.os }}`, os);
}

/**
 * Runs a step's shell with only `env` set, in a directory holding `conf` as
 * src-tauri/tauri.conf.json. `git show <sha>:src-tauri/tauri.conf.json` is
 * answered with the same file, so a step that reads the verified commit sees it.
 */
function runStep(script: string, env: Record<string, string>, conf: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'release-step-'));
  try {
    mkdirSync(join(dir, 'src-tauri'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify(conf));
    writeFileSync(join(dir, 'bin/git'), '#!/bin/sh\ncat src-tauri/tauri.conf.json\n');
    chmodSync(join(dir, 'bin/git'), 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const run = spawnSync('bash', ['-c', script], {
      cwd: dir,
      env: {
        PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        ...env,
      },
      encoding: 'utf8',
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { status: run.status, log: `${run.stdout}${run.stderr}`, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withUpdater = {
  plugins: { updater: { pubkey: 'key', endpoints: ['https://example.invalid/latest.json'] } },
};
const updaterKey = { TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'p' };

/**
 * Runs the build job's `Determine signing availability` step as `os` runs it,
 * for a tree that configures no updater, and returns its status, log and outputs.
 */
function decideSigning(env: Record<string, string>, os = 'Windows') {
  return runStep(stepScript(job('build', 'publish'), '- id: signing', os), env, {});
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
    expect(publish.indexOf('actions/setup-node@')).toBeLessThan(
      publish.indexOf('node scripts/updater-manifest.mjs'),
    );
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
    expect(publish).toContain('node scripts/updater-manifest.mjs');
    expect(publish.indexOf('Generate latest.json updater manifest')).toBeLessThan(
      publish.indexOf('Generate and verify SHA256SUMS'),
    );
    const smoke = publish.indexOf('node scripts/release-smoke.mjs');
    expect(smoke).toBeGreaterThan(publish.indexOf('Generate and verify SHA256SUMS'));
    expect(smoke).toBeLessThan(publish.indexOf('Publish GitHub release'));
    expect(publish).toContain('args+=(--allow-unsigned)');
    // A failing report must still reach the job summary before the step fails.
    expect(publish).toContain(
      `node scripts/release-smoke.mjs "\${args[@]}" > release-smoke.json || status=$?`,
    );
    expect(publish.indexOf(`exit "\${status}"`)).toBeGreaterThan(
      publish.indexOf('echo "### Release smoke test"'),
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

  test('publishes assets under the names GitHub serves them by', () => {
    const publish = job('publish');

    // GitHub turns each space in an uploaded name into a dot. v0.0.2 and
    // v0.0.3 wrote SHA256SUMS with the spaced build names, so `shasum -c`
    // reported every download missing, and latest.json would have pointed the
    // updater at URLs that do not exist. The rename happens while flattening,
    // before either file is written.
    const rename = publish.indexOf(`name="\${name// /.}"`);
    expect(rename).toBeGreaterThan(publish.indexOf('- name: Flatten and inventory artifacts'));
    expect(rename).toBeLessThan(publish.indexOf('Duplicate release asset name'));
    expect(rename).toBeLessThan(publish.indexOf('- name: Generate latest.json updater manifest'));
    expect(rename).toBeLessThan(publish.indexOf('- name: Generate and verify SHA256SUMS'));
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
    ]) {
      expect(verify).toContain(`${secret}: \${{ secrets.${secret} }}`);
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

    // The updater key is required only for a tree that configures the
    // updater, which this early gate cannot see: it runs before the checkout.
    // The name still appears in the comment explaining that, so this checks
    // for the secret actually being bound rather than merely mentioned.
    const requireStep = verify.slice(
      verify.indexOf('- name: Require signing material'),
      verify.indexOf('actions/checkout@'),
    );
    expect(requireStep).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\./);
  });

  test('requires the updater key only for a tree that configures the updater', () => {
    const verify = job('verify-tag', 'build');
    const gate = 'name: Require updater signing when the tree configures the updater';
    // It reads the config from the verified commit, after the tag checks.
    expect(verify.indexOf(gate)).toBeGreaterThan(verify.indexOf('- id: check'));
    expect(verify).toContain(`git show "\${EXPECTED_SHA}:src-tauri/tauri.conf.json"`);
    const script = stepScript(verify, gate);

    const older = runStep(script, { EXPECTED_SHA: 'abc123' }, {});
    expect(older.status).toBe(0);
    expect(older.log).toContain('This tree configures no updater');

    expect(runStep(script, { ...updaterKey, EXPECTED_SHA: 'abc123' }, withUpdater).status).toBe(0);

    const noPassword = runStep(
      script,
      { TAURI_SIGNING_PRIVATE_KEY: 'k', EXPECTED_SHA: 'abc123' },
      withUpdater,
    );
    expect(noPassword.status).toBe(1);
    expect(noPassword.log).toContain(
      'This tree configures the updater, but release-signing is missing TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    );

    const rehearsal = runStep(
      script,
      { ALLOW_UNSIGNED: 'true', EXPECTED_SHA: 'abc123' },
      withUpdater,
    );
    expect(rehearsal.status).toBe(0);
    expect(rehearsal.log).toContain('This rehearsal builds no updater artifacts');
  });

  test('turns the updater on only with the configuration and both secrets', () => {
    const build = job('build', 'publish');
    const script = stepScript(build, '- id: signing');

    const older = runStep(script, updaterKey, {});
    expect(older.status).toBe(0);
    expect(older.outputs.updater).toBe('off');
    expect(older.log).toContain('This tree configures no updater');

    expect(runStep(script, updaterKey, withUpdater).outputs.updater).toBe('on');

    // A re-run of failed jobs skips verify-tag, so the build refuses too.
    const emptied = runStep(script, { TAURI_SIGNING_PRIVATE_KEY: 'k' }, withUpdater);
    expect(emptied.status).toBe(1);
    expect(emptied.log).toContain('refusing to build a release that cannot update anyone');

    const rehearsal = runStep(script, { ALLOW_UNSIGNED: 'true' }, withUpdater);
    expect(rehearsal.status).toBe(0);
    expect(rehearsal.outputs.updater).toBe('off');
    expect(build).toContain(`updater: \${{ steps.signing.outputs.updater }}`);
  });

  test('builds updater artifacts through a release-only overlay and stages the v2 names', () => {
    const build = job('build', 'publish');
    const overlay = build.slice(
      build.indexOf('- name: Configure updater artifacts'),
      build.indexOf('- name: Build installers'),
    );
    expect(overlay).toContain("if: steps.signing.outputs.updater == 'on'");
    expect(overlay).toContain('{ "bundle": { "createUpdaterArtifacts": true } }');
    expect(overlay).toContain('TAURI_UPDATER_OVERLAY=src-tauri/release-updater.conf.json');
    // Both overlays reach tauri build, the signing one first.
    expect(build).toContain(
      `for overlay in "\${TAURI_CONFIG_OVERLAY:-}" "\${TAURI_UPDATER_OVERLAY:-}"; do`,
    );
    const cleanup = build.slice(build.indexOf('- name: Remove updater overlay'));
    expect(cleanup).toMatch(/^- name: Remove updater overlay\s+if: always\(\)\s/);
    expect(cleanup).toContain('rm -f src-tauri/release-updater.conf.json');

    const stage = build.slice(build.indexOf('- name: Stage artifacts'));
    for (const glob of [
      'msi/*.msi.sig',
      'nsis/*.exe.sig',
      'appimage/*.AppImage.sig',
      'deb/*.deb.sig',
      'macos/*.app.tar.gz.sig',
    ]) {
      expect(stage).toContain(glob);
    }
    for (const legacy of ['.msi.zip', '.nsis.zip', '.AppImage.tar.gz']) {
      expect(stage.slice(0, stage.indexOf('- name: Smoke-test artifacts'))).not.toContain(legacy);
    }
  });

  test('writes the feed and moves the pointer release only for a published updater run', () => {
    const publish = job('publish');
    const manifest = publish.slice(
      publish.indexOf('- name: Generate latest.json updater manifest'),
      publish.indexOf('- name: Generate and verify SHA256SUMS'),
    );
    expect(manifest).toContain(`UPDATER: \${{ needs.build.outputs.updater }}`);
    expect(manifest).toContain('the build jobs reported the updater off');
    // Older trees get neither the generator nor the smoke flag.
    expect(publish).toContain(
      `if [ "\${UPDATER}" = "on" ]; then\n            args+=(--updater on)`,
    );

    const pointer = publish.slice(
      publish.indexOf('- name: Point the auto-update feed at this release'),
    );
    expect(publish.indexOf('- name: Point the auto-update feed at this release')).toBeGreaterThan(
      publish.indexOf('- name: Publish GitHub release'),
    );
    expect(pointer).toContain(
      "if: needs.verify-tag.outputs.dry_run != 'true' && needs.build.outputs.updater == 'on'",
    );
    expect(pointer).toContain('Refusing to move the auto-update feed from an allow_unsigned run');
    expect(pointer).toContain('--prerelease --latest=false');
    expect(pointer).toContain(
      `gh release upload updater release/latest.json --repo "\${REPO}" --clobber`,
    );
    expect(pointer).toContain('releases/download/updater/latest.json');
    expect(pointer).toContain('cmp -s served-latest.json release/latest.json');
  });

  test('never publishes an allow_unsigned build', () => {
    const verify = job('verify-tag', 'build');
    const publish = job('publish');
    const publishStep = publish.slice(
      publish.indexOf('- name: Publish GitHub release'),
      publish.indexOf('- name: Summarize dry run'),
    );

    // Refused while the tag is resolved, so a mistaken dispatch costs seconds
    // rather than four platform builds and a published unsigned release.
    const guard = verify.indexOf('allow_unsigned=true is for rehearsals only');
    expect(verify).toContain(`INPUT_ALLOW_UNSIGNED: \${{ inputs.allow_unsigned }}`);
    expect(guard).toBeGreaterThan(verify.indexOf('dry_run=true'));
    expect(guard).toBeLessThan(verify.indexOf('>> "$GITHUB_OUTPUT"'));
    expect(guard).toBeLessThan(verify.indexOf('Require signing material'));

    // And again where the release is created, ahead of `gh release create`.
    expect(publishStep).toContain(`ALLOW_UNSIGNED: \${{ inputs.allow_unsigned }}`);
    expect(publishStep.indexOf('Refusing to publish an allow_unsigned build')).toBeGreaterThan(-1);
    expect(publishStep.indexOf('Refusing to publish an allow_unsigned build')).toBeLessThan(
      publishStep.indexOf('gh release create'),
    );
    expect(releasingGuide).toContain('An `allow_unsigned` run never publishes');
  });

  test('notarizes with an App Store Connect API key when one is configured', () => {
    const verify = job('verify-tag', 'build');
    const build = job('build', 'publish');
    const buildStep = build.slice(
      build.indexOf('- name: Build installers'),
      build.indexOf('- name: Remove the notarization key'),
    );

    // Either credential set satisfies the gate; the API key is preferred.
    for (const secret of ['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_BASE64']) {
      expect(verify).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(buildStep).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
    expect(verify).toContain('or APPLE_ID+APPLE_PASSWORD');
    expect(build).toContain('notary=api-key');

    // Tauri prefers the Apple ID when all three of its variables are set, so
    // the build drops the pair when a key is in use, writes the key for this
    // build only, and a later step removes it whatever happened.
    expect(buildStep).toContain('export APPLE_API_KEY_PATH=');
    expect(buildStep).toContain('unset APPLE_ID APPLE_PASSWORD');
    expect(build).toMatch(
      /- name: Remove the notarization key\n\s+if: always\(\) && runner\.os == 'macOS'/,
    );
  });

  test('notarizes and staples the disk images, not only the app inside', () => {
    const build = job('build', 'publish');
    const step = (name: string) => build.indexOf(`- name: ${name}`);
    const notarize = build.slice(
      step('Notarize and staple the disk images'),
      step('Remove the notarization key'),
    );
    const smoke = build.slice(step('Smoke-test artifacts'));

    // Tauri notarizes the .app and then wraps it in a .dmg it never submits,
    // so v0.0.2 and v0.0.3 shipped images Gatekeeper reports as "Unnotarized
    // Developer ID" (#407). The images go to Apple after the build, while the
    // key file still exists, and before anything is staged.
    expect(step('Build installers')).toBeLessThan(step('Notarize and staple the disk images'));
    expect(step('Notarize and staple the disk images')).toBeLessThan(
      step('Remove the notarization key'),
    );
    expect(step('Remove the notarization key')).toBeLessThan(step('Stage artifacts'));
    expect(notarize).toContain(
      "if: runner.os == 'macOS' && steps.signing.outputs.macos_signed == 'true'",
    );
    expect(notarize).toContain(`"\${RUNNER_TEMP}/AuthKey_\${APPLE_API_KEY}.p8"`);
    expect(notarize).toContain('xcrun notarytool submit');
    expect(notarize).toContain(`if [ "\${status}" != "Accepted" ]; then`);
    // stapler reaches api.apple-cloudkit.com for both staple and validate,
    // and exit 68 covers a dropped connection as well as a missing ticket;
    // three Intel jobs failed that way on 2026-10-14 after the ticket was
    // issued (#461). Both steps therefore retry each call.
    expect(notarize).toContain('stapler_retry() {');
    expect(notarize).toContain(`stapler_retry staple "\${dmg}"`);
    expect(notarize).toContain(`stapler_retry validate "\${dmg}"`);

    // The artifact check holds the staged image to the same standard.
    expect(smoke).toContain('stapler_retry() {');
    expect(smoke).toContain(`stapler_retry validate "\${dmg}"`);
    expect(smoke).not.toContain(`xcrun stapler validate "\${dmg}"`);
    expect(smoke).toContain(
      `spctl --assess --type open --context context:primary-signature --verbose=2 "\${dmg}"`,
    );
  });

  test('refuses to build or stage an unsigned artifact on the production path', () => {
    const build = job('build', 'publish');
    const signing = build.slice(
      build.indexOf('name: Determine signing availability'),
      build.indexOf('- name: Import Windows signing certificate'),
    );
    const smoke = build.slice(build.indexOf('- name: Smoke-test artifacts'));

    // verify-tag's gate runs once per run; a re-run of failed jobs re-reads
    // the secrets here. An empty APPLE_ID on 2026-10-07 built and published
    // unsigned through the warning below, so missing material is a failure
    // unless the run was dispatched with allow_unsigned.
    expect(signing).toContain(`ALLOW_UNSIGNED: \${{ inputs.allow_unsigned }}`);
    expect(signing).toContain('refusing to build unsigned');
    expect(signing.indexOf('refusing to build unsigned')).toBeLessThan(
      signing.indexOf('producing an UNSIGNED, un-notarized macOS build'),
    );

    // And the artifact check only skips codesign/spctl for that rehearsal.
    expect(smoke).toContain(`ALLOW_UNSIGNED: \${{ inputs.allow_unsigned }}`);
    expect(smoke).toMatch(
      /\[ "\$\{MACOS_SIGNED\}" = "true" \] \|\| \[ "\$\{ALLOW_UNSIGNED:-false\}" != "true" \]/,
    );
    expect(smoke).not.toContain('(unsigned build: skipping codesign/spctl)');
  });

  test('ships Windows unsigned by decision, and says so wherever it matters', () => {
    const verify = job('verify-tag', 'build');
    const build = job('build', 'publish');
    const publish = job('publish');
    const signing = build.slice(
      build.indexOf('name: Determine signing availability'),
      build.indexOf('- name: Import Windows signing certificate'),
    );
    const windowsCheck = build.slice(
      build.indexOf('- name: Verify Windows installer metadata and signatures'),
      build.indexOf('uses: actions/upload-artifact@'),
    );

    // Windows builds on every path (decided 2026-10-14; #411 tracks signing).
    // The runner is pinned by name so a tag always builds on the image it was
    // rehearsed on.
    for (const platform of ['macos-aarch64', 'macos-x86_64', 'windows-x86_64', 'linux-x86_64']) {
      expect(build).toMatch(new RegExp(`^\\s+- platform: ${platform}$`, 'm'));
    }
    expect(build).toMatch(
      /runner: windows-2025\s+target: x86_64-pc-windows-msvc\s+bundles: msi,nsis/,
    );

    // The gate does not wait on Windows secrets, and the build job does not
    // refuse their absence. A half-set is still refused on the production
    // path, and the signing steps stay in place for when both exist.
    expect(verify).not.toMatch(/WINDOWS_CERTIFICATE: \$\{\{ secrets\./);
    expect(signing).toContain('the Windows installers in this release are UNSIGNED');
    expect(signing).not.toContain(
      'Windows signing material is absent or incomplete on the production path',
    );
    expect(signing).toContain(
      'Only one of WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD is set',
    );
    expect(build).toContain('Import Windows signing certificate');
    expect(build).toContain('Configure Tauri Windows signing');

    // The installers' version and product name are read back from the files
    // Windows shows people, and the Authenticode state is held to the signing
    // step's decision in both directions.
    expect(windowsCheck).toContain("if: runner.os == 'Windows'");
    expect(windowsCheck).toContain(`EXPECTED_VERSION: \${{ needs.verify-tag.outputs.version }}`);
    expect(windowsCheck).toContain("WHERE Property = '$property'");
    expect(windowsCheck).toContain('$installer.VersionInfo.ProductVersion');
    expect(windowsCheck).toContain("if ($signature.Status -ne 'Valid')");
    expect(windowsCheck).toContain("if ($signature.Status -ne 'NotSigned')");

    // The decision reaches the publish job: the smoke report records it, and
    // the generated release body tells Windows users what SmartScreen will do.
    expect(build).toContain(`windows_signed: \${{ steps.signing.outputs.windows_signed }}`);
    expect(publish).toContain(`WINDOWS_SIGNED: \${{ needs.build.outputs.windows_signed }}`);
    expect(publish).toContain('args+=(--windows-signing unsigned)');
    expect(publish).toContain('args+=(--windows-signing signed)');
    expect(publish).toContain('**Run anyway**');
    expect(releasingGuide).toContain('SmartScreen');
    expect(releasingGuide).not.toContain('Windows is deferred');
  });

  test('signs Windows through eSigner or a .pfx, never both, never half', () => {
    const pfx = { WINDOWS_CERTIFICATE: 'cGZ4', WINDOWS_CERTIFICATE_PASSWORD: 'secret' };
    const esigner = {
      ES_USERNAME: 'owner@example.com',
      ES_PASSWORD: 'secret',
      ES_CREDENTIAL_ID: 'credential',
      ES_TOTP_SECRET: 'BASE32SECRET',
    };

    const unsigned = decideSigning({});
    expect(unsigned.status).toBe(0);
    expect(unsigned.outputs).toMatchObject({ windows_signed: 'false', windows_route: 'none' });
    expect(unsigned.log).toContain('the Windows installers in this release are UNSIGNED');

    const half = decideSigning({ WINDOWS_CERTIFICATE: 'cGZ4' });
    expect(half.status).toBe(1);
    expect(half.log).toContain('Only one of WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD');
    const halfRehearsal = decideSigning({ WINDOWS_CERTIFICATE: 'cGZ4', ALLOW_UNSIGNED: 'true' });
    expect(halfRehearsal.status).toBe(0);
    expect(halfRehearsal.outputs.windows_signed).toBe('false');

    expect(decideSigning(pfx).outputs).toMatchObject({
      windows_signed: 'true',
      windows_route: 'pfx',
    });
    expect(decideSigning(esigner).outputs).toMatchObject({
      windows_signed: 'true',
      windows_route: 'esigner',
    });

    const { ES_TOTP_SECRET: _omitted, ...threeOfFour } = esigner;
    const partial = decideSigning(threeOfFour);
    expect(partial.status).toBe(1);
    expect(partial.log).toContain('Only 3 of the four eSigner secrets');
    expect(decideSigning({ ...threeOfFour, ALLOW_UNSIGNED: 'true' }).outputs.windows_signed).toBe(
      'false',
    );

    const both = decideSigning({ ...pfx, ...esigner });
    expect(both.status).toBe(1);
    expect(both.log).toContain('Both a .pfx (WINDOWS_CERTIFICATE) and the eSigner secrets');

    // The other platforms build whatever Windows is configured with.
    expect(decideSigning({ ...pfx, ...esigner }, 'Linux').status).toBe(0);
  });

  test('installs a pinned CodeSignTool, hands Tauri its wrapper, and checks the publisher', () => {
    const verify = job('verify-tag', 'build');
    const build = job('build', 'publish');
    const step = (name: string, next: string) =>
      build.slice(build.indexOf(`- name: ${name}`), build.indexOf(`- name: ${next}`));
    const importStep = step('Import Windows signing certificate', 'Install SSL.com CodeSignTool');
    const install = step('Install SSL.com CodeSignTool', 'Configure Tauri Windows signing');
    const configure = step('Configure Tauri Windows signing', 'Build installers');
    const buildStep = build.slice(build.indexOf('- name: Build installers'));
    const cleanup = step('Remove Windows signing overlay', 'Stage artifacts');
    const windowsCheck = build.slice(
      build.indexOf('- name: Verify Windows installer metadata and signatures'),
      build.indexOf('uses: actions/upload-artifact@'),
    );

    // Each route gets only its own setup.
    expect(importStep).toContain("steps.signing.outputs.windows_route == 'pfx'");
    expect(install).toContain("steps.signing.outputs.windows_route == 'esigner'");

    // CodeSignTool is fetched by exact version and checked against a pinned hash.
    expect(install).toContain(
      'CODESIGNTOOL_URL: https://github.com/SSLcom/CodeSignTool/releases/download/v1.3.2/CodeSignTool-v1.3.2.zip',
    );
    expect(install).toMatch(/CODESIGNTOOL_SHA256: [0-9a-f]{64}\n/);
    expect(install).toContain('if ($hash -ne $env:CODESIGNTOOL_SHA256)');
    // The wrapper fails on CodeSignTool's output as well as its exit code.
    expect(install).toContain("'Error|Exception|Missing required option|Unmatched argument'");
    expect(install).toContain('"-input_file_path=$File"');

    // Tauri calls the wrapper once per file, with the file as one argument.
    expect(configure).toContain("process.env.WINDOWS_ROUTE === 'esigner'");
    expect(configure).toContain(
      "args: ['-NoProfile', '-NonInteractive', '-File', process.env.ESIGNER_WRAPPER, '%1']",
    );
    expect(configure).toContain(
      'certificateThumbprint: process.env.WINDOWS_CERTIFICATE_THUMBPRINT',
    );
    for (const name of ['ES_USERNAME', 'ES_PASSWORD', 'ES_CREDENTIAL_ID', 'ES_TOTP_SECRET']) {
      expect(buildStep).toContain(`${name}: \${{ secrets.${name} }}`);
      // Not required yet: the account doesn't exist, and Windows still ships unsigned.
      expect(verify).not.toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(cleanup).toContain(`"\${RUNNER_TEMP}/CodeSignTool" "\${RUNNER_TEMP}/esigner-sign.ps1"`);
    expect(build).toContain(`windows_signed: \${{ steps.signing.outputs.windows_signed }}`);

    // A signed installer must be Valid and signed by WINDOWS_PUBLISHER.
    expect(windowsCheck).toContain(`WINDOWS_PUBLISHER: \${{ vars.WINDOWS_PUBLISHER }}`);
    expect(windowsCheck).toContain('WINDOWS_PUBLISHER is not set');
    expect(windowsCheck).toContain("GetNameInfo('SimpleName', $false)");
    expect(windowsCheck.indexOf("if ($signature.Status -ne 'Valid')")).toBeLessThan(
      windowsCheck.indexOf("expected '$env:WINDOWS_PUBLISHER'"),
    );
    expect(releasingGuide).toContain('### Signing the Windows installers');
    expect(releasingGuide).toContain('`ES_TOTP_SECRET`');
    expect(releasingGuide).not.toContain('WINDOWS_SIGN_COMMAND');
  });

  test('documents conditional updates and the current storage boundary', () => {
    expect(releasingGuide).toContain(
      'generates the updater feed when the tagged tree configures auto-update',
    );
    expect(releasingGuide).toContain('leave `dry_run` at its default value of `true`');
    expect(releasingGuide).not.toMatch(/^\s*pnpm\b/m);
    expect(securityPolicy).not.toContain('currently `0.0.1`');
    expect(securityPolicy).toContain('## Scope');
    expect(securityPolicy).toContain('does not persist authenticated conversation bodies in');
    expect(securityPolicy).toContain('IndexedDB');
  });
});
