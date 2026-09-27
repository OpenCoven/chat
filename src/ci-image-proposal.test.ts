import { describe, expect, it } from 'vitest';

// @ts-expect-error Executable scripts intentionally have no declaration files.
import { proposeImageBump } from '../scripts/ci-image-proposal.mjs';

const digest = `sha256:${'b'.repeat(64)}`;
const old = `image: ghcr.io/opencoven/chat-ci@sha256:${'a'.repeat(64)}\n`;
const target = `image: ghcr.io/opencoven/chat-ci@${digest}\n`;
function fixture({
  branch = false,
  content = old,
  prs = [] as { state: string }[],
  failPut = false,
} = {}) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const state = { branch, content, prs };
  const api = async (method: string, path: string, body: Record<string, unknown>) => {
    if (method !== 'GET') writes.push({ method, path, body });
    if (path.includes('/pulls?')) return state.prs;
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'main-sha' } };
    if (path.includes('/git/ref/heads/ci/')) {
      if (!state.branch) throw Object.assign(new Error('Not found'), { status: 404 });
      return { object: { sha: 'branch-sha' } };
    }
    if (path.endsWith('/git/refs')) {
      state.branch = true;
      return {};
    }
    if (path.includes('/contents/')) {
      if (method === 'PUT') {
        expect(body.sha).toBe('file-sha');
        if (failPut) throw Object.assign(new Error('Conflict'), { status: 409 });
        state.content = Buffer.from(body.content as string, 'base64').toString();
        return {};
      }
      return {
        sha: 'file-sha',
        content: Buffer.from(path.endsWith('?ref=main') ? old : state.content).toString('base64'),
      };
    }
    if (path.endsWith('/pulls')) {
      state.prs.push({ state: 'open' });
      return { html_url: 'https://github.com/OpenCoven/chat/pull/1' };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const run = () =>
    proposeImageBump({
      api,
      repository: 'OpenCoven/chat',
      digest,
      reason: 'Updated packages',
      runUrl: 'https://github.com/OpenCoven/chat/actions/runs/1',
    });
  return { run, writes, state };
}

describe('CI image proposal recovery', () => {
  it('creates the branch, updates the pinned file, and creates one PR', async () => {
    const f = fixture();
    await f.run();
    expect(f.state.content).toBe(target);
    expect(f.writes.map((w) => w.method)).toEqual(['POST', 'PUT', 'POST']);
    await f.run();
    expect(f.writes).toHaveLength(3);
  });
  it('recovers a branch-only failure instead of declaring success', async () => {
    const f = fixture({ branch: true });
    await f.run();
    expect(f.state.content).toBe(target);
    expect(f.writes.map((w) => w.method)).toEqual(['PUT', 'POST']);
  });
  it('creates the missing PR after a successful file update', async () => {
    const f = fixture({ branch: true, content: target });
    await f.run();
    expect(f.writes.map((w) => w.method)).toEqual(['POST']);
  });
  it('does not reopen a declined or merged proposal', async () => {
    const f = fixture({ branch: true, prs: [{ state: 'closed' }] });
    await f.run();
    expect(f.writes).toEqual([]);
  });
  it('refuses to overwrite unrelated workflow edits on the proposal branch', async () => {
    const f = fixture({ branch: true, content: `${old}# concurrent edit\n` });
    await expect(f.run()).rejects.toThrow(/changed/);
    expect(f.writes).toEqual([]);
  });
  it('does not create a PR if the file changed concurrently at the API', async () => {
    const f = fixture({ branch: true, failPut: true });
    await expect(f.run()).rejects.toThrow('Conflict');
    expect(f.writes.map((w) => w.method)).toEqual(['PUT']);
    expect(f.state.content).toBe(old);
    expect(f.state.prs).toEqual([]);
  });
});
