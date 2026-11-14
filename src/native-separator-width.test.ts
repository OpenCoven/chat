import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/rows.mjs';
const { timesWidthSaid } = await import(path);

test('row 504-6 counts each time a reading gives the separator width (#579)', () => {
  // VoiceOver on both macOS lanes of native run 42801851275 (published v0.0.9).
  const v009 =
    'vertical splitter 360 pixels Resize inspector 360 pixels wide. Arrow keys resize it, Home and End reach the limits.360 pixels wide. Arrow keys resize it, Home and End reach the limits. Familiar inspector complementary';
  expect(timesWidthSaid(v009, 360, 25)).toBe(3);
  expect(
    timesWidthSaid(
      'vertical splitter 360 pixels Resize inspector Arrow keys resize it, Home and End reach the limits.',
      360,
      25,
    ),
  ).toBe(1);
  // VoiceOver speaks a value with no value text as a percentage of the range.
  expect(timesWidthSaid('vertical splitter 25% Resize inspector 360 pixels wide.', 360, 25)).toBe(
    2,
  );
  expect(timesWidthSaid('vertical splitter Resize inspector', 360, 25)).toBe(0);
  expect(timesWidthSaid('3600 pixels, 125%, 1360', 360, 25)).toBe(0);
});
