import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AA_NORMAL_TEXT, contrastRatio, type HexColor } from '../lib/contrast';

/**
 * Guards for the Familiars Redesign v2 palette.
 *
 * The design declares its colours on the shell root rather than on :root,
 * so the check reads that block. Same shape as styles.test.ts: the claims
 * the design makes about legibility are checkable, so they are checked.
 */

const stylesheet = readFileSync(resolve(process.cwd(), 'src/design/familiars-shell.css'), 'utf8');

type Scheme = 'dark' | 'light';

/** The shell's colour tokens: the base block (dark) or the light-scheme block. */
function tokens(scheme: Scheme = 'dark'): Map<string, string> {
  const source =
    scheme === 'dark'
      ? stylesheet
      : (stylesheet.match(/@media \(prefers-color-scheme: light\) \{([\s\S]*?)\n\}/)?.[1] ?? '');
  const root = source.match(/\.fr-shell\s*\{([\s\S]*?)\n\s*\}/);
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

function hex(name: string, scheme: Scheme = 'dark'): HexColor {
  const value = tokens(scheme).get(name);

  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} is not a ${scheme} hex token: ${value ?? 'missing'}`);
  }

  return value as HexColor;
}

const SURFACES = ['--bg-base', '--bg-panel', '--bg-raised', '--bg-elevated'] as const;

describe('familiars-shell.css', () => {
  it('scopes every rule under the shell', () => {
    const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = css.match(/^[^\s@}][^{]*(?=\{)/gm) ?? [];
    const unscoped = selectors
      .flatMap((group) => group.split(/,(?![^(]*\))/))
      .map((selector) => selector.trim())
      .filter(
        (selector) =>
          selector.length > 0 &&
          !selector.startsWith('.fr-') &&
          !selector.startsWith(':where(.fr-shell') &&
          !selector.startsWith('.rc-') &&
          !selector.startsWith('from') &&
          !selector.startsWith('to') &&
          !/^\d+%/.test(selector),
      );

    expect(unscoped).toEqual([]);
  });

  describe.each(['dark', 'light'] as const)('the %s palette', (scheme) => {
    it('keeps body and secondary text readable on every surface', () => {
      for (const surface of SURFACES) {
        for (const text of ['--text-primary', '--text-secondary'])
          expect(contrastRatio(hex(text, scheme), hex(surface, scheme))).toBeGreaterThanOrEqual(
            AA_NORMAL_TEXT,
          );
      }
    });

    it('keeps muted text readable at the small sizes it is set in', () => {
      // Muted text is timestamps, hints, and labels at 10.5-12px, so it must
      // meet the normal-text minimum, not the large-text allowance.
      for (const surface of SURFACES) {
        expect(
          contrastRatio(hex('--text-muted', scheme), hex(surface, scheme)),
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    });

    it('keeps the accent readable as text and under its own foreground', () => {
      for (const surface of SURFACES) {
        expect(
          contrastRatio(hex('--accent-presence', scheme), hex(surface, scheme)),
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
      expect(
        contrastRatio(
          hex('--accent-presence-foreground', scheme),
          hex('--accent-presence', scheme),
        ),
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  });

  it('gives the light scheme every colour the dark scheme has', () => {
    const colour = (name: string) => /^--(bg|text|border|accent|ring-focus|color)/.test(name);
    const dark = [...tokens('dark').keys()].filter(colour).sort();
    const light = [...tokens('light').keys()].filter(colour).sort();
    expect(light).toEqual(dark);
  });

  it('bundles the design faces rather than pretending to', () => {
    expect(tokens().get('--font-inter')).toMatch(/^"Inter Variable"/);
    expect(tokens().get('--font-jetbrains-mono')).toMatch(/^"JetBrains Mono Variable"/);
  });
});

describe('control resets', () => {
  it('carry no class weight, so component button styles win over them', () => {
    // `.fr-shell button` outranked every single-class rule such as
    // `.fr-btn` or `.coven-copy`, so buttons took their surroundings' size
    // and colour. The resets must stay inside :where().
    // Top-level rules only; the reduced-motion block inside @media is not a reset.
    expect(stylesheet).not.toMatch(/^\.fr-shell (button|input|textarea)\b/m);
    expect(stylesheet).not.toMatch(/^:where\(\.fr-shell\) (button|input|textarea)\b/m);
    expect(stylesheet).toMatch(/^:where\(\.fr-shell button\) \{\n {2}color: inherit;/m);
  });
});
