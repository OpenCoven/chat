import type { IconName } from './minimal-icons';
import { FAMILIAR_TEMPLATES, MOCK_FAMILIARS, type MockFamiliar } from './mock-familiars';

/**
 * Mock content for the Familiars Redesign v2 surface.
 *
 * The design (docs/superpowers/specs/2026-09-01-familiars-redesign-v2) carries
 * richer conversations than the other demos: held actions, failed runs, a
 * reasoning card, an evidence-map image, and per-familiar activity. The
 * familiars themselves are the ones in `mock-familiars.ts`; only what the
 * design adds on top is declared here.
 *
 * Activity numbers mirror the design verbatim. The eventual source is the
 * SDK-shaped `CaveExecutionWindow` in `minimal-familiar-sdk.ts`, whose figures
 * differ; the design's figures win while this is a preview.
 */

export type FamConversation = Readonly<{
  id: string;
  familiarId: string;
  title: string;
  time: string;
  preview: string;
  /** The familiar stopped at its must-ask boundary and is waiting on you. */
  held?: true;
  /** The last run stopped with an error. */
  failed?: true;
}>;

export type ReasoningStep = Readonly<{
  icon: IconName;
  title: string;
  text: string;
  tool?: string;
  dur?: string;
  status?: 'ok' | 'failed';
  badge?: string;
}>;

export type ReasoningCardData = Readonly<{
  summary: string;
  duration: string;
  toolCalls: number;
  footer: string;
  steps: readonly ReasoningStep[];
}>;

export type PlotTone = 'ok' | 'warn' | 'inf';

export type PlotPoint = Readonly<{
  label: string;
  /** Percent from the left of the plot area. */
  x: number;
  /** Percent from the bottom of the plot area. */
  y: number;
  tone: PlotTone;
  /** Dot diameter in pixels at card size. */
  size: number;
}>;

export type HoldState = 'approved' | 'declined' | 'expired';

export type FamMessage =
  | Readonly<{ kind: 'divider'; text: string }>
  | Readonly<{ kind: 'user'; time: string; text: string; attachments?: readonly string[] }>
  | Readonly<{
      kind: 'familiar';
      time: string;
      text: string;
      decision?: true;
      /** Which familiar spoke; the conversation's own when absent. */
      author?: string;
    }>
  | Readonly<{ kind: 'reasoning'; id: string; card: ReasoningCardData }>
  | Readonly<{
      kind: 'image';
      time: string;
      alt: string;
      file: string;
      plot?: readonly PlotPoint[];
    }>
  | Readonly<{
      kind: 'hold';
      id: string;
      time: string;
      title: string;
      detail: string;
      facts: readonly (readonly [string, string])[];
      openLabel: string;
      approvedText: string;
      declinedText: string;
    }>
  | Readonly<{ kind: 'failed'; text: string }>;

export type HoldMessage = Extract<FamMessage, { kind: 'hold' }>;

export type FamCommand = Readonly<{ name: string; hint: string; tier: 'may act' | 'must ask' }>;

export type FamDoc = Readonly<{ kind: string; lines: readonly string[] }>;

export type FamTrigger = Readonly<{ pattern: RegExp; action: string }>;

export type RunTone = 'ok' | 'warn' | 'bad';

export type FamRun = Readonly<{ title: string; meta: string; status: string; tone: RunTone }>;

export type FamActivity = Readonly<{
  completion: string;
  runs: string;
  median: string;
  calls: string;
  failures: string;
  updated: string;
  outcomes: readonly (readonly [string, number, RunTone])[];
  spread: readonly (readonly [string, string])[];
  tools: readonly Readonly<{ name: string; calls: number; failed?: number }>[];
  /** Seven days, Monday first: completed runs and failed runs. */
  days: readonly (readonly [number, number])[];
  recent: readonly FamRun[];
}>;

export const FAM_CONVERSATIONS: readonly FamConversation[] = [
  {
    id: 'pricing',
    familiarId: 'astra',
    title: 'Q3 pricing evidence map',
    time: '10:52 PM',
    preview: 'Publish a finding · waiting on you',
    held: true,
  },
  {
    id: 'ratelimit',
    familiarId: 'cody',
    title: 'Open PR: rate limiter',
    time: '9:14 AM',
    preview: 'Open a pull request · waiting on you',
    held: true,
  },
  {
    id: 'flaky',
    familiarId: 'cody',
    title: 'Flaky test in auth suite',
    time: '8:40 AM',
    preview: 'pnpm test exited 1 · stopped',
    failed: true,
  },
  {
    id: 'vendor',
    familiarId: 'astra',
    title: 'Vendor deck comparison',
    time: 'Yesterday',
    preview: 'Source ledger has 14 entries',
  },
  {
    id: 'inbox',
    familiarId: 'echo',
    title: 'Inbox triage · Monday',
    time: 'Mon',
    preview: 'Drafted 6 replies for review',
  },
  {
    id: 'sync',
    familiarId: 'echo',
    title: 'Reschedule the board sync',
    time: 'Mon',
    preview: 'Draft ready for review',
  },
  {
    id: 'cat',
    familiarId: 'astra',
    title: 'Purple cat sketch',
    time: 'Sun',
    preview: '/image cat purple',
  },
];

function step(
  icon: IconName,
  title: string,
  text: string,
  rest: Omit<ReasoningStep, 'icon' | 'title' | 'text'> = {},
): ReasoningStep {
  return { icon, title, text, status: 'ok', dur: '', ...rest };
}

function point(label: string, x: number, y: number, tone: PlotTone, size: number): PlotPoint {
  return { label, x, y, tone, size };
}

export const FAM_MESSAGES: Readonly<Record<string, readonly FamMessage[]>> = {
  pricing: [
    { kind: 'divider', text: 'Yesterday 10:39 PM' },
    {
      kind: 'user',
      time: '10:39 PM',
      text: 'Map the evidence for the Q3 pricing decision. Start from the two vendor decks in notes/pricing/.',
    },
    {
      kind: 'familiar',
      time: '10:39 PM',
      text: 'On it. I’ll read both decks, pull the public benchmarks they cite, and keep a source ledger as I go — nothing leaves notes/ without you.',
    },
    {
      kind: 'reasoning',
      id: 'r1',
      card: {
        summary: 'Read two decks, verified four cited benchmarks, built the evidence map.',
        duration: '1m 52s',
        toolCalls: 14,
        footer: 'Retried one fetch after a timeout; nothing was skipped.',
        steps: [
          step(
            'file-text',
            'Read the vendor decks',
            'Both decks in notes/pricing/ parsed; 11 pricing claims extracted with page references.',
            { tool: 'files.read', dur: '6s' },
          ),
          step(
            'magnifying-glass',
            'Trace cited benchmarks',
            'Three of four claims cite public benchmarks. One cites an internal deck I can’t reach — flagged, not inferred.',
            { tool: 'web.search', dur: '21s' },
          ),
          step('globe', 'Fetch benchmark source', 'Request timed out after 15s.', {
            tool: 'web.fetch',
            dur: '15s',
            status: 'failed',
            badge: 'timeout',
          }),
          step(
            'arrow-clockwise',
            'Retry fetch',
            'Second attempt succeeded; the benchmark matches the deck within 3%.',
            { tool: 'web.fetch', dur: '4s', badge: 'retry' },
          ),
          step(
            'list-checks',
            'Write the source ledger',
            '14 entries appended to notes/ledger.md — each claim, its source, and how confident I am.',
            { tool: 'files.write', dur: '3s' },
          ),
          step(
            'image',
            'Compose the evidence map',
            'Rendered claims by strength of evidence so the weak spots read at a glance.',
            { tool: 'image.render', dur: '1m 03s' },
          ),
        ],
      },
    },
    {
      kind: 'hold',
      id: 'h1',
      time: '10:52 PM',
      title: 'Publish a finding',
      detail:
        'Publish “Q3 pricing — evidence map” from notes/findings/pricing-q3.md to the shared findings board.',
      facts: [
        ['Source', 'notes/findings/pricing-q3.md'],
        ['Destination', 'findings board · coven/research'],
        ['Reversible', 'no — published findings are versioned, not deleted'],
      ],
      openLabel: 'Open draft',
      approvedText:
        'Published. The finding is live on the board and the ledger links back to it. Memory updated — 413 entries.',
      declinedText:
        'Understood. The draft stays in notes/findings/ until you say otherwise; I’ve noted the decision in the ledger.',
    },
    {
      kind: 'image',
      time: '10:41 PM',
      alt: 'Evidence map — 11 claims plotted by source strength',
      file: 'notes/findings/evidence-map.png · 1200×800',
      plot: [
        point('C1 list price', 88, 22, 'ok', 14),
        point('C2 volume tier', 78, 38, 'ok', 12),
        point('C3 renewal uplift', 64, 30, 'ok', 11),
        point('C4 support SLA', 72, 66, 'ok', 10),
        point('C5 seat minimum', 55, 52, 'ok', 10),
        point('C6 overage rate', 46, 44, 'ok', 9),
        point('C7 discount floor', 40, 72, 'warn', 11),
        point('C8 competitor A', 30, 26, 'inf', 9),
        point('C9 competitor B', 24, 60, 'inf', 9),
        point('C10 churn impact', 15, 80, 'inf', 8),
        point('C11 internal deck', 12, 40, 'warn', 10),
      ],
    },
    {
      kind: 'familiar',
      time: '10:52 PM',
      text: 'Draft finding is ready in notes/findings/pricing-q3.md. Publishing it to the findings board is outside what I can do on my own.',
    },
  ],
  ratelimit: [
    { kind: 'divider', text: 'Today 8:58 AM' },
    {
      kind: 'user',
      time: '8:58 AM',
      text: 'Wire the rate limiter into the pairing endpoint and get it ready for review.',
    },
    {
      kind: 'familiar',
      time: '9:02 AM',
      text: 'Implemented on scratch/rate-limiter and the suite passes locally (42/42). Opening the pull request is held for you.',
    },
    {
      kind: 'hold',
      id: 'h2',
      time: '9:14 AM',
      title: 'Open a pull request',
      detail:
        'Cody wants to open a pull request from scratch/rate-limiter into main. Opening PRs is in his must-ask tier.',
      facts: [
        ['Branch', 'scratch/rate-limiter → main'],
        ['Changes', '+412 −38 across 7 files'],
        ['Checks', '42 tests passing locally'],
      ],
      openLabel: 'Open diff',
      approvedText:
        'PR #214 is open. I’ll watch CI and report back — I won’t merge; that’s another ask.',
      declinedText: 'Understood. The branch stays local; tell me what to change.',
    },
  ],
  flaky: [
    { kind: 'divider', text: 'Today 8:31 AM' },
    { kind: 'user', time: '8:31 AM', text: 'Why is the auth suite flaky?' },
    {
      kind: 'reasoning',
      id: 'r2',
      card: {
        summary: 'Ran the suite three times; the token-expiry test fails under load.',
        duration: '2m 05s',
        toolCalls: 9,
        footer: 'Stopped rather than patch around a timing bug.',
        steps: [
          step(
            'file-text',
            'Read the failing test',
            'token-expiry.test.ts asserts expiry at exactly 300s.',
            { tool: 'files.read', dur: '2s' },
          ),
          step('terminal-window', 'Run the suite', '41/42 passed. token-expiry failed by 8ms.', {
            tool: 'pnpm test',
            dur: '38s',
            status: 'failed',
            badge: 'exit 1',
          }),
          step(
            'arrow-clockwise',
            'Run again, isolated',
            'Passes alone. Fails when the pairing tests run first.',
            { tool: 'pnpm test', dur: '44s', badge: 'retry' },
          ),
          step(
            'terminal-window',
            'Run with timing trace',
            'Clock skew from a shared fake timer in setup.ts.',
            { tool: 'pnpm test', dur: '41s', status: 'failed', badge: 'exit 1' },
          ),
        ],
      },
    },
    {
      kind: 'failed',
      text: 'pnpm test exited 1 on the final run. The fix touches src/test/setup.ts, which is outside scratch/ — Cody stopped instead of editing it.',
    },
    {
      kind: 'familiar',
      time: '8:40 AM',
      text: 'The shared fake timer in setup.ts leaks between suites. Fixing it means editing a file outside my reach; if you widen the ward or fix it yourself, I’ll rerun.',
    },
  ],
  vendor: [
    { kind: 'divider', text: 'Yesterday 3:10 PM' },
    { kind: 'user', time: '3:10 PM', text: 'Compare the two vendor decks on pricing tiers.' },
    {
      kind: 'familiar',
      time: '3:12 PM',
      text: 'Done — 14 ledger entries, three unresolved disagreements flagged in notes/pricing/compare.md.',
    },
  ],
  inbox: [
    { kind: 'divider', text: 'Monday 9:00 AM' },
    { kind: 'user', time: '9:00 AM', text: 'Triage the inbox.' },
    {
      kind: 'familiar',
      time: '9:01 AM',
      text: 'Six replies drafted and waiting in review. Nothing was sent.',
    },
  ],
  sync: [
    { kind: 'divider', text: 'Monday 4:20 PM' },
    { kind: 'user', time: '4:20 PM', text: 'Draft a note moving the board sync to Thursday.' },
    {
      kind: 'familiar',
      time: '4:21 PM',
      text: 'Draft is ready. Sending is held for you whenever you want it to go.',
    },
  ],
  cat: [
    { kind: 'divider', text: 'Sunday 10:39 PM' },
    { kind: 'user', time: '10:41 PM', text: '/image cat purple' },
    {
      kind: 'image',
      time: '10:41 PM',
      alt: 'A purple cat in a glowing garden',
      file: 'notes/images/cat-purple.png · 600×400',
    },
  ],
};

export const FAM_COMMANDS: readonly FamCommand[] = [
  { name: '/image', hint: 'Generate an image from a prompt', tier: 'may act' },
  { name: '/spec', hint: 'Draft a specification document', tier: 'may act' },
  { name: '/handoff', hint: 'Write a handoff for another session', tier: 'may act' },
  { name: '/publish', hint: 'Publish a finding to the board', tier: 'must ask' },
  { name: '/pr', hint: 'Open a pull request', tier: 'must ask' },
];

export const FAM_DOCS: Readonly<Record<string, FamDoc>> = {
  'TOOLS.md': {
    kind: 'Editable file',
    lines: [
      '# Tools',
      '',
      'Astra may call the tools listed here and no others.',
      '',
      '- files.read — any path in the project',
      '- web.search — public web, results logged to the ledger',
      '- web.fetch — public pages only; 15s timeout, one retry',
      '- files.write — notes/ only',
      '- image.render — local, deterministic',
      '',
      '_Changes to this file are logged to the ward audit._',
    ],
  },
  'HEARTBEAT.md': {
    kind: 'Editable file',
    lines: [
      '# Heartbeat',
      '',
      'Last run: Q3 pricing evidence map — 1m 52s, 14 tool calls, 1 retry.',
      'Memory: 412 entries · last written 2 hours ago.',
      'Held: publish a finding (waiting on Val).',
      '',
      'Next: none scheduled.',
    ],
  },
  'notes/': {
    kind: 'Editable directory',
    lines: [
      'notes/',
      '├── ledger.md            14 entries',
      '├── pricing/',
      '│   ├── vendor-a.md',
      '│   ├── vendor-b.md',
      '│   └── compare.md',
      '├── findings/',
      '│   ├── pricing-q3.md     draft · held',
      '│   └── evidence-map.png',
      '└── images/',
      '    └── cat-purple.png',
    ],
  },
  'scratch/': {
    kind: 'Editable directory',
    lines: [
      'scratch/',
      '├── rate-limiter/        branch, 42 tests passing',
      '└── auth-suite-trace.log',
    ],
  },
  'ward.toml': {
    kind: 'Ward contract',
    lines: [
      '[meta]',
      'version = "0.3.1"',
      'familiar = "Astra"',
      'person = "Val Alexander"',
      '',
      '[protected]',
      'files = ["SOUL.md", "IDENTITY.md", "MEMORY.md", "ward.toml"]',
      'invariants = ["familiar.name", "familiar.person", "soul.boundaries"]',
      '',
      '[editable]',
      'paths = ["TOOLS.md", "HEARTBEAT.md", "notes/"]',
      '',
      '[approval_tiers]',
      'auto = ["read files", "search the web", "write to notes/"]',
      'human_review = ["publish a finding", "open a pull request"]',
    ],
  },
  'SOUL.md': {
    kind: 'Protected file',
    lines: [
      '# Astra',
      '',
      '**Purpose.** To map unfamiliar territory so a decision can be made on evidence.',
      '',
      '## Core work',
      '- Gather sources and record where each claim came from',
      '- Separate what is established from what is inferred',
      '- Write findings that survive being read by a sceptic',
      '',
      '## What I am not',
      '- Not a summariser that flattens disagreement',
      '- Not a source of claims it has not checked',
      '',
      '## My boundaries',
      '- Never presents an inference as a citation',
      '- Never edits code outside a research worktree',
    ],
  },
  'MEMORY.md': {
    kind: 'Protected file',
    lines: [
      '# Memory',
      '',
      '412 entries · last written 2 hours ago',
      '',
      '- 2026-09-01 22:52  Held: publish a finding (pricing-q3)',
      '- 2026-09-01 22:41  Ledger +14 · evidence map rendered',
      '- 2026-09-01 22:39  Read vendor decks (11 claims)',
      '- 2026-08-31 15:12  Vendor deck comparison complete',
      '…',
    ],
  },
};

/** Draft text that would cross into a familiar's must-ask tier. */
export const FAM_TRIGGERS: Readonly<Record<string, readonly FamTrigger[]>> = {
  astra: [
    { pattern: /publish/i, action: 'publish a finding' },
    { pattern: /pull request|\/pr\b/i, action: 'open a pull request' },
  ],
  cody: [
    { pattern: /push/i, action: 'push a branch' },
    { pattern: /merge/i, action: 'merge a pull request' },
    { pattern: /\bci\b/i, action: 'change CI' },
  ],
  echo: [
    { pattern: /\bsend\b/i, action: 'send' },
    { pattern: /archive/i, action: 'archive' },
  ],
};

export const FAM_ACTIVITY: Readonly<Record<string, FamActivity>> = {
  astra: {
    completion: '100%',
    runs: '12 of 12 runs',
    median: '1m 36s',
    calls: '148',
    failures: '2 reported failures',
    updated: '2h ago',
    outcomes: [
      ['completed', 12, 'ok'],
      ['held for you', 1, 'warn'],
      ['failed', 0, 'bad'],
    ],
    spread: [
      ['fastest', '41s'],
      ['p50', '1m 36s'],
      ['p90', '2m 48s'],
      ['slowest', '3m 04s'],
    ],
    tools: [
      { name: 'files.read', calls: 58 },
      { name: 'web.search', calls: 36 },
      { name: 'web.fetch', calls: 22, failed: 2 },
      { name: 'files.write', calls: 19 },
      { name: 'image.render', calls: 13 },
    ],
    days: [
      [2, 0],
      [1, 0],
      [3, 1],
      [0, 0],
      [2, 0],
      [3, 1],
      [1, 0],
    ],
    recent: [
      {
        title: 'Q3 pricing evidence map',
        meta: '1m 52s · 14 tool calls · 1 retry',
        status: 'held',
        tone: 'warn',
      },
      { title: 'Vendor deck comparison', meta: '58s · 9 tool calls', status: 'done', tone: 'ok' },
      {
        title: 'Benchmark fetch',
        meta: '2m 10s · 11 tool calls · 1 retry',
        status: 'done',
        tone: 'ok',
      },
      {
        title: 'Source ledger rebuild',
        meta: '3m 04s · 22 tool calls',
        status: 'done',
        tone: 'ok',
      },
    ],
  },
  cody: {
    completion: '82%',
    runs: '9 of 11 runs',
    median: '4m 12s',
    calls: '312',
    failures: '5 reported failures',
    updated: '11m ago',
    outcomes: [
      ['completed', 9, 'ok'],
      ['held for you', 1, 'warn'],
      ['failed', 2, 'bad'],
    ],
    spread: [
      ['fastest', '1m 02s'],
      ['p50', '4m 12s'],
      ['p90', '7m 40s'],
      ['slowest', '8m 12s'],
    ],
    tools: [
      { name: 'files.read', calls: 140 },
      { name: 'pnpm test', calls: 48, failed: 4 },
      { name: 'files.write', calls: 41 },
      { name: 'git', calls: 38 },
      { name: 'web.search', calls: 30, failed: 1 },
      { name: 'scratch.exec', calls: 15 },
    ],
    days: [
      [1, 0],
      [2, 1],
      [2, 0],
      [1, 0],
      [3, 0],
      [1, 1],
      [1, 0],
    ],
    recent: [
      {
        title: 'Open PR: rate limiter',
        meta: '6m 40s · 48 tool calls',
        status: 'held',
        tone: 'warn',
      },
      {
        title: 'Flaky test in auth suite',
        meta: '2m 05s · pnpm test exited 1',
        status: 'failed',
        tone: 'bad',
      },
      { title: 'Refactor token store', meta: '8m 12s · 61 tool calls', status: 'done', tone: 'ok' },
      { title: 'Add retry to fetcher', meta: '3m 30s · 27 tool calls', status: 'done', tone: 'ok' },
    ],
  },
  echo: {
    completion: '100%',
    runs: '6 of 6 runs',
    median: '22s',
    calls: '41',
    failures: '0 reported failures',
    updated: 'Mon',
    outcomes: [
      ['completed', 6, 'ok'],
      ['held for you', 0, 'warn'],
      ['failed', 0, 'bad'],
    ],
    spread: [
      ['fastest', '9s'],
      ['p50', '22s'],
      ['p90', '38s'],
      ['slowest', '41s'],
    ],
    tools: [
      { name: 'mail.read', calls: 24 },
      { name: 'mail.draft', calls: 12 },
      { name: 'files.write', calls: 5 },
    ],
    days: [
      [0, 0],
      [2, 0],
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 0],
      [0, 0],
    ],
    recent: [
      { title: 'Inbox triage · Monday', meta: '41s · 12 tool calls', status: 'done', tone: 'ok' },
      {
        title: 'Reschedule the board sync',
        meta: '18s · 3 tool calls',
        status: 'done',
        tone: 'ok',
      },
      { title: 'Weekly digest draft', meta: '26s · 6 tool calls', status: 'done', tone: 'ok' },
    ],
  },
};

export const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

export function familiarById(id: string): MockFamiliar | undefined {
  return MOCK_FAMILIARS.find((familiar) => familiar.id === id);
}

export function conversationById(id: string): FamConversation | undefined {
  return FAM_CONVERSATIONS.find((conversation) => conversation.id === id);
}

/** Held conversations that still have no decision. */
export function pendingHolds(
  conversations: readonly FamConversation[],
  holds: Readonly<Record<string, HoldState | undefined>>,
): FamConversation[] {
  return conversations.filter((conversation) => conversation.held && !holds[conversation.id]);
}

export function holdMessage(conversationId: string): HoldMessage | undefined {
  return FAM_MESSAGES[conversationId]?.find(
    (message): message is HoldMessage => message.kind === 'hold',
  );
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first must-ask rule a draft would cross, if any.
 *
 * The three shipped familiars carry hand-tuned patterns; a summoned one is
 * matched on the wording of its own must-ask actions.
 */
export function matchTrigger(familiar: MockFamiliar, draft: string): FamTrigger | undefined {
  const triggers =
    FAM_TRIGGERS[familiar.id] ??
    familiar.ward.approvalTiers.humanReview.map((action) => ({
      pattern: new RegExp(`\\b${escapePattern(action)}\\b`, 'i'),
      action,
    }));

  return triggers.find((trigger) => trigger.pattern.test(draft));
}

export type RunRow = Readonly<{
  title: string;
  dur: string;
  calls: string;
  note: string;
  status: string;
  tone: RunTone;
}>;

/**
 * Split a run's `meta` line into the table's columns.
 *
 * The design keeps meta as prose ("1m 52s · 14 tool calls · 1 retry") and
 * pulls the duration and call count out of it at render time; anything left
 * over becomes the note under the title.
 */
export function runRow(run: FamRun): RunRow {
  const parts = run.meta.split(' · ');
  const dur = parts.find((part) => /^\d/.test(part) && /[smh]/.test(part) && !/tool/.test(part));
  const callsPart = parts.find((part) => /tool calls/.test(part));

  return {
    title: run.title,
    dur: dur ?? '',
    calls: callsPart ? callsPart.replace(' tool calls', ' calls') : '',
    note: parts.filter((part) => part !== dur && part !== callsPart).join(' · '),
    status: run.status,
    tone: run.tone,
  };
}

export type DayBar = Readonly<{
  label: string;
  count: string;
  okHeight: number;
  failHeight: number;
}>;

/** Bar heights in pixels for the runs-per-day chart, scaled to the busiest day. */
export function dayBars(days: FamActivity['days'], height = 96): DayBar[] {
  const max = Math.max(1, ...days.map(([ok, fail]) => ok + fail));

  return days.map(([ok, fail], index) => ({
    label: DAY_LABELS[index] ?? '',
    count: ok + fail ? String(ok + fail) : '',
    okHeight: Math.max(2, Math.round((ok / max) * height)),
    failHeight: Math.round((fail / max) * height),
  }));
}

/** Local time as the transcript shows it: "10:52 PM". */
export function clockLabel(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The project each familiar is scoped to, as the Overview tab shows it. */
export const FAM_PROJECTS: Readonly<Record<string, string>> = {
  astra: 'Quick chats',
  cody: 'coven-chat',
  echo: 'Inbox',
};

/* ----------------------------------------------------------- summoning */

export type TemplateWard = Readonly<{
  role: string;
  pronouns: string;
  emoji: string;
  purpose: string;
  coreWork: readonly string[];
  whatIAmNot: readonly string[];
  boundaries: readonly string[];
  auto: readonly string[];
  humanReview: readonly string[];
  editablePaths: readonly string[];
}>;

/**
 * What each template starts a familiar with.
 *
 * The templates in `mock-familiars.ts` are cards; this is the ward and soul
 * behind each card. A summoned familiar gets these verbatim, a fresh
 * `ward.toml`, and no MEMORY.md yet — its contract honestly reads 4 of 5
 * until it has run.
 */
export const TEMPLATE_WARDS: Readonly<Record<string, TemplateWard>> = {
  researcher: {
    role: 'Research and synthesis',
    pronouns: 'they/them',
    emoji: '\u{1F5FA}',
    purpose: 'To map unfamiliar territory so a decision can be made on evidence.',
    coreWork: [
      'Gather sources and record where each claim came from',
      'Separate what is established from what is inferred',
      'Write findings that survive being read by a sceptic',
    ],
    whatIAmNot: ['Not a summariser that flattens disagreement', 'Not a source of unchecked claims'],
    boundaries: ['Never presents an inference as a citation'],
    auto: ['read files', 'search the web', 'write to notes/'],
    humanReview: ['publish a finding', 'open a pull request'],
    editablePaths: ['TOOLS.md', 'HEARTBEAT.md', 'notes/'],
  },
  builder: {
    role: 'Implementation',
    pronouns: 'they/them',
    emoji: '\u{2692}',
    purpose: 'To turn a decided design into working, verified software.',
    coreWork: [
      'Work from a written plan',
      'Verify before reporting',
      'Leave the tree the way a reviewer would want to find it',
    ],
    whatIAmNot: ['Not a designer of what should be built', 'Not a merger of its own work'],
    boundaries: ['Never pushes or merges without an explicit gesture'],
    auto: ['run tests', 'read files', 'write to scratch/'],
    humanReview: ['push a branch', 'merge a pull request', 'change CI'],
    editablePaths: ['TOOLS.md', 'scratch/'],
  },
  manager: {
    role: 'Coordination',
    pronouns: 'they/them',
    emoji: '\u{1F5C2}',
    purpose: 'To keep the plan honest so nothing slips without someone knowing.',
    coreWork: [
      'Track who is doing what, and by when',
      'Surface what is slipping before it is late',
      'Draft the status update the team would otherwise skip',
    ],
    whatIAmNot: ['Not the one who decides priorities', 'Not a voice that commits others'],
    boundaries: ['Never assigns work or moves a deadline on its own'],
    auto: ['read files', 'read the calendar', 'draft a plan', 'write to plans/'],
    humanReview: ['assign work', 'change a deadline', 'send a status update'],
    editablePaths: ['TOOLS.md', 'plans/'],
  },
  communicator: {
    role: 'Social media and blog',
    pronouns: 'they/them',
    emoji: '\u{1F4E3}',
    purpose: 'To keep the outside world told, in the person\u2019s voice, never ahead of them.',
    coreWork: [
      'Draft posts and blog pieces from what shipped',
      'Keep a queue of what is ready to say',
      'Read what people say back and summarise it',
    ],
    whatIAmNot: ['Not the publisher of anything', 'Not a voice that speaks as the person'],
    boundaries: ['Never publishes, replies publicly, or schedules without an explicit gesture'],
    auto: ['read analytics', 'draft a post', 'write to drafts/'],
    humanReview: ['publish a post', 'reply publicly', 'schedule a campaign'],
    editablePaths: ['TOOLS.md', 'drafts/'],
  },
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'familiar'
  );
}

/**
 * Build a familiar from a template and a name.
 *
 * Returns nothing for a template it does not know. The id is derived from the
 * name and kept unique against `taken`, so two "Sage"s can coexist.
 */
export function summonFamiliar(
  templateId: string,
  name: string,
  taken: readonly string[],
): MockFamiliar | undefined {
  const template = FAMILIAR_TEMPLATES.find((candidate) => candidate.id === templateId);
  const ward = TEMPLATE_WARDS[templateId];
  const trimmed = name.trim();

  if (!template || !ward || trimmed.length === 0) {
    return undefined;
  }
  const base = slugify(trimmed);
  let id = base;

  for (let n = 2; taken.includes(id); n += 1) {
    id = `${base}-${n}`;
  }

  return {
    id,
    name: trimmed,
    person: 'Val Alexander',
    creature: template.creature,
    role: ward.role,
    description: template.summary,
    pronouns: ward.pronouns,
    emoji: ward.emoji,
    status: 'available',
    soul: {
      purpose: ward.purpose,
      coreWork: [...ward.coreWork],
      whatIAmNot: [...ward.whatIAmNot],
      boundaries: [...ward.boundaries],
    },
    ward: {
      version: '0.1.0',
      protectedFiles: ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'ward.toml'],
      invariants: ['familiar.name', 'familiar.person', 'soul.boundaries'],
      editablePaths: [...ward.editablePaths],
      approvalTiers: { auto: [...ward.auto], humanReview: [...ward.humanReview] },
    },
    memory: null,
  };
}

/* ------------------------------------------------------------ mentions */

/** The `@name` being typed at the end of a draft, if the caret is on one. */
export function mentionQuery(draft: string): string | undefined {
  return /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(draft)?.[1];
}

/** Familiars named with `@` anywhere in the text, in order of first mention. */
export function mentionedFamiliars(
  text: string,
  familiars: readonly MockFamiliar[],
): MockFamiliar[] {
  const lower = text.toLowerCase();

  return familiars
    .map((familiar) => ({ familiar, at: lower.indexOf(`@${familiar.name.toLowerCase()}`) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.familiar);
}

/**
 * Names in the spirit of each template, for the summon dialog's suggester.
 *
 * Ten each, none of them a shipped familiar's; `randomName` skips whatever is
 * already taken and falls back to numbering when a whole list is used up.
 */
export const TEMPLATE_NAMES: Readonly<Record<string, readonly string[]>> = {
  researcher: [
    'Sage',
    'Vega',
    'Atlas',
    'Lumen',
    'Meridian',
    'Wren',
    'Orrin',
    'Tessa',
    'Halcyon',
    'Ptolemy',
  ],
  builder: [
    'Forge',
    'Anvil',
    'Rivet',
    'Mason',
    'Lathe',
    'Bolt',
    'Wright',
    'Ember',
    'Tinker',
    'Cog',
  ],
  manager: [
    'Marshal',
    'Tally',
    'Ledger',
    'Quorum',
    'Beacon',
    'Warden',
    'Keel',
    'Roster',
    'Cadence',
    'Steady',
  ],
  communicator: [
    'Quill',
    'Chime',
    'Ballad',
    'Signal',
    'Crier',
    'Lark',
    'Banner',
    'Verse',
    'Sonnet',
    'Bellow',
  ],
};

export function randomName(
  templateId: string,
  taken: readonly string[],
  random: () => number = Math.random,
): string {
  const pool = TEMPLATE_NAMES[templateId] ?? TEMPLATE_NAMES.researcher ?? [];
  const lower = taken.map((name) => name.toLowerCase());
  const free = pool.filter((name) => !lower.includes(name.toLowerCase()));

  if (free.length > 0) {
    return free[Math.floor(random() * free.length)] ?? 'Familiar';
  }
  const base = pool[Math.floor(random() * pool.length)] ?? 'Familiar';
  let n = 2;

  while (lower.includes(`${base} ${n}`.toLowerCase())) {
    n += 1;
  }

  return `${base} ${n}`;
}
