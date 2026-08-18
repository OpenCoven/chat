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

export type MockRole = 'user' | 'assistant';

export type MockMessage = {
  id: string;
  role: MockRole;
  /** Plain body text. A `/command` prefix is styled by the renderer. */
  text?: string;
  /**
   * Set when the turn is a generated image rather than prose.
   *
   * Carries only a description: the placeholder is drawn by the renderer as
   * inline SVG. No `src`, so no URL literal enters runtime source, which the
   * Phase 0 guard against ad hoc networking primitives forbids outright.
   */
  image?: { alt: string };
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
      { id: 'm1', role: 'user', text: 'hey' },
      {
        id: 'm2',
        role: 'assistant',
        text: "Hey! How's it going? What can I help you with?",
      },
      { id: 'm3', role: 'user', text: '/image cat purple' },
      {
        id: 'm4',
        role: 'assistant',
        image: { alt: 'A purple cat in a glowing garden' },
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

/** The reply the demo produces for a given input. */
export function mockReply(input: string, replyIndex: number): MockMessage {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith('/image')) {
    const prompt = trimmed.slice('/image'.length).trim() || 'an image';

    return {
      id: `mock-${replyIndex}`,
      role: 'assistant',
      image: { alt: `Generated image: ${prompt}` },
    };
  }

  // Indexed access is `string | undefined` under noUncheckedIndexedAccess, and
  // exactOptionalPropertyTypes will not accept that for an optional field.
  const reply =
    CANNED_REPLIES[replyIndex % CANNED_REPLIES.length] ?? CANNED_REPLIES[0] ?? 'Got it.';

  return {
    id: `mock-${replyIndex}`,
    role: 'assistant',
    text: reply,
  };
}

/** Commands the composer offers when the input starts with `/`. */
export const MOCK_COMMANDS = [
  { name: '/image', hint: 'Generate an image from a prompt' },
  { name: '/spec', hint: 'Draft a specification document' },
  { name: '/handoff', hint: 'Write a handoff for another session' },
];
