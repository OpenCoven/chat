/**
 * Geometry for the resizable inspector rail. Pure: the layout measures, these
 * functions decide. The preferred width is what the reader chose and is kept;
 * the settled width is what the window has room for right now.
 */

/** The inspector's width before the reader changes it. */
export const INSPECTOR_DEFAULT_WIDTH = 360;
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 600;
/** How far one arrow press moves the edge. */
export const INSPECTOR_STEP = 16;
/** The conversation column keeps at least this much of the window's width. */
export const TRANSCRIPT_MIN_WIDTH = 440;

/**
 * A stored or requested width as a preference: a whole number inside the
 * allowed range. A number past the range is clamped; anything that is not a
 * finite number falls back to the default.
 */
export function preferredInspectorWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(value)));
}

/**
 * How wide the inspector may be in a shell of `shellWidth` pixels whose left
 * track (the open familiars rail or its closed tab) takes `leftWidth`. An
 * unmeasured shell sets no limit.
 */
export function inspectorRoom(shellWidth: number, leftWidth: number): number {
  if (!Number.isFinite(shellWidth) || shellWidth <= 0) return Number.POSITIVE_INFINITY;
  return shellWidth - leftWidth - TRANSCRIPT_MIN_WIDTH;
}

/** The width the inspector takes now: the preference, clamped to the room, never under the minimum. */
export function settleInspectorWidth(preferred: number, room: number): number {
  const limit =
    room === Number.POSITIVE_INFINITY || Number.isNaN(room)
      ? INSPECTOR_MAX_WIDTH
      : Math.floor(room);
  return Math.max(INSPECTOR_MIN_WIDTH, Math.min(preferred, limit));
}

/**
 * The width a key on the focused separator asks for, or null for a key it
 * does not handle. The edge being dragged is the inspector's left edge in a
 * left-to-right layout, so Left widens and Right narrows; mirrored for
 * right-to-left. Home and End go to the ends of what the room allows.
 */
export function keyboardInspectorWidth(
  key: string,
  current: number,
  room: number,
  direction: 'ltr' | 'rtl',
): number | null {
  const widest = settleInspectorWidth(INSPECTOR_MAX_WIDTH, room);
  const wider = direction === 'ltr' ? 'ArrowLeft' : 'ArrowRight';
  const narrower = direction === 'ltr' ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case wider:
      return Math.min(widest, current + INSPECTOR_STEP);
    case narrower:
      return Math.max(INSPECTOR_MIN_WIDTH, current - INSPECTOR_STEP);
    case 'Home':
      return INSPECTOR_MIN_WIDTH;
    case 'End':
      return widest;
    default:
      return null;
  }
}
