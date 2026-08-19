import type { ReactNode } from 'react';

/**
 * The icon set the Minimal (macOS) design asks for, drawn inline.
 *
 * The design references Phosphor by name (`ph:gear-six`, `ph:waveform`). A
 * package for twenty-six glyphs would add a dependency, a licence to review,
 * and a bundle, for something a `<path>` already does — and this repository
 * ships no icon dependency by choice. So each glyph is drawn here on the same
 * 24-unit grid at the same stroke weight, under the design's own names, so the
 * two can be read side by side.
 *
 * These are approximations of Phosphor's shapes, not copies of its path data.
 * At 13 to 15 pixels what carries is the silhouette, and every icon in the
 * design is paired with a label or an `aria-label` — none of them is the only
 * thing saying what a control does.
 */

export type IconName =
  | 'archive'
  | 'arrow-counter-clockwise'
  | 'arrow-up-bold'
  | 'books'
  | 'brain'
  | 'caret-down'
  | 'caret-up'
  | 'caret-up-down'
  | 'cat'
  | 'check-circle-fill'
  | 'copy'
  | 'envelope'
  | 'file-text'
  | 'flask'
  | 'folder-open'
  | 'gear-six'
  | 'git-branch'
  | 'globe'
  | 'hand'
  | 'heartbeat'
  | 'info'
  | 'magnifying-glass'
  | 'microphone'
  | 'paint-brush'
  | 'paper-plane-tilt'
  | 'pencil-simple'
  | 'plus'
  | 'sidebar-simple'
  | 'sliders-horizontal'
  | 'sparkle'
  | 'squares-four'
  | 'terminal-window'
  | 'warning-circle-fill'
  | 'waveform'
  | 'x';

/**
 * Glyphs drawn with a fill rather than a stroke.
 *
 * Phosphor's `-fill` weight is a solid shape with the detail knocked out of
 * it, which is why the check and the warning below use `evenodd`: the mark is
 * a hole in the disc, so it takes the colour of whatever sits behind it.
 */
const FILLED = new Set<IconName>(['arrow-up-bold', 'check-circle-fill', 'warning-circle-fill']);

const GLYPHS: Record<IconName, ReactNode> = {
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
      <path d="M5 8.5v10.3a1.2 1.2 0 0 0 1.2 1.2h11.6a1.2 1.2 0 0 0 1.2-1.2V8.5" />
      <path d="M9.6 12.4h4.8" />
    </>
  ),
  'arrow-counter-clockwise': (
    <>
      <path d="M4.2 5.2v5h5" />
      <path d="M4.6 10.2a7.8 7.8 0 1 1-.4 3.6" />
    </>
  ),
  'arrow-up-bold': <path d="M12 3.6 20 11.4h-4.4v9H8.4v-9H4z" />,
  books: (
    <>
      <rect x="3.2" y="4.6" width="4" height="14.8" rx="1" />
      <rect x="8.4" y="4.6" width="4" height="14.8" rx="1" />
      <path d="m15 5.6 3.9 1-3.1 12.6-3.9-1z" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5.4a3 3 0 0 0-5.6-1.5A2.9 2.9 0 0 0 4 9.2a3 3 0 0 0 .7 4.5A3 3 0 0 0 7.6 19 3 3 0 0 0 12 18z" />
      <path d="M12 5.4a3 3 0 0 1 5.6-1.5A2.9 2.9 0 0 1 20 9.2a3 3 0 0 1-.7 4.5A3 3 0 0 1 16.4 19 3 3 0 0 1 12 18z" />
      <path d="M12 5.4V18" />
    </>
  ),
  'caret-down': <path d="m6.4 9.4 5.6 5.4 5.6-5.4" />,
  'caret-up': <path d="m6.4 14.6 5.6-5.4 5.6 5.4" />,
  'caret-up-down': (
    <>
      <path d="m8 10.2 4-3.8 4 3.8" />
      <path d="m8 13.8 4 3.8 4-3.8" />
    </>
  ),
  cat: (
    <>
      <path d="M6.9 10.1 5.3 4.4l4.6 2.7" />
      <path d="m17.1 10.1 1.6-5.7-4.6 2.7" />
      <path d="M12 6.6c3.5 0 6.4 3.1 6.4 7s-2.9 6.9-6.4 6.9-6.4-3-6.4-6.9 2.9-7 6.4-7z" />
      <path d="M3.6 14.2H6" />
      <path d="M18 14.2h2.4" />
      <path d="M9.7 12.9v.6" />
      <path d="M14.3 12.9v.6" />
    </>
  ),
  'check-circle-fill': (
    <path
      fillRule="evenodd"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5.1 7.3-6.2 6.6-3.6-3.5 1.4-1.5 2.1 2.1 4.8-5.1z"
    />
  ),
  copy: (
    <>
      <rect x="8.2" y="8.2" width="11.3" height="11.3" rx="2" />
      <path d="M15.8 8.2V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.9a1.7 1.7 0 0 0 1.7 1.7h2" />
    </>
  ),
  envelope: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.6 6.4 8.4 6.4 8.4-6.4" />
    </>
  ),
  'file-text': (
    <>
      <path d="M13.8 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.2z" />
      <path d="M13.8 3v5.2H19" />
      <path d="M8.8 13.2h6.4" />
      <path d="M8.8 16.8h6.4" />
    </>
  ),
  flask: (
    <>
      <path d="M9.4 3.2v6.1L4.6 17.6A2 2 0 0 0 6.3 20.8h11.4a2 2 0 0 0 1.7-3.2l-4.8-8.3V3.2" />
      <path d="M8.2 3.2h7.6" />
      <path d="M7.1 14.2h9.8" />
    </>
  ),
  'folder-open': (
    <>
      <path d="M3.2 18.6V6.2a1.2 1.2 0 0 1 1.2-1.2h4.6l2.2 2.6h7.2a1.2 1.2 0 0 1 1.2 1.2v2.3" />
      <path d="M3.2 18.6 5.9 11a1.2 1.2 0 0 1 1.1-.8h13.8l-2.7 7.6a1.2 1.2 0 0 1-1.1.8z" />
    </>
  ),
  'gear-six': (
    <>
      <path d="m12 2.7 2.3 1.9 3-.4 1 2.8 2.7 1.3-.7 2.9.7 2.9-2.7 1.3-1 2.8-3-.4-2.3 1.9-2.3-1.9-3 .4-1-2.8-2.7-1.3.7-2.9-.7-2.9 2.7-1.3 1-2.8 3 .4z" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  'git-branch': (
    <>
      <circle cx="7" cy="5.6" r="2.3" />
      <circle cx="7" cy="18.4" r="2.3" />
      <circle cx="17" cy="8.6" r="2.3" />
      <path d="M7 7.9v8.2" />
      <path d="M17 10.9v.9a3.8 3.8 0 0 1-3.8 3.8H9.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.7 2.7 4.1 5.7 4.1 9s-1.4 6.3-4.1 9c-2.7-2.7-4.1-5.7-4.1-9s1.4-6.3 4.1-9z" />
    </>
  ),
  hand: (
    <>
      <path d="M8.9 11.6V5.9a1.6 1.6 0 0 1 3.1 0v5" />
      <path d="M12 10.6V4.5a1.6 1.6 0 0 1 3.1 0v6.1" />
      <path d="M15.1 11.2V6.8a1.6 1.6 0 0 1 3.1 0v7.9a6.2 6.2 0 0 1-6.2 6.2h-.9a5.3 5.3 0 0 1-4.5-2.6l-2.3-3.9a1.5 1.5 0 0 1 2.5-1.7l1.6 2.3" />
      <path d="M8.9 11.6v3.4" />
    </>
  ),
  heartbeat: (
    <>
      <path d="M12 20.6S3.4 15.3 3.4 9.8a4.4 4.4 0 0 1 8.6-1.5 4.4 4.4 0 0 1 8.6 1.5c0 5.5-8.6 10.8-8.6 10.8z" />
      <path d="M3.6 11.9H7l1.8-3.2 2.9 6.4 2-3.2h6.7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11.4v5.2" />
      <path d="M12 7.8v.6" />
    </>
  ),
  'magnifying-glass': (
    <>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4.7 4.7" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="2.8" width="6" height="11.4" rx="3" />
      <path d="M5.4 11.6a6.6 6.6 0 0 0 13.2 0" />
      <path d="M12 18.2v3" />
    </>
  ),
  'paint-brush': (
    <>
      <path d="M20.2 3.8a2.5 2.5 0 0 0-3.5 0L9.4 11l3.6 3.6 7.2-7.3a2.5 2.5 0 0 0 0-3.5z" />
      <path d="m9.4 11-1.7 1.7a3 3 0 0 0-.4 3.7c.5.8.4 1.9-.3 2.5-1.2 1.2-3.2.4-3.3-1.3 0-1 .6-1.5 1.2-2.1a3 3 0 0 0 .5-3.4" />
    </>
  ),
  'paper-plane-tilt': (
    <>
      <path d="M20.6 3.4 3.9 9.1a.6.6 0 0 0-.1 1.1l6.7 3.3 3.3 6.7a.6.6 0 0 0 1.1-.1z" />
      <path d="M20.6 3.4 10.5 13.5" />
    </>
  ),
  'pencil-simple': (
    <>
      <path d="M5 19h3.6L20 7.6a2.1 2.1 0 0 0-3-3L5.6 16z" />
      <path d="m15.5 6.1 3 3" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.2v13.6" />
      <path d="M5.2 12h13.6" />
    </>
  ),
  'sidebar-simple': (
    <>
      <rect x="3" y="4.4" width="18" height="15.2" rx="2.2" />
      <path d="M9.6 4.4v15.2" />
    </>
  ),
  'sliders-horizontal': (
    <>
      <path d="M3.6 8.4h9.2" />
      <path d="M17.2 8.4h3.2" />
      <path d="M3.6 15.6h3.2" />
      <path d="M11.2 15.6h9.2" />
      <circle cx="15" cy="8.4" r="2.2" />
      <circle cx="9" cy="15.6" r="2.2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.4c.9 4.1 1.6 4.8 5.7 5.7-4.1.9-4.8 1.6-5.7 5.7-.9-4.1-1.6-4.8-5.7-5.7 4.1-.9 4.8-1.6 5.7-5.7z" />
      <path d="M18.4 15.2c.5 2.1.8 2.4 2.9 2.9-2.1.5-2.4.8-2.9 2.9-.5-2.1-.8-2.4-2.9-2.9 2.1-.5 2.4-.8 2.9-2.9z" />
    </>
  ),
  'squares-four': (
    <>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="1.6" />
    </>
  ),
  'terminal-window': (
    <>
      <rect x="3" y="4.4" width="18" height="15.2" rx="2.2" />
      <path d="m7.4 10.2 2.9 2.4-2.9 2.4" />
      <path d="M13 15h3.8" />
    </>
  ),
  'warning-circle-fill': (
    <path
      fillRule="evenodd"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.1 4.8h2.2v7.1h-2.2zm0 8.8h2.2v2.3h-2.2z"
    />
  ),
  waveform: (
    <>
      <path d="M3.8 10v4" />
      <path d="M8 6.4v11.2" />
      <path d="M12 8.6v6.8" />
      <path d="M16 4.4v15.2" />
      <path d="M20.2 10.4v3.2" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

type IconProps = Readonly<{
  name: IconName;
  /** Rendered edge length in pixels, matching the design's per-use sizes. */
  size: number;
}>;

/**
 * Always decorative.
 *
 * Every control carrying an icon in this surface also carries text or an
 * `aria-label`, so the glyph is `aria-hidden` and announces nothing twice.
 */
export function Icon({ name, size }: IconProps) {
  const filled = FILLED.has(name);

  return (
    <svg
      className="mm-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
