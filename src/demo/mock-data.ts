/**
 * Mock data for the proof-of-concept chat demo.
 *
 * Everything here is fabricated and local. The demo connects to nothing: no
 * Cave, no network, no persistence. That is deliberate — Phase 0's boundary
 * still holds, and this exists to show what the later phases will look like,
 * not to anticipate their behaviour.
 *
 * When Phases 1 through 3 land, this module is what gets deleted: the shapes
 * below are intentionally close to the canonical ones so the swap is a change
 * of source rather than a rewrite of the view.
 */

import {
  findLinkHost,
  type MockArtifact,
  type MockLinkPreview,
  mockHandoffArtifact,
  mockLinkPreview,
  mockSpecArtifact,
} from './mock-rich-content';

export type MockRole = 'user' | 'assistant';

export type MockMessage = {
  id: string;
  role: MockRole;
  /** Send time, revealed on hover and focus rather than shown always. */
  sentAt: string;
  /** Plain body text. A `/command` prefix is styled by the renderer. */
  text?: string;
  /**
   * Set when the turn is a generated image rather than prose.
   *
   * Carries a description and the prompt it came from: the placeholder is
   * drawn by the renderer as inline SVG, seeded off the prompt so different
   * prompts look different. No `src`, so no URL literal enters runtime source,
   * which the Phase 0 guard against ad hoc networking primitives forbids.
   */
  image?: { alt: string; prompt: string };
  /** Set when the turn unfurls a link the message contained. */
  link?: MockLinkPreview;
  /** Set when the turn is a generated `/spec` or `/handoff` document. */
  artifact?: MockArtifact;
};

export type MockConversation = {
  id: string;
  title: string;
  /** Secondary line in the sidebar. */
  preview: string;
  /** Leading glyph on the preview line, as Messages shows for attachments. */
  previewGlyph?: string;
  timestamp: string;
  /** Divider shown above the first message. */
  openedAt: string;
  messages: MockMessage[];
};

export const MOCK_CONVERSATIONS: MockConversation[] = [
  {
    id: 'quick-chat',
    title: 'Quick Chat',
    preview: 'Photo',
    previewGlyph: '\u{1F4F7}',
    timestamp: 'Yesterday',
    openedAt: 'Yesterday 10:39 PM',
    messages: [
      { id: 'm1', role: 'user', sentAt: '10:39 PM', text: 'hey' },
      {
        id: 'm2',
        role: 'assistant',
        sentAt: '10:39 PM',
        text: "Hey! How's it going? What can I help you with?",
      },
      { id: 'm3', role: 'user', sentAt: '10:41 PM', text: '/image cat purple' },
      {
        id: 'm4',
        role: 'assistant',
        sentAt: '10:41 PM',
        image: { alt: 'A purple cat in a glowing garden', prompt: 'cat purple' },
      },
    ],
  },
  {
    id: 'new-chat',
    title: 'New Chat',
    preview: 'New conversation',
    timestamp: 'Yesterday',
    openedAt: 'Yesterday 10:12 PM',
    messages: [],
  },
];

/** Canned replies, cycled so repeated sends do not repeat verbatim. */
const CANNED_REPLIES = [
  'Got it. Want me to take a look at that now?',
  'That makes sense. I can start on it whenever you are ready.',
  'Sure thing. Anything specific you want me to prioritise?',
  'Done thinking about it — say the word and I will begin.',
];

/** A wall-clock label for a message just sent. */
export function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The reply the demo produces for a given input. */
export function mockReply(input: string, replyIndex: number): MockMessage {
  const trimmed = input.trim();
  const id = `mock-${replyIndex}`;
  const sentAt = nowLabel();
  const command = /^\/([a-z-]+)\s*(.*)$/is.exec(trimmed);
  const name = command?.[1]?.toLowerCase();
  const argument = command?.[2] ?? '';

  if (name === 'image') {
    const prompt = argument.trim() || 'an image';

    return { id, role: 'assistant', sentAt, image: { alt: `Generated image: ${prompt}`, prompt } };
  }

  if (name === 'spec') {
    return { id, role: 'assistant', sentAt, artifact: mockSpecArtifact(argument) };
  }

  if (name === 'handoff') {
    return { id, role: 'assistant', sentAt, artifact: mockHandoffArtifact(argument) };
  }

  // A message carrying a link unfurls it. The unfurl is invented locally; the
  // page is never requested.
  const host = findLinkHost(trimmed);

  if (host) {
    return { id, role: 'assistant', sentAt, link: mockLinkPreview(host) };
  }

  // Indexed access is `string | undefined` under noUncheckedIndexedAccess, and
  // exactOptionalPropertyTypes will not accept that for an optional field.
  const reply =
    CANNED_REPLIES[replyIndex % CANNED_REPLIES.length] ?? CANNED_REPLIES[0] ?? 'Got it.';

  return { id, role: 'assistant', sentAt, text: reply };
}

/** Commands the composer offers when the input starts with `/`. */
export const MOCK_COMMANDS = [
  { name: '/image', hint: 'Generate an image from a prompt' },
  { name: '/spec', hint: 'Draft a specification document' },
  { name: '/handoff', hint: 'Write a handoff for another session' },
];
