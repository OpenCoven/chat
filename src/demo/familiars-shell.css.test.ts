import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatio, type HexColor } from '../lib/contrast';

/**
 * Guards for the Familiars Redesign v2 palette.
 *
 * The design declares its colours on the shell root rather than on :root,
 * so the check reads that block. Same shape as styles.test.ts: the claims
 * the design makes about legibility are checkable, so they are checked.
 */

const stylesheet = readFileSync(resolve(process.cwd(), 'src/demo/familiars-shell.css'), 'utf8');

function tokens(): Map<string, string> {
  const root = stylesheet.match(/\.fr-shell\s*\{([\s\S]*?)\n\}/);
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

function hex(name: string): HexColor {
  const value = tokens().get(name);

  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} is not a hex token: ${value ?? 'missing'}`);
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
          !selector.startsWith('.rc-') &&
          !selector.startsWith('from') &&
          !selector.startsWith('to') &&
          !/^\d+%/.test(selector),
      );

    expect(unscoped).toEqual([]);
  });

  it('keeps body and secondary text readable on every surface', () => {
    for (const surface of SURFACES) {
      expect(contrastRatio(hex('--text-primary'), hex(surface))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
      expect(contrastRatio(hex('--text-secondary'), hex(surface))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it('keeps muted text at least large-text legible', () => {
    // Muted text is timestamps, hints, and labels that sit beside a stronger
    // line; the design accepts large-text contrast for it, never less.
    for (const surface of SURFACES) {
      expect(contrastRatio(hex('--text-muted'), hex(surface))).toBeGreaterThanOrEqual(
        AA_LARGE_TEXT,
      );
    }
  });

  it('bundles the design faces rather than pretending to', () => {
    expect(tokens().get('--font-inter')).toMatch(/^"Inter Variable"/);
    expect(tokens().get('--font-jetbrains-mono')).toMatch(/^"JetBrains Mono Variable"/);
  });
});
