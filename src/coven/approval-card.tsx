import { useId } from 'react';
import type { CovenApproval } from '../lib/coven-runtime';

/**
 * A familiar's request for write access, docked above the composer so the reply
 * that led to it stays readable. The words are the familiar's and render only
 * as plain text. What Allow does is Chat's own sentence, because no summary can
 * narrow it.
 */
export function ApprovalCard({
  approval,
  name,
  allowDisabled,
  allowHint,
  answering,
  onAllow,
  onDecline,
}: {
  approval: CovenApproval;
  name: string;
  allowDisabled: boolean;
  /** Says why Allow is unavailable, while it is. */
  allowHint?: string | undefined;
  answering: boolean;
  onAllow: () => void;
  onDecline: () => void;
}) {
  const headingId = useId();
  const hintId = useId();
  return (
    <section className="coven-approval" aria-labelledby={headingId} aria-live="polite">
      <h2 className="coven-approval-heading" id={headingId}>
        {name} asks for permission
      </h2>
      <p className="coven-approval-summary">{approval.summary}</p>
      {approval.reason ? <p className="coven-approval-reason">{approval.reason}</p> : null}
      {approval.writableRoots?.length ? (
        <>
          <p className="coven-approval-scope">
            Allow once lets {name} write to these extra folders for the next reply. Settings ›
            Access logs your answer.
          </p>
          <ul>
            {approval.writableRoots.map((root) => (
              <li key={root}>
                <bdi>{root}</bdi>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="coven-approval-scope">
          This request does not name folders. Ask {name} to request them again.
        </p>
      )}
      {allowHint ? (
        <p className="coven-approval-hint" id={hintId}>
          {allowHint}
        </p>
      ) : null}
      <div className="coven-approval-actions">
        <button
          type="button"
          className="fr-btn fr-btn--primary"
          disabled={allowDisabled || answering || !approval.writableRoots?.length}
          aria-describedby={allowHint ? hintId : undefined}
          onClick={onAllow}
        >
          Allow once
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--secondary"
          disabled={answering}
          onClick={onDecline}
        >
          Decline
        </button>
      </div>
    </section>
  );
}
