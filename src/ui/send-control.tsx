import { Icon } from '../design/minimal-icons';
import { Button } from './button';
import { type CompletionCommand, CompletionPalette } from './completion-palette';
import { cn, type Density } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/send-control.tsx`).
 *
 * Submit or stop a run without changing footprint: a presence-coloured split
 * button while ready (Send, plus a caret for options), a destructive Stop
 * while a run is in flight. Counts as the surface's one filled action.
 *
 * The options caret opens the completion palette when `options` are given;
 * upstream leaves the caret to the consumer. Without options or a handler there
 * is nothing behind it, so it is not drawn.
 *
 * Two adaptations for a compact toolbar: `iconOnly` draws Send as its arrow,
 * keeping the name "Send", and `stopShortcut` puts the key that stops a run on
 * the Stop control ("esc · stop") once the host has wired that key.
 */
export type StopShortcut = Readonly<{
  /** The `aria-keyshortcuts` value, e.g. `Escape`. */
  keys: string;
  /** The key as the control shows it, e.g. `esc`. */
  label: string;
}>;

export type SendControlProps = Readonly<{
  running?: boolean | undefined;
  disabled?: boolean | undefined;
  density?: Density | undefined;
  onSend?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onOpenOptions?: (() => void) | undefined;
  options?: readonly CompletionCommand[] | undefined;
  onSelectOption?: ((command: CompletionCommand) => void) | undefined;
  iconOnly?: boolean | undefined;
  stopShortcut?: StopShortcut | undefined;
  className?: string | undefined;
}>;

export function SendControl({
  running = false,
  disabled = false,
  density = 'default',
  onSend,
  onStop,
  onOpenOptions,
  options,
  onSelectOption,
  iconOnly = false,
  stopShortcut,
  className,
}: SendControlProps) {
  if (running) {
    return (
      <Button
        type="button"
        variant="destructive"
        density={density}
        disabled={disabled}
        onClick={onStop}
        className={cn('oc-send-stop', className)}
        data-shortcut={stopShortcut ? '' : undefined}
        // The visible "esc ·" is the key, said again by aria-keyshortcuts;
        // the name stays the action.
        {...(stopShortcut
          ? {
              'aria-label': 'Stop run',
              'aria-keyshortcuts': stopShortcut.keys,
              title: `Stop run (${stopShortcut.label})`,
            }
          : {})}
      >
        {stopShortcut ? (
          <>
            <span className="oc-send-stop-key" aria-hidden="true">
              {stopShortcut.label} ·
            </span>{' '}
            stop
          </>
        ) : (
          <>
            <Icon name="stop-circle" size={14} />
            Stop run
          </>
        )}
      </Button>
    );
  }

  // The caret opens the command list, which is useful before there is a
  // draft, so it stays enabled while Send waits for one.
  const hasPalette = Boolean(options && options.length > 0 && onSelectOption);
  const hasOptions = hasPalette || Boolean(onOpenOptions);
  const caret = (
    <Button
      type="button"
      variant="presence"
      density={density}
      size="icon"
      aria-label="Send options"
      onClick={onOpenOptions}
      className="oc-send-options"
    >
      <Icon name="caret-down" size={13} />
    </Button>
  );

  return (
    <div
      data-slot="send-control"
      data-options={hasOptions ? '' : undefined}
      className={cn('oc-send', className)}
    >
      <Button
        type="button"
        variant="presence"
        density={density}
        size={iconOnly ? 'icon' : 'default'}
        disabled={disabled}
        onClick={onSend}
        className="oc-send-main"
        title="Send  ⏎ · newline  ⇧⏎"
        {...(iconOnly ? { 'aria-label': 'Send' } : {})}
      >
        {iconOnly ? null : 'Send'}
        <Icon name="arrow-up" size={iconOnly ? 15 : 13} />
      </Button>
      {hasPalette && options && onSelectOption ? (
        <CompletionPalette trigger={caret} commands={options} onSelect={onSelectOption} />
      ) : hasOptions ? (
        caret
      ) : null}
    </div>
  );
}
