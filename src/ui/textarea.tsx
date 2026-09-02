import type { ComponentProps } from 'react';

import { cn, type Density } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/ui/textarea.tsx`), plus the one
 * behaviour a chat composer cannot do without and the library leaves to the
 * consumer: growing with its draft.
 *
 * Growth is derived from the value rather than measured, so it is the same in
 * a test as on screen: one row per line, one more once a line is long enough
 * to wrap, clamped to `minRows..maxRows`.
 */
export type TextareaProps = ComponentProps<'textarea'> &
  Readonly<{
    density?: Density;
    /** Grow with the draft between `minRows` and `maxRows`. */
    autoGrow?: boolean;
    minRows?: number;
    maxRows?: number;
  }>;

const WRAP_THRESHOLD = 90;

export function rowsFor(value: string, minRows: number, maxRows: number): number {
  const lines = value.split('\n').length + (value.length > WRAP_THRESHOLD ? 1 : 0);

  return Math.min(maxRows, Math.max(minRows, lines));
}

export function Textarea({
  className,
  density = 'default',
  autoGrow = true,
  minRows = 2,
  maxRows = 8,
  rows,
  value,
  ...props
}: TextareaProps) {
  const grown = autoGrow && typeof value === 'string' ? rowsFor(value, minRows, maxRows) : rows;

  return (
    <textarea
      data-slot="textarea"
      data-density={density}
      className={cn('oc-textarea', className)}
      rows={grown}
      value={value}
      {...props}
    />
  );
}
