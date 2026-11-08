#!/usr/bin/env node
// Seed Tauri's disposable CI tool cache through the authenticated GitHub API.
// The versions are the ones used by tauri-cli-v2.11.4, not alternate bundlers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOLS = {
  apprun: {
    name: 'AppRun-x86_64',
    repository: 'tauri-apps/binary-releases',
    id: 274691722,
    size: 31552,
    sha256: 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f',
  },
  linuxdeploy: {
    name: 'linuxdeploy-x86_64.AppImage',
    repository: 'tauri-apps/binary-releases',
    id: 182515537,
    size: 13264064,
    sha256: 'e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef',
  },
  // SHA-256 is also pinned by Tauri's windows/msi/mod.rs at tauri-cli-v2.11.4.
  wix: {
    name: 'wix314-binaries.zip',
    repository: 'wixtoolset/wix3',
    id: 158158052,
    size: 41297555,
    sha256: '6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31',
  },
};

export async function downloadVerifiedTool(tool, token, fetcher = fetch) {
  if (!token) throw new Error('A read-only GitHub token is required to prepare bundler tools.');
  let url = new URL(`https://api.github.com/repos/${tool.repository}/releases/assets/${tool.id}`);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (
      url.protocol !== 'https:' ||
      ![
        'api.github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(url.hostname)
    ) {
      throw new Error(`Unexpected download host for ${tool.name}.`);
    }
    const headers = { Accept: 'application/octet-stream' };
    // Never forward the token to the release-asset storage host.
    if (url.hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`Missing download redirect for ${tool.name}.`);
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Cannot download ${tool.name}: HTTP ${response.status}.`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > tool.size) throw new Error(`Unexpected size for ${tool.name}.`);
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (size !== tool.size || createHash('sha256').update(data).digest('hex') !== tool.sha256) {
      throw new Error(`Integrity check failed for ${tool.name}.`);
    }
    return data;
  }
  throw new Error(`Too many download redirects for ${tool.name}.`);
}

export async function prepareBundlerTools({ platform, cacheDir, token, fetcher = fetch }) {
  if (!['linux', 'win32'].includes(platform)) throw new Error('Unsupported CI bundler platform.');
  await mkdir(cacheDir, { recursive: true });
  const tools = platform === 'linux' ? [TOOLS.apprun, TOOLS.linuxdeploy] : [TOOLS.wix];
  for (const tool of tools) {
    const data = await downloadVerifiedTool(tool, token, fetcher);
    const staging = await mkdtemp(join(cacheDir, '.verified-tool-'));
    try {
      const archive = join(staging, tool.name);
      await writeFile(archive, data);
      if (platform === 'win32') {
        const extracted = join(staging, 'WixTools314');
        execFileSync(
          'pwsh',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:CHAT_WIX_ARCHIVE -DestinationPath $env:CHAT_WIX_DESTINATION",
          ],
          { env: { ...process.env, CHAT_WIX_ARCHIVE: archive, CHAT_WIX_DESTINATION: extracted } },
        );
        for (const file of [
          'candle.exe',
          'candle.exe.config',
          'darice.cub',
          'light.exe',
          'light.exe.config',
          'wconsole.dll',
          'winterop.dll',
          'wix.dll',
          'WixUIExtension.dll',
          'WixUtilExtension.dll',
        ]) {
          await readFile(join(extracted, file));
        }
        await rm(join(cacheDir, 'WixTools314'), { recursive: true, force: true });
        await rename(extracted, join(cacheDir, 'WixTools314'));
      } else {
        await chmod(archive, 0o755);
        await rename(archive, join(cacheDir, tool.name));
      }
      console.log(`Verified ${tool.name}: SHA-256 ${tool.sha256}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Bundler prefetch is limited to CI.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.devDependencies['@tauri-apps/cli'] !== '2.11.4' || process.arch !== 'x64') {
    throw new Error('Update the pinned bundler tools for this Tauri CLI version or architecture.');
  }
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA
      : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  if (!base) throw new Error('Cannot locate the disposable runner tool cache.');
  await prepareBundlerTools({
    platform: process.platform,
    cacheDir: join(base, 'tauri'),
    token: process.env.GH_TOKEN,
  });
}
