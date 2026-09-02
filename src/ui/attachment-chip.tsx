import { Icon } from '../demo/minimal-icons';
import { Button } from './button';
import { Progress } from './progress';
import { cn } from './utils';

/**
 * Vendored from OpenCoven/ui (`components/attachment-chip.tsx`).
 *
 * One attached file in one of three states. State is carried by an icon, the
 * meta line, and a dashed or warning border — never by colour alone. A failed
 * upload puts its reason in the meta slot; the chip does not expand into a
 * preview.
 */
export type AttachmentState = 'ready' | 'uploading' | 'failed';

export type AttachmentChipProps = Readonly<{
  name: string;
  meta?: string | undefined;
  state?: AttachmentState | undefined;
  /** Upload progress, 0–100, while `state` is `uploading`. */
  progress?: number | undefined;
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}>;

export function AttachmentChip({
  name,
  meta,
  state = 'ready',
  progress = 0,
  onRemove,
  className,
}: AttachmentChipProps) {
  const icon =
    state === 'uploading'
      ? 'arrow-clockwise'
      : state === 'failed'
        ? 'warning-circle-fill'
        : 'file-text';

  return (
    <span data-slot="attachment-chip" data-state={state} className={cn('oc-attachment', className)}>
      <span className="oc-attachment-icon" aria-hidden="true">
        <Icon name={icon} size={13} />
      </span>
      <span className="oc-attachment-copy">
        <span className="oc-attachment-name">{name}</span>
        {state === 'uploading' ? (
          <Progress
            value={progress}
            label={`Uploading ${name}`}
            className="oc-attachment-progress"
          />
        ) : (
          <span className="oc-attachment-meta">{meta}</span>
        )}
      </span>
      {state !== 'uploading' && onRemove ? (
        <Button
          type="button"
          variant="ghost"
          density="compact"
          size="icon"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <Icon name="x" size={12} />
        </Button>
      ) : null}
    </span>
  );
}
