// Build-only ALSA headers for the exact engine's default voice feature. Nothing
// is installed into the CI image and no producer feature is disabled.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readVerifiedPackage(response, size, sha256) {
  if (!response.ok) throw new Error(`Build-header download returned HTTP ${response.status}`);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024)
    throw new Error('Invalid build-header size bound');
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== size) throw new Error('Build-header size mismatch');
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > size) {
      await reader.cancel();
      throw new Error('Build-header size exceeds bound');
    }
    chunks.push(Buffer.from(value));
  }
  if (count !== size) throw new Error('Build-header size mismatch');
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error('Build-header digest mismatch');
  return bytes;
}

export async function prepareLinuxBuildDependencies(root, buildEnv, execute) {
  if (process.platform !== 'linux') return null;
  if (process.arch !== 'x64') throw new Error('Candidate build headers require Linux x64');
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'linux-build-deps.json'), 'utf8'),
  );
  const url = new URL(manifest.url);
  if (
    manifest.purpose !== 'linux-x64-candidate-build-headers' ||
    url.origin !== 'https://archive.ubuntu.com' ||
    !url.pathname.startsWith('/ubuntu/pool/main/a/alsa-lib/libasound2-dev_') ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw new Error('Invalid Linux build-header identity');
  // Playwright's pinned Ubuntu image already supplies the ALSA runtime. Keep
  // that system library, and stage only the missing development files.
  const runtime = realpathSync('/usr/lib/x86_64-linux-gnu/libasound.so.2');
  const bytes = await readVerifiedPackage(
    await fetch(manifest.url, { signal: AbortSignal.timeout(30_000) }),
    manifest.size,
    manifest.sha256,
  );
  const archive = join(root, 'alsa-build-headers.deb');
  writeFileSync(archive, bytes, { flag: 'wx' });
  const directory = join(root, 'linux-build-sysroot');
  mkdirSync(directory);
  const log = join(root, 'linux-build-deps.log');
  execute('dpkg-deb', ['--extract', archive, directory], root, buildEnv, log);
  const lib = join(directory, 'usr/lib/x86_64-linux-gnu');
  if (readlinkSync(join(lib, 'libasound.so')) !== 'libasound.so.2.0.0')
    throw new Error('Unexpected ALSA development linker target');
  symlinkSync(runtime, join(lib, 'libasound.so.2.0.0'));
  const pc = join(lib, 'pkgconfig/alsa.pc');
  const text = readFileSync(pc, 'utf8');
  if (!text.includes('prefix=/usr\n') || !text.includes('exec_prefix=/usr\n'))
    throw new Error('Unexpected ALSA pkg-config layout');
  writeFileSync(
    pc,
    text
      .replace(/^prefix=\/usr$/m, `prefix=${join(directory, 'usr')}`)
      .replace(/^exec_prefix=\/usr$/m, `exec_prefix=${join(directory, 'usr')}`),
  );
  const environment = {
    ...buildEnv,
    PKG_CONFIG_PATH: `${join(lib, 'pkgconfig')}${buildEnv.PKG_CONFIG_PATH ? `:${buildEnv.PKG_CONFIG_PATH}` : ''}`,
  };
  execute('pkg-config', ['--exists', '--print-errors', 'alsa'], root, environment, log);
  execute('pkg-config', ['--libs', '--cflags', 'alsa'], root, environment, log);
  const receipt = {
    ...manifest,
    directory,
    systemRuntime: runtime,
    systemRuntimeSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
    pkgConfigPath: environment.PKG_CONFIG_PATH,
  };
  writeFileSync(join(root, 'linux-build-deps.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return { environment, receipt };
}
