import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AA_NORMAL_TEXT, contrastRatio, type HexColor, parseHex } from './lib/contrast';

/**
 * Guards for the visual foundation.
 *
 * The approved direction in docs/superpowers/specs/2026-08-10-opencoven-chat-design.md
 * is a set of claims about how this app looks and behaves. Each one below is
 * checkable, so each one is checked. A direction nothing enforces is a
 * direction the fifth component quietly stops following.
 */

const stylesheet = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/**
 * The stylesheet with comments removed.
 *
 * Selector and colour checks must look at CSS, not at prose about CSS. A
 * comment explaining why a rule avoids `:focus` should not read as a rule
 * using it.
 */
const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

/** Token values declared on :root. */
function tokens(): Map<string, string> {
  const root = stylesheet.match(/:root\s*\{([\s\S]*?)\n\}/);
  const declarations = root?.[1] ?? '';
  const found = new Map<string, string>();

  for (const match of declarations.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;

    if (name !== undefined && value !== undefined) {
      found.set(name, value.trim());
    }
  }

  return found;
}

function token(name: string): HexColor {
  const value = tokens().get(name);

  if (value === undefined) {
    throw new Error(`missing token ${name}`);
  }

  return value as HexColor;
}

describe('visual foundation', () => {
  it('declares the surface, text, and accent tokens the direction calls for', () => {
    const declared = tokens();

    for (const name of [
      '--surface-void',
      '--surface-base',
      '--surface-raised',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--accent-cyan',
      '--accent-violet',
    ]) {
      expect(declared.has(name), `missing ${name}`).toBe(true);
    }
  });

  it('meets WCAG AA for every text colour on every surface', () => {
    const surfaces = ['--surface-void', '--surface-base', '--surface-raised'];
    const foregrounds = [
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--accent-cyan',
      '--accent-violet',
    ];

    const failures: string[] = [];

    for (const surface of surfaces) {
      for (const foreground of foregrounds) {
        const ratio = contrastRatio(token(foreground), token(surface));

        if (ratio < AA_NORMAL_TEXT) {
          failures.push(`${foreground} on ${surface} = ${ratio.toFixed(2)}`);
        }
      }
    }

    expect(failures, `below ${AA_NORMAL_TEXT}:1`).toEqual([]);
  });

  it('keeps surfaces near black rather than merely dark', () => {
    // "Near-black ritual-tech surfaces" is a specific claim, and a surface
    // that drifts up into mid-grey stops being it.
    for (const surface of ['--surface-void', '--surface-base', '--surface-raised']) {
      const ratio = contrastRatio(token(surface), '#ffffff');

      expect(ratio, `${surface} is too light`).toBeGreaterThan(15);
    }
  });

  it('uses cyan for the focus accent', () => {
    const focus = stylesheet.match(/:focus-visible\s*\{([\s\S]*?)\}/);

    expect(focus?.[1]).toContain('var(--accent-cyan)');
    expect(focus?.[1]).toContain('outline-offset');
  });

  it('scopes focus rings to keyboard interaction', () => {
    // A bare :focus rule puts a ring on every mouse click, which is why people
    // remove focus styling entirely and lose it for keyboard users too.
    const bareFocus = css.match(/(?<![-\w]):focus(?![-\w(])/g);

    expect(bareFocus, 'use :focus-visible').toBeNull();
  });

  it('uses violet for selection', () => {
    const selection = stylesheet.match(/::selection\s*\{([\s\S]*?)\}/);

    expect(selection?.[1]).toBeDefined();
    expect(selection?.[1]).toMatch(/147,\s*134,\s*208|var\(--accent-violet/);
  });

  it('removes nonessential motion under prefers-reduced-motion', () => {
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');

    const animations = stylesheet.match(/^\s*animation:/gm) ?? [];
    const reducedMotion = stylesheet.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    );

    // Every animation the app has must be covered by the reduce block, and the
    // block covers everything by selector rather than by name.
    expect(animations.length, 'an animation exists but nothing reduces it').toBeGreaterThan(0);
    expect(reducedMotion?.[1]).toContain('animation-duration: 0.01ms !important');
  });

  it('honours an increased-contrast preference', () => {
    expect(stylesheet).toContain('@media (prefers-contrast: more)');
  });

  it('avoids terminal cosplay', () => {
    // Named in the direction as things to avoid. Checking for them is cheap
    // and the failure mode is a slow drift nobody notices in review.
    expect(stylesheet).not.toMatch(/scanline|scan-line/i);
    expect(stylesheet).not.toMatch(/font-family:[^;]*monospace[^;]*;\s*\n\s*\}/);

    const bodyFont = stylesheet.match(/:root\s*\{[\s\S]*?font-family:\s*([^;]+);/);

    expect(bodyFont?.[1], 'body text must not be monospace').not.toMatch(/monospace/);
  });

  it('allows a hex literal only where it defines a token', () => {
    // Including the token overrides inside prefers-contrast, which are token
    // definitions too. Anywhere else, a colour must be a var().
    const outsideTokenDeclarations = css.replace(/--[a-z-]+:\s*[^;]+;/g, '');
    const strays = outsideTokenDeclarations.match(/#[0-9a-f]{3,8}\b/gi) ?? [];

    expect(strays, 'hex outside a token definition').toEqual([]);
  });

  it('derives every translucent colour from a palette colour', () => {
    // rgba() cannot be a var() without a colour-mix the older WebKit builds on
    // the Linux target may not have, so translucency stays literal. What must
    // not happen is a channel triple that is nearly a palette colour and not
    // quite: this catches a hand-picked violet drifting from the real one.
    const paletteTriples = new Set<string>();

    for (const match of css.matchAll(/--[a-z-]+:\s*(#[0-9a-f]{6})\s*;/gi)) {
      const value = match[1];

      if (value !== undefined) {
        paletteTriples.add(parseHex(value as HexColor).join(','));
      }
    }

    const offPalette: string[] = [];

    for (const match of css.matchAll(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) {
      const [full, red, green, blue] = match;
      const triple = [red, green, blue].map(Number).join(',');

      // Pure black shadows are not palette colours and do not need to be.
      if (triple === '3,2,5' || triple === '0,0,0') {
        continue;
      }

      if (!paletteTriples.has(triple)) {
        offPalette.push(full);
      }
    }

    expect(offPalette, 'rgba channels not matching any token').toEqual([]);
  });
});
