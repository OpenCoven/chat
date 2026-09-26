import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { createContext, type RefObject, useContext } from 'react';

import { withClass } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/ui/dropdown-menu.tsx`).
 *
 * Thin Base UI wrappers. Base UI owns focus, arrow keys, typeahead, Escape,
 * and collision-aware positioning; this file only names the parts.
 */
export function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/**
 * Where menus render. A host shell provides itself, so a menu inherits the
 * shell's tokens (its light or dark palette) instead of rendering in the
 * document body, outside them. Absent, menus render in the body as before.
 */
export const MenuPortalContainer = createContext<RefObject<HTMLElement | null> | null>(null);

export function DropdownMenuContent({
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal container={useContext(MenuPortalContainer) ?? undefined}>
      <MenuPrimitive.Positioner
        className="oc-menu-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={withClass('oc-menu', className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** Base UI requires a label to sit inside a group; the palette uses one group. */
export function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={withClass('oc-menu-label', className)}
      {...props}
    />
  );
}

export function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={withClass('oc-menu-item', className)}
      {...props}
    />
  );
}
