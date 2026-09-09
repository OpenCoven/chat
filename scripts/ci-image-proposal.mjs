import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const imagePattern = /ghcr\.io\/opencoven\/chat-ci@sha256:[0-9a-f]{64}/g;

export async function proposeImageBump({ api, repository, digest, reason, runUrl }) {
  if (repository !== 'OpenCoven/chat' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Invalid CI image proposal inputs.');
  }
  if (!/^https:\/\/github\.com\/OpenCoven\/chat\/actions\/runs\/[0-9]+$/.test(runUrl)) {
    throw new Error('Invalid image verification run URL.');
  }
  const short = digest.slice(7, 19);
  const branch = `ci/image-digest-${short}`;
  const prefix = `repos/${repository}`;
  const prs = await api(
    'GET',
    `${prefix}/pulls?state=all&head=OpenCoven:${branch}&base=main&per_page=100`,
  );
  if (prs.length > 1)
    throw new Error('Multiple proposals exist for this image; reconcile manually.');
  // A closed proposal records a maintainer decision; never recreate it on a retry.
  if (prs[0]?.state === 'closed') return { status: 'closed', url: prs[0].html_url };

  const main = await api('GET', `${prefix}/git/ref/heads/main`);
  const mainFile = await api('GET', `${prefix}/contents/.github/workflows/ci.yml?ref=main`);
  const current = Buffer.from(mainFile.content, 'base64').toString('utf8');
  if (!current.match(imagePattern)) throw new Error('No pinned CI image found on main.');
  const updated = current.replace(imagePattern, `ghcr.io/opencoven/chat-ci@${digest}`);
  if (current === updated) return { status: 'already-adopted' };

  try {
    await api('GET', `${prefix}/git/ref/heads/${branch}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await api('POST', `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
  }
  const filePath = `${prefix}/contents/.github/workflows/ci.yml`;
  const file = await api('GET', `${filePath}?ref=${encodeURIComponent(branch)}`);
  const content = Buffer.from(file.content, 'base64').toString('utf8');
  if (content !== current && content !== updated) {
    throw new Error('Proposal workflow changed relative to main; reconcile before retrying.');
  }
  if (content !== updated) {
    // The Contents API checks the blob SHA and preserves other files on the branch.
    await api('PUT', filePath, {
      message: `ci: adopt rebuilt CI image ${short}`,
      content: Buffer.from(updated).toString('base64'),
      sha: file.sha,
      branch,
    });
  }
  if (prs[0]) return { status: 'existing', url: prs[0].html_url };
  const pr = await api('POST', `${prefix}/pulls`, {
    base: 'main',
    head: branch,
    title: `ci: adopt rebuilt CI image ${short}`,
    body: `Adopt verified CI image \`${digest}\`.\n\n${reason}\n\nThe image passed E2E, desktop build, and the bundled-browser check in ${runUrl}. The change is proposed because the base image or installed package versions changed. Review and CI on this PR are still required before adoption.`,
  });
  return { status: 'created', url: pr.html_url };
}

export function githubApi(method, path, body) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      }),
    );
  } catch (error) {
    const status = Number(/HTTP (\d{3})/.exec(String(error.stderr))?.[1]);
    throw Object.assign(
      new Error(`GitHub API ${method} ${path} failed${status ? ` (HTTP ${status})` : ''}.`),
      { status },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GH_TOKEN) {
    throw new Error(
      'Configure CI_IMAGE_BUMP_TOKEN with Contents, Workflows, and Pull requests write permissions for OpenCoven/chat.',
    );
  }
  const result = await proposeImageBump({
    api: githubApi,
    repository: process.env.GITHUB_REPOSITORY,
    digest: process.env.DIGEST,
    reason: process.env.REASON ?? '',
    runUrl: process.env.RUN_URL,
  });
  console.log(JSON.stringify(result));
}
