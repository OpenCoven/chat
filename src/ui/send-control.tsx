import { Icon } from '../demo/minimal-icons';
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
 * upstream leaves the caret to the consumer.
 */
export type SendControlProps = Readonly<{
  running?: boolean | undefined;
  disabled?: boolean | undefined;
  density?: Density | undefined;
  onSend?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onOpenOptions?: (() => void) | undefined;
  options?: readonly CompletionCommand[] | undefined;
  onSelectOption?: ((command: CompletionCommand) => void) | undefined;
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
      >
        <Icon name="stop-circle" size={14} />
        Stop run
      </Button>
    );
  }

  // The caret opens the command list, which is useful before there is a
  // draft, so it follows `disabled` only when there is nothing to open.
  const hasOptions =
    Boolean(options && options.length > 0 && onSelectOption) || Boolean(onOpenOptions);
  const caret = (
    <Button
      type="button"
      variant="presence"
      density={density}
      size="icon"
      disabled={hasOptions ? false : disabled}
      aria-label="Send options"
      onClick={onOpenOptions}
      className="oc-send-options"
    >
      <Icon name="caret-down" size={13} />
    </Button>
  );

  return (
    <div data-slot="send-control" className={cn('oc-send', className)}>
      <Button
        type="button"
        variant="presence"
        density={density}
        disabled={disabled}
        onClick={onSend}
        className="oc-send-main"
        title="Send  ⏎ · newline  ⇧⏎"
      >
        Send
        <Icon name="arrow-up-bold" size={13} />
      </Button>
      {options && options.length > 0 && onSelectOption ? (
        <CompletionPalette trigger={caret} commands={options} onSelect={onSelectOption} />
      ) : (
        caret
      )}
    </div>
  );
}
