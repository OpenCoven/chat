// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  downloadVerifiedTool,
  prepareBundlerTools,
  TOOLS,
} from '../scripts/prepare-bundler-tools.mjs';

const payload = 'verified bundler bytes';
const tool = {
  ...TOOLS.apprun,
  size: Buffer.byteLength(payload),
  sha256: createHash('sha256').update(payload).digest('hex'),
};
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('verified CI bundler tools', () => {
  it('authenticates only the API request and checks the redirected bytes', async () => {
    const fetcher = vi.fn(async (_url: URL, _options: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/asset' },
        });
      }
      return new Response(payload);
    });
    expect(await downloadVerifiedTool(tool, 'test-token', fetcher)).toEqual(Buffer.from(payload));
    const calls = fetcher.mock.calls;
    expect(calls[0]?.[0].hostname).toBe('api.github.com');
    expect(calls[0]?.[1].headers).toEqual({
      Accept: 'application/octet-stream',
      Authorization: 'Bearer test-token',
    });
    expect(calls[1]?.[0].hostname).toBe('release-assets.githubusercontent.com');
    expect(calls[1]?.[1].headers).toEqual({ Accept: 'application/octet-stream' });
    expect(calls.every((call) => call[1].redirect === 'manual')).toBe(true);
  });

  it.each([
    'https://unexpected.example/asset',
    'http://release-assets.githubusercontent.com/asset',
  ])('rejects an unexpected or insecure redirect before contacting %s', async (location) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(downloadVerifiedTool(tool, 'test-token', fetcher)).rejects.toThrow(
      'Unexpected download host',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong bytes even when their size matches', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(tool.size)));
    await expect(downloadVerifiedTool(tool, 'test-token', fetcher)).rejects.toThrow(
      'Integrity check failed',
    );
  });

  it('stops an oversized response', async () => {
    const fetcher = vi.fn(async () => new Response(payload.repeat(2)));
    await expect(downloadVerifiedTool(tool, 'test-token', fetcher)).rejects.toThrow(
      'Unexpected size',
    );
  });

  it('fails an unavailable download without a retry or a cache entry', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'chat-bundler-tools-'));
    folders.push(folder);
    const fetcher = vi.fn(async () => new Response(null, { status: 502 }));
    await expect(
      prepareBundlerTools({ platform: 'linux', cacheDir: folder, token: 'test-token', fetcher }),
    ).rejects.toThrow('HTTP 502');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(folder)).toEqual([]);
  });

  it('requires a token before issuing a request', async () => {
    const fetcher = vi.fn();
    await expect(downloadVerifiedTool(tool, '', fetcher)).rejects.toThrow('read-only GitHub token');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
