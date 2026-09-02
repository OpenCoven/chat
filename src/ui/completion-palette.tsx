import type { ReactElement } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { cn } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/completion-palette.tsx`).
 *
 * A trigger-opened menu of commands: label, one-line consequence, optional
 * shortcut. The inline `/`-typed menu in the composer is a different, keyboard
 * first path; this is the pointer path to the same commands.
 */
export type CompletionCommand = Readonly<{
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  disabled?: boolean;
  /** Short trailing note, e.g. the approval tier a command falls under. */
  meta?: string;
  metaTone?: 'default' | 'warning';
}>;

export type CompletionPaletteProps = Readonly<{
  trigger: ReactElement;
  commands: readonly CompletionCommand[];
  onSelect: (command: CompletionCommand) => void;
  label?: string;
}>;

export function CompletionPalette({
  trigger,
  commands,
  onSelect,
  label = 'Slash commands',
}: CompletionPaletteProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent side="top" align="end" className="oc-palette">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {commands.map((command) => (
            <DropdownMenuItem
              key={command.id}
              disabled={command.disabled}
              onClick={() => onSelect(command)}
            >
              <span className="oc-palette-label">{command.label}</span>
              <span className="oc-palette-description">{command.description}</span>
              {command.meta ? (
                <span
                  className={cn(
                    'oc-palette-meta',
                    command.metaTone === 'warning' && 'oc-palette-meta--warning',
                  )}
                >
                  {command.meta}
                </span>
              ) : command.shortcut ? (
                <kbd className="oc-kbd">{command.shortcut}</kbd>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
