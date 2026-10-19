import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  keyboardInspectorWidth,
  preferredInspectorWidth,
  settleInspectorWidth,
} from './inspector-width';

type Drag = Readonly<{ pointerId: number; startX: number; startWidth: number; width: number }>;

/**
 * The inspector's draggable left edge: a focusable separator that reports the
 * rail's current width. Dragging holds pointer capture, so the edge follows
 * the pointer wherever it goes and lets go on release, cancel or lost capture.
 * Arrow keys move the edge a step, Home and End to the ends of the room.
 */
export function InspectorResizer({
  width,
  room,
  direction,
  onPreview,
  onCommit,
}: Readonly<{
  /** The width the inspector has now. */
  width: number;
  /** How wide it may be in this window. */
  room: number;
  direction: 'ltr' | 'rtl';
  /** A width to show while a drag is under way, or null when it ends. */
  onPreview: (width: number | null) => void;
  /** A width to keep as the preference. */
  onCommit: (width: number) => void;
}>) {
  const drag = useRef<Drag | null>(null);
  const widest = settleInspectorWidth(INSPECTOR_MAX_WIDTH, room);

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    const node = event.currentTarget;
    if (
      typeof node.releasePointerCapture === 'function' &&
      node.hasPointerCapture?.(event.pointerId)
    )
      node.releasePointerCapture(event.pointerId);
    onPreview(null);
    onCommit(current.width);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A dialog takes its own keys; the rail behind it stays put.
    if (document.querySelector('dialog[open]')) return;
    const next = keyboardInspectorWidth(event.key, width, room, direction);
    if (next === null) return;
    event.preventDefault();
    if (next !== width) onCommit(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator with a value is the ARIA widget for a draggable edge; <hr> is a rule.
    <div
      role="separator"
      tabIndex={0}
      className="coven-inspector-resizer"
      aria-label="Resize inspector"
      aria-orientation="vertical"
      aria-controls="coven-familiar-inspector"
      aria-valuenow={width}
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={widest}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        const node = event.currentTarget;
        if (typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          width,
        };
        onPreview(width);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const travel = (current.startX - event.clientX) * (direction === 'rtl' ? -1 : 1);
        const next = preferredInspectorWidth(current.startWidth + travel);
        drag.current = { ...current, width: next };
        onPreview(next);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        // Capture can go without an up or cancel (a modal took the window,
        // say): whatever pointer held it, the drag ends where it was.
        const current = drag.current;
        if (!current) return;
        drag.current = null;
        onPreview(null);
        onCommit(current.width);
      }}
    />
  );
}
