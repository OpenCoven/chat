import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

const [archiveArgument, testArgument, ...extraArguments] = process.argv.slice(2);
assert(
  archiveArgument &&
    (testArgument === undefined || testArgument === '--test') &&
    !extraArguments.length,
  'Usage: node scripts/verify-glib-backport.mjs /path/to/glib-0.18.5.crate [--test]',
);

const archive = resolve(archiveArgument);
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor/glib-0.18.5');
const testLock = join(root, 'vendor/glib-0.18.5.test-Cargo.lock');
const archiveSha256 = '233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5';
const originalSourceSha256 = '1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e';
const patchedSourceSha256 = 'a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc';
const testLockSha256 = 'fa941347aa72e4e7c7076ceb191288a4cc5ee30eea02016bd59c38d50e6b9699';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

assert.equal(sha256(readFileSync(archive)), archiveSha256, 'Published crate checksum mismatch');
assert.equal(
  sha256(readFileSync(testLock)),
  testLockSha256,
  'Upstream test lock checksum mismatch',
);

function files(directory, prefix = '') {
  assert(lstatSync(directory).isDirectory(), `Not a regular directory: ${directory}`);
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), `Unexpected symlink: ${path}`);
      if (stat.isDirectory()) return files(path, relative);
      assert(stat.isFile(), `Not a regular file: ${path}`);
      return [relative];
    });
}

const temporary = createOwnedTempDirectory({ prefix: 'glib-backport' });
try {
  execFileSync('tar', ['-xzf', archive, '-C', temporary.path]);
  const original = join(temporary.path, 'glib-0.18.5');
  const originalFiles = files(original);
  assert.deepEqual(
    files(vendor),
    originalFiles,
    'Vendored file set differs from the published crate',
  );
  for (const path of originalFiles) {
    let expected = readFileSync(join(original, path));
    if (path === 'src/variant_iter.rs') {
      assert.equal(sha256(expected), originalSourceSha256);
      // Exact fix from gtk-rs-core b5a4071e439bef2b5eea76c3aa25e5ae84839e34.
      expected = Buffer.from(
        expected
          .toString('utf8')
          .replace('let p: *mut libc::c_char =', 'let mut p: *mut libc::c_char =')
          .replace('                &p,', '                &mut p,'),
      );
      assert.equal(sha256(expected), patchedSourceSha256);
    }
    assert.deepEqual(
      readFileSync(join(vendor, path)),
      expected,
      `Unexpected vendor changes: ${path}`,
    );
  }
  console.log(
    `Verified ${originalFiles.length} published files; only the upstream two-line fix differs.`,
  );

  if (testArgument === '--test') {
    const patched = join(temporary.path, 'patched');
    cpSync(vendor, patched, { recursive: true });
    copyFileSync(testLock, join(original, 'Cargo.lock'));
    copyFileSync(testLock, join(patched, 'Cargo.lock'));
    const environment = {
      ...process.env,
      CARGO_TARGET_DIR: join(temporary.path, 'baseline-target'),
    };
    const cargoArguments = ['test', '--locked', '--release', '--lib', 'variant_iter'];
    const baseline = spawnSync(
      'cargo',
      [...cargoArguments, '--manifest-path', join(original, 'Cargo.toml')],
      { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (baseline.error) throw baseline.error;
    assert(
      baseline.status === 101 &&
        baseline.stdout.includes('running 11 tests') &&
        baseline.stderr.includes('signal: 11, SIGSEGV'),
      `Pristine optimized SIGSEGV was not reproduced; do not claim before/after success.\n${baseline.stdout}\n${baseline.stderr}`,
    );
    console.log('Pristine optimized upstream iterator tests reproduced SIGSEGV.');

    execFileSync(
      'cargo',
      [...cargoArguments, '--offline', '--manifest-path', join(patched, 'Cargo.toml')],
      {
        cwd: root,
        env: { ...environment, CARGO_TARGET_DIR: join(temporary.path, 'patched-target') },
        stdio: 'inherit',
      },
    );
  }
} finally {
  cleanupOwnedTempRoot(temporary);
}
