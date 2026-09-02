import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import type {
  FamMessage,
  HoldMessage,
  HoldState,
  PlotPoint,
  ReasoningCardData,
  ReasoningStep,
} from './familiars-data';
import { Avatar, cx, FamButton, ThinkingIndicator } from './familiars-ui';
import { Icon } from './minimal-icons';
import type { MockFamiliar } from './mock-familiars';

/**
 * Transcript rows for the Familiars Redesign v2 surface.
 *
 * One component per message kind. Everything the design draws inline is a
 * class in familiars-shell.css; only values the prototype computes per row
 * (animation delay, plot coordinates, tones) travel as custom properties.
 */

export type MessageRowProps = Readonly<{
  message: FamMessage;
  index: number;
  familiar: MockFamiliar;
  holdState: HoldState | undefined;
  /** When the hold was decided, as the transcript shows it. */
  decidedAt: string;
  onApprove: () => void;
  onDecline: () => void;
  onOpenFamiliar: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpenImage: (index: number) => void;
}>;

function delayStyle(index: number): CSSProperties {
  return { '--fr-delay': `${Math.min(index, 8) * 45}ms` } as CSSProperties;
}

function FamiliarMark({
  familiar,
  onOpen,
}: {
  familiar: MockFamiliar;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="fr-avatar-btn"
      aria-label={`About ${familiar.name}`}
      title={`About ${familiar.name}`}
      onClick={onOpen}
    >
      <Avatar initial={familiar.name[0] ?? '?'} size={22} />
    </button>
  );
}

function FamiliarMeta({ name, time }: { name: string; time: string }) {
  return (
    <span className="fr-familiar-meta">
      <span className="fr-familiar-name">{name}</span>
      <span className="fr-tabular">{time}</span>
    </span>
  );
}

export function MessageRow(props: MessageRowProps) {
  const { message, index, familiar, onOpenFamiliar } = props;

  switch (message.kind) {
    case 'divider':
      return <div className="fr-divider">{message.text}</div>;
    case 'user':
      return (
        <div className="fr-user fr-msg" style={delayStyle(index)}>
          <span className="fr-time">{message.time}</span>
          <div className="fr-bubble fr-bubble--user">{message.text}</div>
        </div>
      );
    case 'familiar':
      return (
        <div className="fr-familiar fr-msg" style={delayStyle(index)}>
          <FamiliarMark familiar={familiar} onOpen={onOpenFamiliar} />
          <div className="fr-familiar-body">
            <FamiliarMeta name={familiar.name} time={message.time} />
            <div className="fr-bubble fr-bubble--familiar">{message.text}</div>
          </div>
        </div>
      );
    case 'reasoning':
      return (
        <div className="fr-msg" style={delayStyle(index)}>
          <ReasoningCard card={message.card} defaultOpen />
        </div>
      );
    case 'image':
      return (
        <figure className="fr-familiar fr-familiar--wide fr-msg" style={delayStyle(index)}>
          <FamiliarMark familiar={familiar} onOpen={onOpenFamiliar} />
          <div className="fr-familiar-body fr-familiar-body--image">
            <FamiliarMeta name={familiar.name} time={message.time} />
            <div className="fr-card fr-card--lift fr-image-card">
              {message.plot ? (
                <button
                  type="button"
                  className="fr-plot"
                  aria-label={`Open ${message.alt}`}
                  onClick={() => props.onOpenImage(index)}
                >
                  <EvidenceMap plot={message.plot} />
                </button>
              ) : (
                <div className="fr-image-placeholder">
                  <span className="fr-image-placeholder-copy">
                    <Icon name="image" size={20} />
                    <span className="fr-empty-text">{message.alt}</span>
                  </span>
                </div>
              )}
              <figcaption className="fr-image-caption">
                <code className="fr-file">{message.file}</code>
                <span className="fr-image-actions">
                  {message.plot ? (
                    <FamButton variant="ghost" size="xs" onClick={() => props.onOpenImage(index)}>
                      Open
                    </FamButton>
                  ) : null}
                  <FamButton variant="ghost" size="xs">
                    Save to notes/
                  </FamButton>
                </span>
              </figcaption>
            </div>
          </div>
        </figure>
      );
    case 'hold':
      return (
        <HoldCard
          message={message}
          index={index}
          familiar={familiar}
          state={props.holdState}
          decidedAt={props.decidedAt}
          onApprove={props.onApprove}
          onDecline={props.onDecline}
        />
      );
    case 'failed':
      return (
        <div role="alert" className="fr-failed">
          <span className="fr-danger-icon">
            <Icon name="warning-circle-fill" size={15} />
          </span>
          <span className="fr-failed-copy">
            <span className="fr-failed-title">Run failed</span>
            <span className="fr-failed-text">{message.text}</span>
          </span>
          <FamButton variant="ghost" size="sm">
            Retry run
          </FamButton>
        </div>
      );
    default:
      return null;
  }
}

export function ThinkingRow({ familiar }: { familiar: MockFamiliar }) {
  return (
    <div className="fr-thinking-row">
      <Avatar initial={familiar.name[0] ?? '?'} size={22} />
      <ThinkingIndicator label={`${familiar.name} is updating memory`} />
    </div>
  );
}

/* ---------------------------------------------------------------- hold */

type HoldCardProps = Readonly<{
  message: HoldMessage;
  index: number;
  familiar: MockFamiliar;
  state: HoldState | undefined;
  decidedAt: string;
  onApprove: () => void;
  onDecline: () => void;
}>;

function HoldCard({
  message,
  index,
  familiar,
  state,
  decidedAt,
  onApprove,
  onDecline,
}: HoldCardProps) {
  if (state === 'approved' || state === 'declined') {
    const approved = state === 'approved';

    return (
      <output className="fr-status-line">
        <span className={cx('fr-status-icon', !approved && 'fr-status-icon--muted')}>
          <Icon name={approved ? 'check' : 'x'} size={14} />
        </span>
        <span className="fr-status-word">{approved ? 'Approved' : 'Declined'}</span>
        <span>
          {message.title} · you, {decidedAt}
        </span>
      </output>
    );
  }

  if (state === 'expired') {
    return (
      <output className="fr-status-line fr-status-line--expired">
        <span className="fr-status-icon fr-status-icon--muted">
          <Icon name="hourglass" size={14} />
        </span>
        <span className="fr-status-word">Expired</span>
        <span>
          {message.title} · no decision in 24h · {familiar.name} released the run
        </span>
        <span className="fr-spacer" />
        <FamButton variant="ghost" size="xs">
          Ask again
        </FamButton>
      </output>
    );
  }

  return (
    <section
      id="fr-hold"
      className="fr-msg fr-hold"
      aria-label="Held action"
      style={delayStyle(index)}
    >
      <div className="fr-hold-head">
        <span className="fr-hold-icon">
          <Icon name="hand" size={15} />
        </span>
        <div className="fr-hold-copy">
          <span className="fr-hold-title">{message.title}</span>
          <span className="fr-hold-detail">{message.detail}</span>
          <span className="fr-hold-source">
            Held by the ward
            <code className="fr-code-chip">ward.toml → human_review</code>
          </span>
        </div>
        <span className="fr-hold-wait">
          <span className="fr-dot" aria-hidden="true" />
          Waiting · {message.time}
        </span>
      </div>
      <dl
        className="fr-hold-facts"
        style={{ '--cols': message.facts.length } as CSSProperties}
        aria-label="Details"
      >
        {message.facts.map(([label, value]) => {
          // "no — …" reads as a verdict, so it is shown as one rather than as
          // a value: a bare "No" in the warning colour.
          const isNo = /^no\b/i.test(value);

          return (
            <div key={label} className="fr-fact">
              <dt className="fr-fact-label">{label}</dt>
              <dd className={cx('fr-fact-value', isNo && 'fr-fact-value--no')}>
                {isNo ? 'No' : value}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="fr-hold-actions">
        <button type="button" className="fr-hold-open">
          {message.openLabel}
        </button>
        <span className="fr-spacer" />
        <FamButton variant="ghost" size="sm" title="Decline  ⌘⌫" onClick={onDecline}>
          Decline <kbd className="fr-kbd">⌘⌫</kbd>
        </FamButton>
        <FamButton variant="primary" size="sm" title="Approve  ⌘⏎" onClick={onApprove}>
          Approve <kbd className="fr-kbd">⌘↵</kbd>
        </FamButton>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ reasoning */

type ReasoningCardProps = Readonly<{
  card: ReasoningCardData;
  defaultOpen?: boolean;
}>;

type FoldedStep = Readonly<{
  icon: ReasoningStep['icon'];
  title: string;
  text: string;
  tool?: string | undefined;
  dur?: string | undefined;
  status?: ReasoningStep['status'];
  badge?: string | undefined;
  /** How many routine steps this row stands in for. */
  collapsedCount?: number;
}>;

/** Collapse runs of routine steps once a card grows past seven. */
function foldSteps(steps: readonly ReasoningStep[]): FoldedStep[] {
  const routine = (step: ReasoningStep) => step.status !== 'failed' && !step.badge;
  const out: FoldedStep[] = [];
  let run: ReasoningStep[] = [];

  const flush = () => {
    if (run.length > 2) {
      const [first, second] = run;

      if (first && second) {
        out.push(first, {
          ...second,
          collapsedCount: run.length - 2,
          title: 'Routine tool calls',
          text: `${run.length - 2} more reads and searches inside the ward.`,
          tool: undefined,
          dur: '',
          icon: 'dots-three',
        });
      }
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const step of steps) {
    if (routine(step)) {
      run.push(step);
    } else {
      flush();
      out.push(step);
    }
  }
  flush();

  return out;
}

/**
 * Port of the design's ReasoningCard v2.
 *
 * Closing keeps the body mounted for the collapse transition and unmounts it
 * afterwards, so a closed card costs nothing to keep in a long transcript.
 */
export function ReasoningCard({ card, defaultOpen = true }: ReasoningCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  const unmountTimer = useRef<number | null>(null);

  // A card closed just before its transcript unmounts would otherwise fire
  // the deferred unmount into a component that no longer exists.
  useEffect(
    () => () => {
      if (unmountTimer.current !== null) {
        window.clearTimeout(unmountTimer.current);
      }
    },
    [],
  );

  function setOpenState(next: boolean) {
    if (unmountTimer.current !== null) {
      window.clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    setOpen(next);
    if (next) {
      setMounted(true);
    } else {
      unmountTimer.current = window.setTimeout(() => setMounted(false), 540);
    }
  }

  const all = card.steps;
  const failures = all.filter((step) => step.status === 'failed').length;
  const steps: readonly FoldedStep[] = all.length > 7 && !expanded ? foldSteps(all) : all;

  return (
    <section className="fr-card fr-reasoning" aria-label="Reasoning">
      <button
        type="button"
        className="rc-head"
        aria-expanded={open}
        onClick={() => setOpenState(!open)}
      >
        <span className="rc-icon">
          <Icon name="brain" size={15} />
        </span>
        <span className="rc-summary">
          <span className="rc-title">Reasoning</span>
          <span className="rc-summary-text">{card.summary}</span>
        </span>
        <span className="rc-meta">
          {failures > 0 ? (
            <span className="rc-failure">
              <Icon name="warning-circle-fill" size={11} />
              {failures === 1 ? '1 failed' : `${failures} failed`}
            </span>
          ) : null}
          <span>{all.length} steps</span>
          <span className="fr-mono">{card.duration}</span>
        </span>
        <span className={cx('rc-caret', open && 'rc-caret--open')}>
          <Icon name="caret-down" size={14} />
        </span>
      </button>
      <div className={cx('rc-body', open && 'rc-body--open')} aria-hidden={!open}>
        <div className="rc-body-clip">
          {mounted ? (
            <div className="rc-steps">
              {steps.map((step, position) => {
                const failed = step.status === 'failed';
                const retry = step.badge === 'retry';
                const tone = failed
                  ? 'var(--color-danger)'
                  : retry
                    ? 'var(--color-warning)'
                    : 'var(--text-secondary)';
                // Former status chips fold into the description line.
                const text =
                  failed &&
                  step.badge &&
                  step.badge !== 'retry' &&
                  !/timed out|exit/i.test(step.text)
                    ? `${step.badge} — ${step.text}`
                    : step.text;
                const stateWord = failed ? 'Failed' : retry ? 'Retried' : null;
                const style = {
                  '--tone': tone,
                  '--fr-delay': `${80 + position * 60}ms`,
                  '--fr-line-delay': `${200 + position * 60}ms`,
                } as CSSProperties;

                return (
                  <div key={`${step.title}-${position}`} className="rc-step" style={style}>
                    <span className="rc-rail">
                      <span className="rc-step-icon">
                        <Icon name={step.icon} size={16} />
                      </span>
                      <span
                        className={cx('rc-line', position === steps.length - 1 && 'rc-line--last')}
                      />
                    </span>
                    <div className="rc-step-body">
                      <div className="rc-step-head">
                        <span className={cx('rc-step-title', failed && 'rc-step-title--failed')}>
                          {step.title}
                        </span>
                        <code className="rc-step-tool">{step.tool ?? ''}</code>
                        <span className="rc-step-dur">{step.dur ?? ''}</span>
                      </div>
                      <span className="rc-step-text">
                        {stateWord ? <span className="rc-state">{stateWord} — </span> : null}
                        {text}
                      </span>
                      {step.collapsedCount ? (
                        <button
                          type="button"
                          className="rc-expand"
                          onClick={() => setExpanded(true)}
                        >
                          Show {step.collapsedCount} routine tool calls
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              <div className="rc-footer">
                <span>{card.footer}</span>
                <span className="fr-mono fr-small">{card.toolCalls} tool calls</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- evidence map */

type EvidenceMapProps = Readonly<{
  plot: readonly PlotPoint[];
  /** Lightbox proportions: bigger dots, wider margins. */
  large?: boolean;
}>;

/**
 * The evidence map the pricing conversation "renders".
 *
 * Drawn from data rather than shipped as a bitmap, so no image URL enters
 * runtime source and the dots can carry the same tokens as everything else.
 */
export function EvidenceMap({ plot, large }: EvidenceMapProps) {
  return (
    <>
      <div className="fr-plot-area">
        {plot.map((point) => (
          <div
            key={point.label}
            className="fr-plot-point"
            data-tone={point.tone}
            style={
              {
                '--x': `${point.x}%`,
                '--y': `${100 - point.y}%`,
                '--size': `${large ? Math.round(point.size * 1.6) : point.size}px`,
              } as CSSProperties
            }
          >
            <span className="fr-plot-dot" />
            <span className="fr-plot-label">{point.label}</span>
          </div>
        ))}
      </div>
      <span className="fr-plot-title">Q3 pricing — evidence map</span>
      <span className="fr-plot-legend">
        <span className="fr-plot-legend-item">
          <span className="fr-plot-legend-dot" data-tone="ok" />
          verified
        </span>
        <span className="fr-plot-legend-item">
          <span className="fr-plot-legend-dot" data-tone="warn" />
          flagged
        </span>
        <span className="fr-plot-legend-item">
          <span className="fr-plot-legend-dot" data-tone="inf" />
          inferred
        </span>
      </span>
      <span className="fr-plot-axis-x">
        <span>weaker evidence</span>
        <span>stronger evidence →</span>
      </span>
      <span className="fr-plot-axis-y">claim weight ↑</span>
    </>
  );
}
