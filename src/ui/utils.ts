/**
 * Vendored from OpenCoven/ui (`packages/ui/src/lib/utils.ts`).
 *
 * The library's `cn` merges Tailwind classes; this app has no Tailwind, so the
 * same name joins plain class names and drops the falsy ones. Kept as `cn` so
 * vendored components read the same as their upstream source.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...inputs: readonly ClassValue[]): string {
  return inputs.filter(Boolean).join(' ');
}

export type Density = 'default' | 'compact';

/**
 * Base UI parts accept `className` as a string or as a function of their
 * state. Merge a base class with either without losing the state-aware form.
 */
export function withClass<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
): string | ((state: State) => string) {
  if (typeof className === 'function') {
    return (state: State) => cn(base, className(state));
  }

  return cn(base, className);
}
