#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWorktreeList } from './agent-worktrees.mjs';
import { governedPaths, pathsNeedingCiFull } from './ci-full-check.mjs';

const result = (status, detail) => ({ status, detail });

/** Receipts are user-selected attestations, never a substitute for running the canary. */
export function assessRuntime({
  chatSha,
  installerPin,
  engineSetupPin,
  required = [],
  releases,
  receipts = [],
}) {
  const published =
    releases === null
      ? result('unknown', 'Published releases unavailable')
      : releases.some((r) => r.tag_name === `v${installerPin}` && !r.draft && !r.prerelease)
        ? result(
            'available',
            `Installer pin v${installerPin} is published; availability does not prove compatibility`,
          )
        : result(
            'blocked',
            `Installer pin v${installerPin} was not found among published releases`,
          );
  const assess = (receipt, scope) => {
    if (
      !receipt ||
      receipt.scope !== scope ||
      receipt.chatSha !== chatSha ||
      !/^[a-f0-9]{40}$/.test(chatSha) ||
      !receipt.engineVersion ||
      !receipt.covenVersion ||
      typeof receipt.evidence !== 'string' ||
      !receipt.evidence.trim() ||
      !Array.isArray(receipt.capabilities) ||
      (scope === 'candidate' &&
        (!/^[a-f0-9]{40}$/.test(receipt.covenSha ?? '') ||
          !/^[a-f0-9]{40}$/.test(receipt.engineSha ?? ''))) ||
      (scope === 'installer' && receipt.covenVersion !== installerPin)
    ) {
      return result(
        'unknown',
        `No matching ${scope} receipt for this Chat SHA and runtime; see #659 for installer qualification`,
      );
    }
    if (receipt.outcome !== 'passed') return result('blocked', `${scope} receipt did not pass`);
    if (scope === 'published' && releases === null)
      return result('unknown', 'Published release evidence unavailable');
    if (
      scope === 'published' &&
      !releases.some((r) => r.tag_name === `v${receipt.covenVersion}` && !r.draft && !r.prerelease)
    )
      return result('blocked', 'Selected runtime version is not a published stable Coven release');
    const missing = required.filter((capability) => !receipt.capabilities.includes(capability));
    if (missing.length)
      return result(
        'blocked',
        `${scope} receipt lacks required capabilities: ${missing.join(', ')}`,
      );
    return {
      ...result(
        'attested',
        'Selected receipt reports success; doctor has not executed or authenticated it',
      ),
      evidence: receipt.evidence,
      covenVersion: receipt.covenVersion,
      engineVersion: receipt.engineVersion,
      capabilities: receipt.capabilities,
      covenSha: receipt.covenSha ?? null,
      engineSha: receipt.engineSha ?? null,
    };
  };
  const installerReceipt = receipts.findLast(
    (r) =>
      r.scope === 'installer' &&
      r.chatSha === chatSha &&
      r.covenVersion === installerPin &&
      engineSetupPin &&
      r.engineVersion === engineSetupPin,
  );
  const installer = assess(installerReceipt, 'installer');
  if (published.status !== 'available' && installer.status === 'attested') {
    installer.status = published.status;
    installer.detail = `${published.detail}; a receipt cannot establish release availability`;
  }
  return {
    installerPin,
    required,
    installer,
    published,
    publishedReceipts: receipts
      .filter((r) => r.scope === 'published')
      .map((r) => assess(r, 'published')),
    candidates: receipts.filter((r) => r.scope === 'candidate').map((r) => assess(r, 'candidate')),
  };
}

export function assessChecks(required, runs, statuses, labels, rules) {
  if (!required || !runs || !statuses || !rules)
    return {
      ...result('unknown', 'Protection, branch rules or check evidence unavailable'),
      checks: [],
    };
  const latest = new Map();
  for (const run of [...runs].sort(
    (a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '') || (a.id ?? 0) - (b.id ?? 0),
  ))
    latest.set(run.name, run);
  const statusMap = new Map();
  for (const status of [...statuses].sort((a, b) =>
    (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  ))
    statusMap.set(status.context, status);
  const checks = [...new Set([...required, ...latest.keys(), ...statusMap.keys()])].map((name) => {
    const run = latest.get(name);
    const status = statusMap.get(name);
    const conclusion = run
      ? (run.conclusion ?? run.status ?? 'pending')
      : (status?.state ?? 'missing');
    return {
      name,
      required: required.includes(name),
      conclusion,
      status:
        conclusion === 'skipped' || conclusion === 'neutral'
          ? 'untested'
          : conclusion === 'success'
            ? 'passed'
            : conclusion === 'missing' || (!run?.conclusion && run)
              ? 'unknown'
              : 'blocked',
      commitStatus: status?.state ?? null,
    };
  });
  for (const check of checks) {
    if (check.commitStatus && check.commitStatus !== 'success' && check.status === 'passed')
      check.status = 'blocked';
  }
  const incomplete = checks.some((c) => c.required && c.status !== 'passed');
  return {
    ...result(
      incomplete ? 'blocked' : 'observed',
      'Check success is not native, release or human acceptance',
    ),
    checks,
    ciFull: labels.includes('ci:full'),
    skipped: checks.filter((c) => c.status === 'untested').map((c) => c.name),
    mergeQueue: rules.some((r) => r.type === 'merge_queue'),
    rules,
  };
}

export function assessDeployment(paths, workflow) {
  // Fail closed when the workflow no longer matches the policy being interpreted.
  if (
    !workflow ||
    !workflow.includes('branches: [main]') ||
    !workflow.includes('mode=upload') ||
    !workflow.includes('github.event_name') ||
    !workflow.includes('-- apps/ios')
  )
    return result(
      'unknown',
      'Inspect the iOS workflow; automatic upload policy could not be recognized',
    );
  if (paths.includes('.github/workflows/ios.yml'))
    return result(
      'unknown',
      'iOS workflow changed: inspect both base and candidate deployment policy before merge',
    );
  if (paths.some((p) => p.startsWith('apps/ios/')))
    return result(
      'blocked',
      'An iOS app change merged to main triggers a TestFlight upload; explicit hold/authorization must be resolved before merge',
    );
  return result(
    'observed',
    paths.some((p) => p.startsWith('src-tauri/'))
      ? 'Companion CI runs, but no iOS app change: current workflow selects no TestFlight upload (normal merge with known before SHA)'
      : 'No iOS trigger paths changed; no automatic TestFlight upload from this diff',
  );
}

export function assessIssue(issue, comments, prs, now = Date.now()) {
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const body = issue.body ?? '';
  const state =
    body.match(/<!-- agent-state:start -->([\s\S]*?)<!-- agent-state:end -->/)?.[1]?.trim() ??
    body.match(/> \*\*State[^\n]*/)?.[0] ??
    '';
  const warnings = [];
  const linked = prs.filter((pr) =>
    new RegExp(`#${issue.number}\\b|/issues/${issue.number}\\b`).test(pr.body ?? ''),
  );
  if (comments === null)
    return {
      number: issue.number,
      status: 'unknown',
      warnings: ['Comments unavailable; ownership unknown'],
      linkedPRs: linked.map((pr) => pr.number),
      nextAction: 'Read current issue comments before claiming',
      source: issue.html_url,
      claim: null,
    };
  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const claims = new Map();
  for (const comment of ordered) {
    const marker = /^\*\*(Claimed|Released)\*\* by ([^ (]+?)(?:\s|[.,]?$)/i.exec(
      comment.body ?? '',
    );
    if (!marker) continue;
    const actor = marker[2].replace(/[.,]$/, '').toLowerCase();
    if (marker[1].toLowerCase() === 'claimed') claims.set(actor, comment);
    else claims.delete(actor);
  }
  if (claims.size > 1) warnings.push('Overlapping claims; confirm the current owner on the issue');
  const claim = claims.size === 1 ? [...claims.values()][0] : null;
  if (!state) warnings.push('Missing dated State block');
  if (!labels.some((l) => l.startsWith('area:'))) warnings.push('Missing area label');
  if (
    !labels.some((l) =>
      ['agent-ready', 'in-progress', 'needs-human', 'needs-decision', 'blocked:engine'].includes(l),
    )
  )
    warnings.push('Missing next-actor label');
  const stateDate = state.match(/State \((\d{4}-\d{2}-\d{2})\)/)?.[1];
  const newer = ordered.filter((c) => !stateDate || c.created_at.slice(0, 10) > stateDate);
  if (
    /complete|closed|landed/i.test(state) &&
    newer.some((c) => /revert|reopen|not complete|blocked/i.test(c.body))
  )
    warnings.push('State may contradict a newer revert/reopen/blocker comment');
  if (
    claim &&
    now - Date.parse(issue.updated_at) > 3 * 86400000 &&
    !linked.some((pr) => now - Date.parse(pr.updated_at) < 3 * 86400000)
  )
    warnings.push(
      'Possible stale claim; verify branch activity and release comments before takeover',
    );
  const latest = ordered.at(-1);
  const recent = latest && (!stateDate || latest.created_at.slice(0, 10) >= stateDate);
  const source = recent ? (latest.html_url ?? issue.html_url) : issue.html_url;
  const recordedOwner = state.replaceAll('**', '').match(/Who:\s*(.*?)(?:\. |$)/i)?.[1];
  const owner = claims.size
    ? [...claims.keys()].join(', ')
    : recent
      ? 'confirm against latest comment'
      : (recordedOwner ?? 'see State block');
  const nextAction = warnings.some((w) => /contradict/.test(w))
    ? 'Read latest comment and reconcile the State block; do not follow stale completion'
    : recent
      ? 'Read the latest comment before acting: ' +
        (latest.body ?? '').split('\n').find(Boolean)?.slice(0, 240)
      : (state
          .replaceAll('**', '')
          .match(/Next(?: action| step)?:\s*([\s\S]*?)(?:\s+Who:|$)/i)?.[1]
          ?.trim() ??
        (state ||
          'Read acceptance criteria and latest owner comment to establish the next action'));
  return {
    number: issue.number,
    status: warnings.length ? 'attention' : 'observed',
    labels,
    state,
    warnings,
    source,
    owner,
    recordedOwner,
    claim: claim?.body.split('\n')[0] ?? null,
    availability: claims.size
      ? 'claimed'
      : !labels.includes('agent-ready') ||
          labels.some((label) =>
            ['needs-human', 'needs-decision', 'blocked:engine', 'in-progress'].includes(label),
          ) ||
          linked.length
        ? 'read gates'
        : 'check latest comments to claim',
    latestCommentAt: ordered.at(-1)?.created_at ?? null,
    linkedPRs: linked.map((pr) => pr.number),
    nextAction,
  };
}

/** Child errors are deliberately not returned: stderr can contain credentials or remote URLs. */
function command(program, args, cwd) {
  try {
    return {
      ok: true,
      value: execFileSync(program, args, {
        cwd,
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GH_PROMPT_DISABLED: '1',
          GIT_TERMINAL_PROMPT: '0',
          COREPACK_ENABLE_NETWORK: '0',
          RUSTUP_AUTO_INSTALL: '0',
        },
      }).trim(),
    };
  } catch {
    return { ok: false, value: null };
  }
}

export function collectDoctor({
  root = process.cwd(),
  offline = false,
  prNumber,
  required = [],
  receipts = [],
  run = command,
} = {}) {
  const unknowns = [];
  const git = (...args) => run('git', args, root);
  const read = (path) => {
    try {
      return readFileSync(resolve(root, path), 'utf8');
    } catch {
      unknowns.push(`Cannot read ${path}`);
      return '';
    }
  };
  const api = (endpoint, paged = false) => {
    if (offline) {
      unknowns.push(`Offline: ${endpoint}`);
      return null;
    }
    const response = run(
      'gh',
      ['api', '--method', 'GET', ...(paged ? ['--paginate', '--slurp'] : []), endpoint],
      root,
    );
    if (!response.ok) {
      unknowns.push(`REST unavailable or denied: ${endpoint}`);
      return null;
    }
    try {
      const parsed = JSON.parse(response.value);
      return paged ? parsed.flat() : parsed;
    } catch {
      unknowns.push(`Invalid REST response: ${endpoint}`);
      return null;
    }
  };
  const head = git('rev-parse', 'HEAD').value;
  const branch = git('branch', '--show-current').value;
  const top = git('rev-parse', '--show-toplevel').value;
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').value;
  const status = git('status', '--porcelain=v1', '-z');
  const worktrees = git('worktree', 'list', '--porcelain');
  const base = git('merge-base', 'HEAD', 'origin/main');
  const changed = base.ok ? git('diff', '--name-only', '-z', base.value, 'HEAD') : { ok: false };
  const localChanged = git('diff', '--name-only', '-z', 'HEAD');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
  const pathsKnown = changed.ok && localChanged.ok && untracked.ok;
  if (!head || !top || !common || !branch)
    unknowns.push('Checkout identity unavailable or detached');
  if (!status.ok) unknowns.push('Git status unavailable; local changes unknown');
  if (!worktrees.ok) unknowns.push('Worktree inventory unavailable');
  if (!pathsKnown) unknowns.push('Changed paths or local base unavailable');
  const paths = [
    ...new Set(
      [changed.value, localChanged.value, untracked.value]
        .filter(Boolean)
        .flatMap((s) => s.split('\0').filter(Boolean)),
    ),
  ];
  const packageJson = JSON.parse(read('package.json') || '{}');
  const rustChannel = read('rust-toolchain.toml').match(/channel\s*=\s*"([^"]+)"/)?.[1];
  const pins = {
    node: read('.node-version').trim(),
    pnpm: packageJson.packageManager?.split('@').at(-1),
    rust: rustChannel,
  };
  const toolchains = Object.entries({
    node: run('node', ['--version'], root),
    pnpm: run('pnpm', ['--version'], root),
    rust: run('rustc', ['--version'], root),
    cargo: run('cargo', ['--version'], root),
    rustfmt: run('rustfmt', ['--version'], root),
    clippy: run('cargo', ['clippy', '--version'], root),
    gh: run('gh', ['--version'], root),
    pwsh: run(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      root,
    ),
  }).map(([name, value]) => ({
    name,
    expected: pins[name] ?? 'available',
    actual: value.value?.split('\n')[0] ?? null,
    status: !value.ok
      ? 'unknown'
      : pins[name] && !value.value.split(/\s+/).some((v) => v.replace(/^v/, '') === pins[name])
        ? 'blocked'
        : 'observed',
  }));
  for (const tool of toolchains)
    if (tool.status === 'unknown') unknowns.push(`Tool unavailable: ${tool.name}`);
  const signingKey = git('config', '--get', 'user.signingkey');
  const signingFormat = git('config', '--get', 'gpg.format');
  const signingRequired = git('config', '--bool', '--get', 'commit.gpgsign');
  const signing = result(
    'unknown',
    signingKey.ok
      ? `Signing key configured; format ${signingFormat.value ?? 'openpgp'}, automatic signing ${signingRequired.value ?? 'unset'}. Agent/key availability not exercised; verify a signed commit before push.`
      : 'No configured signing key. Per-command signing may be possible; create and verify a signed commit before push.',
  );
  const issues = api('repos/OpenCoven/chat/issues?state=open&per_page=100', true);
  const prs = api('repos/OpenCoven/chat/pulls?state=open&per_page=100', true);
  const tracking = (issues ?? [])
    .filter((issue) => !issue.pull_request)
    .map((issue) =>
      assessIssue(
        issue,
        api(`repos/OpenCoven/chat/issues/${issue.number}/comments?per_page=100`, true),
        prs ?? [],
      ),
    );
  const currentPr = prNumber
    ? api(`repos/OpenCoven/chat/pulls/${prNumber}`)
    : (prs ?? []).find((pr) => pr.head?.ref === branch);
  const protection = api('repos/OpenCoven/chat/branches/main/protection');
  const rules = api('repos/OpenCoven/chat/rules/branches/main');
  const requiredContexts = protection
    ? [
        ...new Set([
          ...(protection.required_status_checks?.contexts ?? []),
          ...(protection.required_status_checks?.checks ?? []).map((c) => c.context),
          ...(rules ?? [])
            .filter((r) => r.type === 'required_status_checks')
            .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context)),
        ]),
      ]
    : null;
  if (prNumber && !currentPr)
    unknowns.push('Selected PR unavailable; local-head checks are not PR qualification');
  const checkSha = currentPr?.head?.sha ?? (prNumber ? null : head);
  // --slurp retains each response page; check-run pages wrap their collection.
  const checkPages =
    checkSha && api(`repos/OpenCoven/chat/commits/${checkSha}/check-runs?per_page=100`, true);
  const checks = checkPages?.flatMap((page) => page.check_runs ?? []);
  const statuses =
    checkSha && api(`repos/OpenCoven/chat/commits/${checkSha}/statuses?per_page=100`, true);
  const releases = api('repos/OpenCoven/coven/releases?per_page=100', true);
  const engineReleases = api('repos/OpenCoven/coven-code/releases?per_page=100', true);
  const installerPin =
    read('src-tauri/src/coven_install.rs').match(/const COVEN_VERSION: &str = "([^"]+)"/)?.[1] ??
    null;
  const engineSetupPin =
    read('src-tauri/src/setup.rs').match(/const ENGINE_VERSION: &str = "([^"]+)"/)?.[1] ?? null;
  const runtime = assessRuntime({
    chatSha: head,
    installerPin,
    engineSetupPin,
    required,
    releases,
    receipts,
  });
  const releaseList = (rows) =>
    rows === null
      ? null
      : rows
          .filter((r) => !r.draft)
          .map((r) => ({ tag: r.tag_name, publishedAt: r.published_at, prerelease: r.prerelease }));
  runtime.engineSetupPin = engineSetupPin;
  runtime.covenReleases = releaseList(releases);
  runtime.engineReleases = releaseList(engineReleases);
  const prFiles = currentPr
    ? api(`repos/OpenCoven/chat/pulls/${currentPr.number}/files?per_page=100`, true)
    : null;
  const deploymentPaths = currentPr
    ? prFiles?.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean))
    : !prNumber && pathsKnown
      ? paths
      : null;
  const localWorkflow = read('.github/workflows/ios.yml');
  let deploymentWorkflow = localWorkflow;
  if (currentPr && (currentPr.head.sha !== head || paths.includes('.github/workflows/ios.yml'))) {
    const remoteWorkflow = api(
      `repos/OpenCoven/chat/contents/.github/workflows/ios.yml?ref=${currentPr.head.sha}`,
    );
    deploymentWorkflow =
      remoteWorkflow?.encoding === 'base64'
        ? Buffer.from(remoteWorkflow.content, 'base64').toString('utf8')
        : '';
  }
  const ci = assessChecks(
    requiredContexts,
    checks,
    statuses,
    currentPr?.labels?.map((l) => l.name) ?? [],
    rules,
  );
  ci.head = checkSha;
  ci.matchesCheckout = checkSha === head;
  if (currentPr && checkSha !== head)
    ci.checkoutWarning =
      'Selected PR head differs from this checkout; do not credit its checks to local changes';
  ci.protection = protection
    ? {
        strict: protection.required_status_checks?.strict,
        enforceAdmins: protection.enforce_admins?.enabled,
        signedCommits: protection.required_signatures?.enabled,
        requiredReviews:
          protection.required_pull_request_reviews?.required_approving_review_count ?? null,
      }
    : null;
  let ciFullNeeded = null;
  try {
    if (deploymentPaths)
      ciFullNeeded =
        pathsNeedingCiFull(deploymentPaths, governedPaths(read('phase1-conformance.lock.json')))
          .length > 0;
  } catch {
    unknowns.push('Cannot evaluate ci:full; inspect the conformance lock and changed paths');
  }
  ci.additionalCoverage = {
    ciFullNeeded,
    instruction:
      'ci:full requests Rust, Windows, macOS producer and real-authority coverage. Inspect newest jobs, including skipped results; a label alone is not proof.',
  };
  return {
    schemaVersion: 1,
    sources: {
      checkout: 'git rev-parse, status, diff, ls-files, worktree list; local origin/main',
      toolchains: '.node-version, package.json, rust-toolchain.toml and local version commands',
      signing: 'git config user.signingkey, gpg.format and commit.gpgsign',
      ci: checkSha ? `https://github.com/OpenCoven/chat/commit/${checkSha}/checks` : null,
      protection: 'https://api.github.com/repos/OpenCoven/chat/branches/main/protection',
      runtime: [
        'src-tauri/src/coven_install.rs',
        'src-tauri/src/setup.rs',
        'https://github.com/OpenCoven/coven/releases',
        'https://github.com/OpenCoven/coven-code/releases',
      ],
      deployment: '.github/workflows/ios.yml and the changed paths for the selected revision',
    },
    observedAt: new Date().toISOString(),
    readOnly: true,
    checkout: {
      head,
      branch,
      root: top,
      isolation:
        !top || !common
          ? 'unknown'
          : realpathSync(common) === realpathSync(resolve(top, '.git'))
            ? 'primary'
            : 'isolated',
      dirty: status.ok ? Boolean(status.value) : null,
      changedPaths: pathsKnown ? paths : null,
      base: base.value ?? null,
      worktrees: worktrees.ok ? parseWorktreeList(worktrees.value) : null,
    },
    toolchains,
    signing,
    tracking:
      issues === null || prs === null
        ? { status: 'unknown', issues: tracking }
        : { status: 'observed', issues: tracking },
    pullRequests: (prs ?? []).map((pr) => ({
      number: pr.number,
      head: pr.head?.sha,
      draft: pr.draft,
      branch: pr.head?.ref,
      source: pr.html_url,
      linkedIssues: tracking
        .filter((issue) => issue.linkedPRs.includes(pr.number))
        .map((issue) => issue.number),
    })),
    ci,
    runtime,
    localDeployment: pathsKnown
      ? assessDeployment(paths, localWorkflow)
      : result('unknown', 'Inspect checkout changes'),
    deployment: deploymentPaths
      ? assessDeployment(deploymentPaths, deploymentWorkflow)
      : result('unknown', 'Changed paths unavailable; inspect deployment manually'),
    unknowns,
  };
}

export function formatDoctor(report) {
  const lines = [
    `Agent doctor: ${report.checkout.head ?? 'unknown SHA'} (${report.checkout.branch ?? 'unknown branch'})`,
    `Checkout: ${report.checkout.isolation}; local changes: ${report.checkout.dirty ?? 'unknown'}`,
  ];
  for (const tool of report.toolchains)
    lines.push(
      `Tool ${tool.name}: ${tool.status}; expected ${tool.expected}; actual ${tool.actual ?? 'unavailable'}`,
    );
  lines.push(`Signing: ${report.signing.status}; ${report.signing.detail}`);
  lines.push(
    `CI (${report.ci.head}): ${report.ci.status}; ci:full=${report.ci.ciFull ?? 'unknown'}; merge queue=${report.ci.mergeQueue ?? 'unknown'}`,
  );
  for (const check of report.ci.checks)
    lines.push(
      `  ${check.required ? 'required' : 'additional'} ${check.name}: ${check.status} (${check.conclusion})`,
    );
  lines.push(report.ci.additionalCoverage.instruction);
  lines.push(
    `Installer runtime: ${report.runtime.installer.status}; ${report.runtime.installer.detail}`,
  );
  lines.push(
    `Published runtime: ${report.runtime.published.status}; ${report.runtime.published.detail}`,
  );
  lines.push(
    `Candidates: ${report.runtime.candidates.length} selected receipt(s), never substituted for installer evidence`,
  );
  lines.push(`Deployment: ${report.deployment.status}; ${report.deployment.detail}`);
  lines.push(`Tracking: ${report.tracking.status}`);
  for (const issue of report.tracking.issues)
    lines.push(
      `  #${issue.number} ${issue.status}; ${issue.availability ?? 'unknown'}; owner ${issue.owner ?? 'unknown'}; next ${issue.nextAction} ${issue.source ?? ''}${issue.warnings.length ? `; ${issue.warnings.join('; ')}` : ''}`,
    );
  for (const pr of report.pullRequests)
    lines.push(
      `  PR #${pr.number} ${pr.draft ? 'draft' : 'open'} ${pr.head} ${pr.source}; consult its claim or reviewer before changes`,
    );
  for (const unknown of report.unknowns) lines.push(`Unknown: ${unknown}`);
  lines.push(
    'This report does not authorize a claim, merge, deployment, cleanup or release. Verify current owner decisions and actual acceptance evidence.',
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const options = { offline: args.includes('--offline'), required: [] };
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--offline') continue;
      if (arg === '--json') {
        json = true;
        continue;
      }
      if (arg === '--help') {
        console.log(
          'pnpm --silent agent:doctor [--json] [--offline] [--pr NUMBER] [--require-capability NAME] [--runtime-evidence FILE]\nRead-only; does not run providers, install dependencies, sign, fetch Git refs or mutate GitHub. Runtime evidence is an explicit JSON array of receipts; see docs/agents/preflight.md.',
        );
        process.exit(0);
      }
      if (!args[i + 1]) throw new Error('Missing option value');
      if (arg === '--pr') {
        options.prNumber = Number(args[++i]);
        if (!Number.isSafeInteger(options.prNumber) || options.prNumber < 1)
          throw new Error('Invalid PR number');
      } else if (arg === '--require-capability') options.required.push(args[++i]);
      else if (arg === '--runtime-evidence') {
        options.receipts = JSON.parse(readFileSync(args[++i], 'utf8'));
        if (
          !Array.isArray(options.receipts) ||
          options.receipts.some((r) => !r || typeof r !== 'object')
        )
          throw new Error('Invalid receipt array');
      } else throw new Error('Unknown option');
    }
    const report = collectDoctor(options);
    console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    // Collection success is not delivery readiness. Callers must inspect evidence statuses.
    process.exitCode = report.unknowns.length ? 2 : 0;
  } catch {
    console.error(
      'Agent doctor failed to collect a report. Check options, repository and receipt format; no child stderr or credentials are printed.',
    );
    process.exitCode = 2;
  }
}
