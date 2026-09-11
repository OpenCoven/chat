import { deserialize, serialize } from 'node:v8';
import { isStoredConversation, sanitizeRecords } from './chat-records';

const parent = {
  id: 'parent',
  familiarId: 'local',
  title: 'Parent',
  createdAt: '2026-09-11T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
};

test.each(['open', 'closed', 'discarded'] as const)(
  'side state %s must remain an exact literal after structured serialization',
  (state) => {
    const side = {
      ...parent,
      id: 'side',
      side: { parentConversationId: parent.id, operationKey: 'create-side', state },
    };
    expect(isStoredConversation(deserialize(serialize(side)))).toBe(true);
    for (const malformed of [Object(state), [state], { state }]) {
      const record: unknown = deserialize(
        serialize({ ...side, side: { ...side.side, state: malformed } }),
      );
      expect(isStoredConversation(record)).toBe(false);
      expect(
        Reflect.apply(sanitizeRecords, undefined, [
          { conversations: [parent, record], messages: [] },
        ]),
      ).toEqual({ conversations: [parent], messages: [] });
    }
  },
);
