import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { type Density, withClass } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/ui/button.tsx`).
 *
 * Same variants, densities, sizes, and `data-*` hooks as upstream; the styles
 * live in ui.css against this app's tokens instead of Tailwind classes.
 */
export type ButtonVariant =
  | 'primary'
  | 'presence'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'link';

export type ButtonProps = ButtonPrimitive.Props &
  Readonly<{
    variant?: ButtonVariant;
    density?: Density;
    size?: 'default' | 'icon';
  }>;

export function Button({
  className,
  variant = 'outline',
  density = 'default',
  size = 'default',
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-density={density}
      data-size={size}
      className={withClass('oc-button', className)}
      {...props}
    />
  );
}
