/**
 * OpenCoven/ui, vendored.
 *
 * These files keep the upstream library's file names, props, `data-slot`
 * hooks, and behaviour (`packages/ui/src` in OpenCoven/ui), and replace its
 * Tailwind class strings with plain CSS in ui.css on this app's tokens. The
 * upstream package is Tailwind-only and unpublished; vendoring its source is
 * the registry's own intended path, and keeps the two readable side by side.
 */
export { AttachmentChip, type AttachmentChipProps, type AttachmentState } from './attachment-chip';
export { Button, type ButtonProps, type ButtonVariant } from './button';
export {
  type CompletionCommand,
  CompletionPalette,
  type CompletionPaletteProps,
} from './completion-palette';
export {
  Composer,
  type ComposerAttachment,
  type ComposerProps,
  type ComposerWarning,
} from './composer';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './dropdown-menu';
export { Progress, type ProgressProps } from './progress';
export { SendControl, type SendControlProps } from './send-control';
export { rowsFor, Textarea, type TextareaProps } from './textarea';
export { cn, type Density } from './utils';
