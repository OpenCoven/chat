import { describe, expect, it } from 'vitest';

import { firstGrapheme } from './chat-demo';

/**
 * The conversation avatar shows a label's first character.
 *
 * "First character" is the whole difficulty. charAt(0) indexes UTF-16 code
 * units, so a title starting with an emoji yields half a surrogate pair and
 * renders as a replacement character — which is what shipped until review
 * caught it.
 */
describe('firstGrapheme', () => {
  it('takes the first letter of an ordinary label', () => {
    expect(firstGrapheme('Quick Chat')).toBe('Q');
    expect(firstGrapheme('  padded  ')).toBe('p');
  });

  it('keeps an emoji whole rather than splitting its surrogate pair', () => {
    // 'cat'.charAt(0) on this string returns '\ud83d' alone, which renders as
    // the replacement character.
    expect(firstGrapheme('🐱 Cat chat')).toBe('🐱');
    expect(firstGrapheme('🐱 Cat chat')).not.toBe('\ud83d');
  });

  it('keeps a joined emoji sequence whole', () => {
    // Spreading the string would fix the surrogate pair and still return only
    // the first person of this family.
    expect(firstGrapheme('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
  });

  it('returns nothing for a label with nothing in it', () => {
    expect(firstGrapheme('')).toBe('');
    expect(firstGrapheme('   ')).toBe('');
  });
});
