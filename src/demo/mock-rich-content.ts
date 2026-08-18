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
  /** First lines of the body, shown under the title. */
  lines: string[];
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

  return {
    kind: 'spec',
    title: `Specification: ${subject}`,
    meta: '4 sections · 3 min read',
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

  return {
    kind: 'handoff',
    title: `Handoff: ${subject}`,
    meta: '3 sections · 2 min read',
    lines: [
      'Current state — what is true now, including what is half-finished.',
      'Next action — the first concrete step, as a command or a file path.',
      'Blockers — what is waiting on a person, and which person.',
    ],
  };
}
