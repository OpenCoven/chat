import { MOCK_CONVERSATIONS } from './mock-data';
import { MOCK_FAMILIARS } from './mock-familiars';

describe('chat demo shell', () => {
  it('binds every conversation to a known familiar', () => {
    const familiarIds = new Set(MOCK_FAMILIARS.map((familiar) => familiar.id));

    expect(
      MOCK_CONVERSATIONS.every((conversation) => familiarIds.has(conversation.familiarId)),
    ).toBe(true);
  });
});
