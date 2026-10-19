import { describe, expect, it } from 'vitest';
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_STEP,
  inspectorRoom,
  keyboardInspectorWidth,
  preferredInspectorWidth,
  settleInspectorWidth,
  TRANSCRIPT_MIN_WIDTH,
} from './inspector-width';

describe('preferredInspectorWidth', () => {
  it('keeps a whole number of pixels inside the allowed range', () => {
    expect(preferredInspectorWidth(INSPECTOR_DEFAULT_WIDTH)).toBe(360);
    expect(preferredInspectorWidth(280)).toBe(INSPECTOR_MIN_WIDTH);
    expect(preferredInspectorWidth(600)).toBe(INSPECTOR_MAX_WIDTH);
    expect(preferredInspectorWidth(412.6)).toBe(413);
  });

  it('clamps an out-of-range number and falls back from anything else', () => {
    expect(preferredInspectorWidth(100)).toBe(INSPECTOR_MIN_WIDTH);
    expect(preferredInspectorWidth(-5)).toBe(INSPECTOR_MIN_WIDTH);
    expect(preferredInspectorWidth(1e9)).toBe(INSPECTOR_MAX_WIDTH);
    for (const value of [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '420',
      '420px',
      true,
      {},
      [],
    ])
      expect(preferredInspectorWidth(value)).toBe(INSPECTOR_DEFAULT_WIDTH);
  });
});

describe('inspectorRoom', () => {
  it('leaves the transcript its minimum after the rail actually on the left', () => {
    expect(inspectorRoom(1400, 300)).toBe(1400 - 300 - TRANSCRIPT_MIN_WIDTH);
    expect(inspectorRoom(1400, 28)).toBe(1400 - 28 - TRANSCRIPT_MIN_WIDTH);
  });

  it('reads an unmeasured shell as unlimited room', () => {
    expect(inspectorRoom(0, 300)).toBe(Number.POSITIVE_INFINITY);
    expect(inspectorRoom(Number.NaN, 300)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('settleInspectorWidth', () => {
  it('uses the preference while there is room and clamps to the room when there is not', () => {
    expect(settleInspectorWidth(500, Number.POSITIVE_INFINITY)).toBe(500);
    expect(settleInspectorWidth(500, 520)).toBe(500);
    expect(settleInspectorWidth(500, 400)).toBe(400);
  });

  it('never goes under the minimum, even in a window too narrow for it', () => {
    expect(settleInspectorWidth(360, 100)).toBe(INSPECTOR_MIN_WIDTH);
    expect(settleInspectorWidth(360, Number.NEGATIVE_INFINITY)).toBe(INSPECTOR_MIN_WIDTH);
  });

  it('whole pixels only', () => {
    expect(settleInspectorWidth(360, 333.3)).toBe(333);
  });
});

describe('keyboardInspectorWidth', () => {
  const room = Number.POSITIVE_INFINITY;

  it('widens toward the conversation and narrows away from it, in the reading direction', () => {
    expect(keyboardInspectorWidth('ArrowLeft', 360, room, 'ltr')).toBe(360 + INSPECTOR_STEP);
    expect(keyboardInspectorWidth('ArrowRight', 360, room, 'ltr')).toBe(360 - INSPECTOR_STEP);
    expect(keyboardInspectorWidth('ArrowLeft', 360, room, 'rtl')).toBe(360 - INSPECTOR_STEP);
    expect(keyboardInspectorWidth('ArrowRight', 360, room, 'rtl')).toBe(360 + INSPECTOR_STEP);
  });

  it('jumps to the ends with Home and End, inside the room there is', () => {
    expect(keyboardInspectorWidth('Home', 360, room, 'ltr')).toBe(INSPECTOR_MIN_WIDTH);
    expect(keyboardInspectorWidth('End', 360, room, 'ltr')).toBe(INSPECTOR_MAX_WIDTH);
    expect(keyboardInspectorWidth('End', 360, 480, 'ltr')).toBe(480);
  });

  it('stops at the bounds and ignores other keys', () => {
    expect(keyboardInspectorWidth('ArrowLeft', INSPECTOR_MAX_WIDTH, room, 'ltr')).toBe(
      INSPECTOR_MAX_WIDTH,
    );
    expect(keyboardInspectorWidth('ArrowRight', INSPECTOR_MIN_WIDTH, room, 'ltr')).toBe(
      INSPECTOR_MIN_WIDTH,
    );
    expect(keyboardInspectorWidth('ArrowLeft', 500, 500, 'ltr')).toBe(500);
    expect(keyboardInspectorWidth('Enter', 360, room, 'ltr')).toBeNull();
    expect(keyboardInspectorWidth('ArrowUp', 360, room, 'ltr')).toBeNull();
  });
});
