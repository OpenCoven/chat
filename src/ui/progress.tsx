import { cn } from './utils';

/** Vendored from OpenCoven/ui (`components/ui/progress.tsx`). */
export type ProgressProps = Readonly<{
  value: number;
  max?: number;
  /** Required: a bar with no name is a decoration, not a status. */
  label: string;
  className?: string;
}>;

export function Progress({ value, max = 100, label, className }: ProgressProps) {
  const bounded = Math.min(Math.max(value, 0), max);
  const percentage = max > 0 ? (bounded / max) * 100 : 0;

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={bounded}
      className={cn('oc-progress', className)}
    >
      <span
        data-slot="progress-indicator"
        className="oc-progress-indicator"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}
