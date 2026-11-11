import { join } from 'node:path';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/unavailable-row.mjs';
const { chatDataDir, withUnreadableChat, withoutUnreadableChat } = await import(path);

test('the row stages an unreadable chat only for a familiar with no record', () => {
  const heads = { astra: 'one', sage: null };
  expect(withUnreadableChat(heads, 'wren', 'missing')).toEqual({ ...heads, wren: 'missing' });
  expect(() => withUnreadableChat(heads, 'astra', 'missing')).toThrow('already has');
  expect(heads).toEqual({ astra: 'one', sage: null });
});

test('cleanup removes only the staged entry and keeps what Chat changed since', () => {
  const later = { astra: 'two', wren: 'missing' };
  expect(withoutUnreadableChat(later, 'wren', 'missing')).toEqual({ astra: 'two' });
  const moved = { astra: 'two', wren: 'real' };
  expect(withoutUnreadableChat(moved, 'wren', 'missing')).toBe(moved);
});

test('the record lives in the app-local data folder Chat uses', () => {
  expect(chatDataDir('mac', {}, '/Users/r')).toBe(
    join('/Users/r', 'Library', 'Application Support', 'ai.opencoven.chat'),
  );
  expect(chatDataDir('windows', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U')).toBe(
    join('C:\\L', 'ai.opencoven.chat'),
  );
  expect(chatDataDir('linux', {}, '/home/r')).toBe(
    join('/home/r', '.local', 'share', 'ai.opencoven.chat'),
  );
});
