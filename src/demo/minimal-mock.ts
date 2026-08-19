import type { IconName } from './minimal-icons';

/**
 * Mock content for the Minimal (macOS) surface.
 *
 * Every string below is a fixture. Nothing here reads a Cave, and nothing here
 * is a contract: the surface exists to show what the approved design says and
 * how it behaves, and it is meant to be deleted when the real read and send
 * paths land.
 *
 * The copy is kept verbatim from the design rather than paraphrased. Half of
 * what that design is arguing is in the wording — "Asks you" rather than
 * "requires permission", "nothing left this machine" rather than "cancelled" —
 * and rewriting it in passing would quietly lose the argument.
 */

export type AgentId = 'astra' | 'cody' | 'echo';

/** What a familiar is allowed to do, and whether it has to ask first. */
export type PermissionState = 'Allowed' | 'Asks you' | 'Off';

export type AgentStatus = 'available' | 'offline' | 'working';

export type MinimalAgent = Readonly<{
  id: AgentId;
  name: string;
  initial: string;
  /** Hue for the familiar's mark, so each one is recognisable at 20 pixels. */
  hue: number;
  role: string;
  kind: string;
  pronouns: string;
  status: AgentStatus;
  purpose: string;
  permissions: ReadonlyArray<{ icon: IconName; name: string; state: PermissionState }>;
  /**
   * The five promises a familiar makes. `ok: false` is not a failure state to
   * be hidden — Echo keeping no memory is a real answer to a real question,
   * and the sheet says so plainly rather than leaving the row out.
   */
  contract: ReadonlyArray<{ title: string; note: string; ok: boolean }>;
}>;

export const MINIMAL_AGENTS: Readonly<Record<AgentId, MinimalAgent>> = {
  cody: {
    id: 'cody',
    name: 'Cody',
    initial: 'C',
    hue: 158,
    role: 'Implementation',
    kind: 'Artificer',
    pronouns: 'he/him',
    status: 'working',
    purpose:
      'Turns a decided plan into working, verified code. It runs the tests before it tells you something passes.',
    permissions: [
      { icon: 'folder-open', name: 'Read and edit project files', state: 'Allowed' },
      { icon: 'terminal-window', name: 'Run tests and builds', state: 'Allowed' },
      { icon: 'git-branch', name: 'Push a branch or open a PR', state: 'Asks you' },
      { icon: 'brain', name: 'Remember decisions', state: 'Allowed' },
    ],
    contract: [
      { title: 'Named', note: 'Cody, an artificer.', ok: true },
      { title: 'Purpose', note: '3 jobs, 2 things it refuses to do.', ok: true },
      { title: 'Limits', note: '3 actions wait for your approval.', ok: true },
      { title: 'Memory', note: '1,284 notes, last written 11 minutes ago.', ok: true },
      { title: 'Owner', note: 'Belongs to you — that cannot be edited here.', ok: true },
    ],
  },
  astra: {
    id: 'astra',
    name: 'Astra',
    initial: 'A',
    hue: 291,
    role: 'Research',
    kind: 'Cartographer',
    pronouns: 'she/her',
    status: 'available',
    purpose:
      'Maps unfamiliar ground so a decision can rest on evidence. It cites what it read and flags what it only inferred.',
    permissions: [
      { icon: 'books', name: 'Read docs and notes', state: 'Allowed' },
      { icon: 'globe', name: 'Search the web', state: 'Allowed' },
      { icon: 'pencil-simple', name: 'Publish a finding', state: 'Asks you' },
      { icon: 'brain', name: 'Remember decisions', state: 'Allowed' },
    ],
    contract: [
      { title: 'Named', note: 'Astra, a cartographer.', ok: true },
      { title: 'Purpose', note: '3 jobs, 2 things it refuses to do.', ok: true },
      { title: 'Limits', note: '2 actions wait for your approval.', ok: true },
      { title: 'Memory', note: '412 notes, last written 2 hours ago.', ok: true },
      { title: 'Owner', note: 'Belongs to you — that cannot be edited here.', ok: true },
    ],
  },
  echo: {
    id: 'echo',
    name: 'Echo',
    initial: 'E',
    hue: 78,
    role: 'Correspondence',
    kind: 'Herald',
    pronouns: 'they/them',
    status: 'offline',
    purpose: 'Triages and drafts replies, and never sends anything without you saying so.',
    permissions: [
      { icon: 'envelope', name: 'Read and draft mail', state: 'Allowed' },
      { icon: 'paper-plane-tilt', name: 'Send mail', state: 'Asks you' },
      { icon: 'archive', name: 'Archive a thread', state: 'Asks you' },
      { icon: 'brain', name: 'Remember decisions', state: 'Off' },
    ],
    contract: [
      { title: 'Named', note: 'Echo, a herald.', ok: true },
      { title: 'Purpose', note: '3 jobs, 2 things it refuses to do.', ok: true },
      { title: 'Limits', note: '2 actions wait for your approval.', ok: true },
      { title: 'Memory', note: 'Nothing is kept between chats yet.', ok: false },
      { title: 'Owner', note: 'Belongs to you — that cannot be edited here.', ok: true },
    ],
  },
};

export type MinimalChat = Readonly<{
  id: string;
  title: string;
  /** `null` is a quick chat: no project, and nothing saved. */
  project: string | null;
  agent: AgentId;
  when: string;
  badge?: 'approval' | 'question';
}>;

export const MINIMAL_CHATS: readonly MinimalChat[] = [
  {
    id: 'c1',
    title: 'Attention centre wiring',
    project: 'coven-cave',
    agent: 'cody',
    when: '2m',
    badge: 'approval',
  },
  {
    id: 'c2',
    title: 'Which schema is right?',
    project: 'coven-cave',
    agent: 'astra',
    when: '1h',
    badge: 'question',
  },
  { id: 'c3', title: 'Release note draft', project: 'grimoire', agent: 'echo', when: 'Yest.' },
  { id: 'q1', title: 'Quick chat', project: null, agent: 'astra', when: 'Yest.' },
  { id: 'new', title: 'New chat', project: 'coven-cave', agent: 'cody', when: 'now' },
];

export type RunStep = Readonly<{
  text: string;
  took: string;
  /** `null` while a step is still going. */
  done: boolean | null;
}>;

export type MessageAction = Readonly<{ icon: IconName; label: string }>;

export type MinimalMessage =
  | Readonly<{ id: string; kind: 'user'; text: string }>
  | Readonly<{ id: string; kind: 'notice'; text: string }>
  | Readonly<{
      id: string;
      kind: 'agent';
      agent: AgentId;
      text: string;
      code?: string;
      actions?: readonly MessageAction[];
    }>
  | Readonly<{
      id: string;
      kind: 'image';
      agent: AgentId;
      prompt: string;
      alt: string;
      caption: string;
    }>
  | Readonly<{
      id: string;
      kind: 'run';
      text: string;
      meta: string;
      footnote: string;
      steps: readonly RunStep[];
    }>;

/** The three actions offered under a written reply. */
export const REPLY_ACTIONS: readonly MessageAction[] = [
  { icon: 'copy', label: 'Copy' },
  { icon: 'arrow-counter-clockwise', label: 'Retry' },
  { icon: 'file-text', label: 'Save as note' },
];

/** A streamed reply offers less: there is nothing to save yet. */
export const SHORT_REPLY_ACTIONS: readonly MessageAction[] = [
  { icon: 'copy', label: 'Copy' },
  { icon: 'arrow-counter-clockwise', label: 'Retry' },
];

export type ApprovalOutcome = 'approved' | 'denied' | 'pending';

/**
 * The seeded transcript for a chat, before anything the visitor sends.
 *
 * `c1` takes the approval outcome because the last line of that transcript is
 * the consequence of the decision: the notice is the only place the surface
 * says what happened after the sheet closed.
 */
export function minimalTranscript(chatId: string, approval: ApprovalOutcome): MinimalMessage[] {
  if (chatId === 'new') {
    return [];
  }

  if (chatId === 'q1') {
    return [
      {
        id: 'q1-scope',
        kind: 'notice',
        text: 'Quick chat — this one is not attached to a project.',
      },
      { id: 'q1-ask', kind: 'user', text: 'Draw me a purple cat for the empty state.' },
      {
        id: 'q1-reply',
        kind: 'agent',
        agent: 'astra',
        text: 'Here you go. Nothing is saved to a project — move it into one if you want to keep it.',
        actions: REPLY_ACTIONS,
      },
      {
        id: 'q1-image',
        kind: 'image',
        agent: 'astra',
        prompt: 'cat purple',
        alt: 'A purple cat in a glowing garden',
        caption: 'Generated image · 600 × 400',
      },
    ];
  }

  if (chatId === 'c2') {
    return [
      {
        id: 'c2-ask',
        kind: 'user',
        text: 'Is the attention payload in the docs or in the generated schema? Use whichever is right.',
      },
      {
        id: 'c2-reply',
        kind: 'agent',
        agent: 'astra',
        text: 'They disagree, so I stopped rather than guess. The doc lists four kinds; the generated schema lists five and adds “partly done”. Which should I treat as the source of truth?',
        actions: REPLY_ACTIONS,
      },
      {
        id: 'c2-waiting',
        kind: 'notice',
        text: 'Astra is waiting for your answer. Nothing runs until you reply.',
      },
    ];
  }

  if (chatId === 'c3') {
    return [
      {
        id: 'c3-ask',
        kind: 'user',
        text: 'Draft the 1.4 release note for the docs list. Do not send it.',
      },
      {
        id: 'c3-reply',
        kind: 'agent',
        agent: 'echo',
        text: 'Draft is ready — three paragraphs, no links to unshipped surfaces. Sending needs your go-ahead, so it is sitting in drafts.',
        actions: REPLY_ACTIONS,
      },
      {
        id: 'c3-offline',
        kind: 'notice',
        text: 'Echo went offline 3 hours ago. The draft is saved.',
      },
    ];
  }

  const outcome: Record<ApprovalOutcome, string> = {
    approved: 'You allowed the push. Draft PR #412 is open.',
    denied: 'You didn’t allow the push. Nothing left this machine.',
    pending: 'Cody is waiting for your approval to push the branch.',
  };

  return [
    {
      id: 'c1-ask',
      kind: 'user',
      text: 'Wire the attention list to the new endpoint. Keep the empty-state copy we agreed.',
    },
    {
      id: 'c1-plan',
      kind: 'agent',
      agent: 'cody',
      text: 'Plan: read the schema, add the mapper, wire the list behind the feature check, run the tests, then push. I will stop before pushing.',
      actions: REPLY_ACTIONS,
    },
    {
      id: 'c1-run',
      kind: 'run',
      text: 'Running tests — 46 of 61 passed',
      meta: 'step 5 of 7',
      footnote: 'Keep chatting if you like — this finishes on its own.',
      steps: [
        { text: 'Read the schema and the current list', took: '4.1s', done: true },
        { text: 'Added the mapper (+82 −4)', took: '0.6s', done: true },
        { text: 'Wired the list behind the feature check', took: '1.2s', done: true },
        { text: 'Running tests', took: '48s', done: null },
      ],
    },
    {
      id: 'c1-judgement',
      kind: 'agent',
      agent: 'cody',
      text: 'One judgement call: the endpoint has a fifth item kind the doc never mentions. I mapped it to “partly done” rather than inventing a label, and left Astra a note.',
      code: 'case "partial_completion":\n  return { ...base(raw), kind: "partial" };',
      actions: REPLY_ACTIONS,
    },
    { id: 'c1-outcome', kind: 'notice', text: outcome[approval] },
  ];
}

/** What a row of activity is: finished, still going, waiting on you, or read. */
export type ActivityTone = 'done' | 'read' | 'waiting' | 'working';

export type ActivityGroup = Readonly<{
  label: string;
  rows: ReadonlyArray<{ text: string; meta: string; tone: ActivityTone }>;
}>;

export const MINIMAL_ACTIVITY: readonly ActivityGroup[] = [
  {
    label: 'Right now',
    rows: [
      { text: 'Running tests — 46 of 61 passed', meta: '48s', tone: 'working' },
      { text: 'Waiting to push the branch', meta: '—', tone: 'waiting' },
    ],
  },
  {
    label: 'Files it touched',
    rows: [
      { text: 'src/lib/attention.ts', meta: '+82', tone: 'done' },
      { text: 'src/components/attention-list.tsx', meta: '+41', tone: 'done' },
      { text: 'docs/specs/attention.md', meta: 'read', tone: 'read' },
    ],
  },
  {
    label: 'Earlier today',
    rows: [
      { text: 'You approved a 7-step plan', meta: '10:41', tone: 'done' },
      { text: 'Astra asked which schema is right', meta: '09:58', tone: 'working' },
    ],
  },
];

/** Suggested openers for a chat with nothing in it yet. */
export const MINIMAL_STARTERS: ReadonlyArray<{ text: string; mode: ComposerMode }> = [
  { text: 'Plan issue #318 before touching anything', mode: 'plan' },
  { text: 'Find where the attention payload is parsed', mode: 'ask' },
  { text: 'Review the diff on feat/attention-center', mode: 'ask' },
];

/** How much rope the familiar gets on the next message. */
export type ComposerMode = 'ask' | 'do' | 'plan';

export const COMPOSER_MODE_LABELS: Readonly<Record<ComposerMode, string>> = {
  ask: 'Just answer',
  plan: 'Plan first',
  do: 'Go ahead',
};

export const NEXT_COMPOSER_MODE: Readonly<Record<ComposerMode, ComposerMode>> = {
  ask: 'plan',
  plan: 'do',
  do: 'ask',
};

/**
 * The approval request.
 *
 * Three facts, in the order someone deciding actually needs them: what it
 * reaches, what leaves the machine, and whether it can be taken back.
 */
export const MINIMAL_APPROVAL = {
  title: 'Let Cody push this branch?',
  project: 'coven-cave',
  body: 'It finished the tests and wants to push feat/attention-center, then open a draft pull request. The branch leaves this Mac; you can delete it afterwards.',
  facts: [
    { label: 'What it uses', value: 'GitHub', reassuring: false },
    { label: 'What it sends', value: 'The code changes and a commit message', reassuring: false },
    { label: 'Can be undone', value: 'Yes', reassuring: true },
  ],
  diff: [
    { path: 'src/lib/attention.ts', added: '+82', removed: '−4' },
    { path: 'src/components/attention-list.tsx', added: '+41', removed: '−16' },
    { path: 'docs/specs/attention.md', added: '+25', removed: '−2' },
  ],
} as const;
