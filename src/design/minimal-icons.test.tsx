import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Icon, type IconName } from './minimal-icons';

/**
 * The glyphs the Familiars Redesign v2 surface added to the shared set.
 *
 * Each is drawn by hand, so the check is that every name resolves to a
 * decorative SVG with some geometry in it; a typo in the union would fail
 * the typecheck, an empty glyph would fail here.
 */
const ADDED: readonly IconName[] = [
  'arrow-clockwise',
  'caret-right',
  'chats-circle',
  'check',
  'clock-counter-clockwise',
  'dots-three',
  'hourglass',
  'image',
  'list-checks',
  'paper-plane-right',
  'paperclip',
  'seal-check',
  'timer',
  'wrench',
];

describe('Icon', () => {
  it.each(ADDED)('draws %s as a hidden SVG with geometry', (name) => {
    const { container } = render(<Icon name={name} size={14} />);
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '14');
    expect(svg?.querySelectorAll('path, circle, rect').length).toBeGreaterThan(0);
  });
});
