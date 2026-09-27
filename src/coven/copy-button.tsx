import { useEffect, useState } from 'react';
import { cx } from '../design/familiars-ui';
import { Icon } from '../design/minimal-icons';
import { copyText } from './copy-text';

type CopyState = 'idle' | 'copied' | 'failed';
/** How long the outcome stays on the button before it reads "Copy" again. */
const SETTLE_MS = 2000;

/**
 * A small copy control whose label reports what actually happened: "Copied"
 * only after the clipboard accepted the text, "Copy failed" when it did not.
 * The accessible name stays fixed so the control is findable by its purpose;
 * the outcome is announced through the live label.
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={cx('coven-copy', className)}
      data-state={state}
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'));
      }}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={12} />
      <span className="coven-copy-text" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </span>
    </button>
  );
}
