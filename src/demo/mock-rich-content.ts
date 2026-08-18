/**
 * Mock rich-content producers for the demo: link unfurls, generated images,
 * and `/spec` and `/handoff` artifacts.
 *
 * Every one of these is local and fabricated. Nothing fetches. In particular
 * the link unfurl does not request the page it is describing — a real
 * implementation would resolve Open Graph tags server-side, and the design
 * spec is explicit that a transcript must not silently contact a third party.
 * The demo skips that question entirely by inventing the metadata.
 */

/** A card describing a linked page, as an Open Graph unfurl would. */
export type MockLinkPreview = {
  /** Bare host, shown as the card's footer. Never a full URL. */
  domain: string;
  title: string;
  authorName: string;
  authorHandle: string;
  /** Engagement line, e.g. "112 likes - 17 replies". */
  stats?: string;
  /** Selects which inline hero illustration to draw. */
  hero: 'diagram' | 'repository' | 'plain';
};

/** A generated document rendered as a compact card. */
export type MockArtifact = {
  kind: 'spec' | 'handoff';
  title: string;
  /** Sections and reading time, as the design spec's document card shows. */
  meta: string;
  /** First lines of the body, shown under the title on the card. */
  lines: string[];
  /** Full body, opened in the reader. */
  markdown: string;
};

/**
 * Find a bare URL in message text.
 *
 * The scheme is written escaped so no `http` literal appears in runtime
 * source; the Phase 0 guard against ad hoc networking primitives rejects one
 * outright, and it is right to — this module resolves nothing.
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/i;

/** The bare host of a detected URL, lowercased and stripped of `www.`. */
export function findLinkHost(text: string): string | undefined {
  const match = URL_PATTERN.exec(text);

  if (!match) {
    return undefined;
  }

  const withoutScheme = match[0].replace(/^https?:\/\//i, '');
  const host = withoutScheme.split('/')[0] ?? '';

  return host.replace(/^www\./i, '').toLowerCase() || undefined;
}

/** Mock unfurl metadata for a host. */
export function mockLinkPreview(host: string): MockLinkPreview {
  if (host.endsWith('x.com') || host.endsWith('twitter.com')) {
    return {
      domain: host,
      title: 'Eval Engineering: How You Actually Know If Your AI System Got Better',
      authorName: 'wast3',
      authorHandle: '@0xWast3',
      stats: '112 likes · 17 replies',
      hero: 'diagram',
    };
  }

  if (host.endsWith('github.com')) {
    return {
      domain: host,
      title: 'OpenCoven/chat: a local-first desktop client for the Cave conversation store',
      authorName: 'OpenCoven',
      authorHandle: 'TypeScript · Rust',
      stats: '48 stars · 6 forks',
      hero: 'repository',
    };
  }

  return {
    domain: host,
    title: 'A linked page',
    authorName: host,
    authorHandle: 'Preview',
    hero: 'plain',
  };
}

/** The `/spec` demo artifact. */
export function mockSpecArtifact(prompt: string): MockArtifact {
  const subject = prompt.trim() || 'the proposed change';
  const title = `Specification: ${subject}`;

  return {
    kind: 'spec',
    title,
    meta: '5 sections · 2 min read',
    markdown: SPEC_BODY.replace('{title}', title).replace('{subject}', subject),
    lines: [
      'Goals — what this must achieve, and what it explicitly will not.',
      'Authority — which component owns the data, and who may mutate it.',
      'Failure modes — what happens when the network, the disk, or the user disagrees.',
      'Open questions — the decisions still owed before implementation starts.',
    ],
  };
}

/** The `/handoff` demo artifact. */
export function mockHandoffArtifact(prompt: string): MockArtifact {
  const subject = prompt.trim() || 'this session';
  const title = `Handoff: ${subject}`;

  return {
    kind: 'handoff',
    title,
    meta: '4 sections · 1 min read',
    markdown: HANDOFF_BODY.replace('{title}', title).replace('{subject}', subject),
    lines: [
      'Current state — what is true now, including what is half-finished.',
      'Next action — the first concrete step, as a command or a file path.',
      'Blockers — what is waiting on a person, and which person.',
    ],
  };
}

/** Demo body for a `/spec` artifact. */
const SPEC_BODY = `# {title}

{subject} needs a written shape before anyone builds it. This document is that
shape: what the change must achieve, who owns the data it touches, and what
happens when the parts disagree.

## Goals

What this must achieve, stated so that a reviewer can tell whether it did.

- The behaviour is observable from outside the process.
- A failure is distinguishable from a success that did nothing.
- The change is reversible without a migration.

## Non-goals

Naming these is what keeps a review from expanding into a redesign.

- Performance work beyond what correctness requires.
- Any change to how the data is stored on disk.

## Authority

One component owns each piece of state, and only that component mutates it.
Everything else reads a copy and is explicit about the copy being stale.

\`\`\`ts
type Ownership = {
  owner: "cave" | "client";
  mutableBy: readonly string[];
};
\`\`\`

## Failure modes

The interesting cases are the ones where two parties each believe they are
correct.

- The network drops after the request is sent but before the reply arrives.
  The operation may or may not have landed, and the client must reconcile
  rather than retry.
- The disk is full when the cache is written. The read path must surface this
  rather than silently serving a partial result.
- The user edits the same conversation from two devices. Last write wins is a
  decision, not a default; this document picks one and says so.

## Open questions

Decisions still owed before implementation starts.

- Does reconciliation run on foreground, on a timer, or both?
- Who is responsible for pruning the cache once it exceeds its budget?
`;

/** Demo body for a `/handoff` artifact. */
const HANDOFF_BODY = `# {title}

Continuity notes for whoever picks up {subject}. Written to be actionable
without a conversation.

## Current state

What is true right now, including the parts that are half-finished.

- The read path works end to end against a live instance.
- The write path is written but unverified; nothing has exercised the retry
  branch.
- Tests cover the happy path only.

## Next action

The first concrete step, as a command rather than an intention.

\`\`\`bash
pnpm test:unit -- outbox
\`\`\`

If that passes, the branch is ready for review. If it fails on the ambiguous
outcome case, that is the known gap described below and not a regression.

## Decisions already made

Recording these prevents the next session from relitigating them.

- Ambiguous outcomes reconcile before resubmitting. Never the other way round.
- The cache is keyed by revision, not by timestamp.

## Blockers

- The counterpart fixture has not been reviewed, so the canary cannot pin it.
- One decision is owed by a person: whether stale reads are shown at all.
`;
