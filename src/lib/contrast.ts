/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Exists so the palette's accessibility is a computed fact rather than a
 * designer's recollection. The approved visual direction puts "accessible
 * contrast" among the things that take priority over atmosphere, and this is
 * what lets a test hold that line as the palette changes.
 */

/** An sRGB colour, as `#rgb` or `#rrggbb`. */
export type HexColor = `#${string}`;

/** Parse a hex colour into 0-255 channels. Throws on anything else. */
export function parseHex(color: HexColor): [number, number, number] {
  const body = color.replace('#', '');
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : body;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    throw new Error(`not a hex colour: ${color}`);
  }

  // slice rather than match, so the tuple is genuinely three numbers under
  // noUncheckedIndexedAccess rather than three possibly-undefined ones.
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

/** One channel, linearized. */
function linearize(channel: number): number {
  const normalized = channel / 255;

  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, per WCAG 2.1. */
export function relativeLuminance(color: HexColor): number {
  const [red, green, blue] = parseHex(color);

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

/**
 * Contrast ratio between two colours, from 1 to 21.
 *
 * Order-independent: the brighter colour is always the numerator, so a caller
 * cannot get a different answer by passing foreground and background the other
 * way round.
 */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** WCAG AA for normal-size body text. */
export const AA_NORMAL_TEXT = 4.5;

/** WCAG AA for text at 18.66px bold or 24px regular and above. */
export const AA_LARGE_TEXT = 3;
