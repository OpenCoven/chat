import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FamButton } from '../design/familiars-ui';
import type { CovenFamiliar } from '../lib/coven-runtime';
import {
  defaultMissions,
  type MissionAnswer,
  type MissionPreparation,
  type MissionReason,
  type MissionState,
  type Missions,
  type MissionView,
} from '../lib/missions';
import './mission-panel.css';

/**
 * The inspector's Missions tab (#155): send one read-only diagnosis mission to
 * the selected familiar through Coven, follow it, and cancel it. Every state
 * shown is Coven's; nothing is inferred or simulated here.
 */

const TIME_LIMITS = [5, 10, 15, 30, 60] as const;
const STATEMENT_LIMIT = 200;
const PROMPT_LIMIT = 32 * 1024;

const STATE_LABEL: Record<MissionState, string> = {
  queued: 'Waiting to start',
  running: 'Running',
  needs_approval: 'Needs your approval',
  cancelling: 'Stopping',
  reconciling: 'Checking what happened',
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Not started',
  revoked: 'Stopped',
  unavailable: 'Couldn’t run',
};

function reasonText(reason: MissionReason, name: string): string {
  switch (reason) {
    case 'authority_unavailable':
      return 'Nothing ran. This version of Coven records missions but can’t run them yet.';
    case 'runtime_unavailable':
      return 'Nothing ran. The tool this mission needs isn’t available in Coven.';
    case 'envelope_unsupported':
      return 'Nothing ran. Coven no longer runs missions this way.';
    case 'expired_before_dispatch':
      return 'Nothing ran. Coven couldn’t start the mission in time.';
    case 'familiar_revision_stale':
      return `Nothing ran. ${name} changed before the mission started.`;
    case 'familiar_revision_revoked':
      return `${name}’s current version was withdrawn, so Coven stopped the mission.`;
    case 'grant_revoked':
      return 'Your permission for this mission was withdrawn, so Coven stopped it.';
    case 'timeout':
      return 'The mission ran out of time.';
    case 'harness_failed':
      return `${name}’s run failed.`;
    case 'ambiguous_execution':
      return 'Coven is checking whether the mission finished. It will say once it knows.';
  }
}

function unavailableText(
  preparation: Extract<MissionPreparation, { status: 'unavailable' }>,
  familiar: MissionFamiliar,
  name: string,
): string {
  switch (preparation.reason) {
    case 'update-coven':
      return 'Missions need a newer version of Coven. Update Coven, then choose Try again.';
    case 'coven-not-ready':
      return 'Coven isn’t running, or was started before an update, so it can’t take a mission. Start or restart Coven, then choose Try again.';
    case 'no-read-envelope':
      return 'This version of Coven doesn’t offer read-only missions, so Chat can’t send one.';
    case 'familiar-unregistered':
      return `Coven hasn’t registered ${name} for missions. In a terminal, run coven familiar-ledger register ${familiar.id}, then choose Try again.`;
    case 'familiar-inactive':
      return `${name}’s current version isn’t active in Coven, so Coven won’t take a mission for ${name}.`;
    case 'ledger-unreadable':
      return `Chat couldn’t read ${name}’s record in Coven.`;
  }
}

function refusalText(answer: Extract<MissionAnswer, { kind: 'refused' }>, name: string): string {
  switch (answer.code) {
    case 'REVISION_CONFLICT':
      return `${name} changed since you reviewed this mission. Review it again before sending.`;
    case 'CAPABILITY_UNSUPPORTED':
      return 'Coven changed how missions run since you reviewed this one. Review it again before sending.';
    case 'CONCURRENCY_LIMIT':
      return 'Coven is already working on a mission in this project. Wait for it to finish, then send again.';
    case 'NOT_FOUND':
      return `Coven doesn’t recognize ${name} or this project any more. Choose Try again to reload.`;
    default:
      return `Coven didn’t accept the mission: ${answer.message || answer.code}. Nothing was sent to ${name}.`;
  }
}

/** The revision's position in the familiar's history, shown as its version. */
function version(revisionId: string): string {
  return revisionId.slice(revisionId.lastIndexOf(':') + 1);
}

function usageText(view: MissionView): string | undefined {
  const usage = view.result?.usage;
  if (!view.result) return undefined;
  if (usage === null || usage === undefined) return 'Coven reported no usage.';
  const parts = [
    usage.inputTokens === undefined ? '' : `${usage.inputTokens} input tokens`,
    usage.outputTokens === undefined ? '' : `${usage.outputTokens} output tokens`,
    usage.costUsd === undefined ? '' : `$${usage.costUsd.toFixed(4)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Coven reported no usage.';
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The latest answer Chat holds for one mission, and whether to keep watching. */
type Tracked = { missionId: string; answer: MissionAnswer };

function viewOf(answer: MissionAnswer): MissionView | undefined {
  return answer.kind === 'view' || answer.kind === 'settled' ? answer.mission : undefined;
}

function watching(answer: MissionAnswer): boolean {
  const view = viewOf(answer);
  return answer.kind === 'checking' || (view !== undefined && !view.terminal);
}

/** Keeps the newer of two answers: views only move forward. */
function newer(current: MissionAnswer | undefined, next: MissionAnswer): MissionAnswer {
  const shown = current && viewOf(current);
  const incoming = viewOf(next);
  if (shown && incoming && incoming.revision < shown.revision) return current;
  return next;
}

/** The familiar fields a mission needs: its roster id and declared projects. */
type MissionFamiliar = {
  id: CovenFamiliar['id'];
  projectAccess?: CovenFamiliar['projectAccess'] | undefined;
};

type Props = {
  familiar: MissionFamiliar;
  name: string;
  missions?: Missions;
};

export function MissionPanel({ familiar, name, missions = defaultMissions }: Props) {
  const id = useId();
  const familiarId = familiar.id;
  const [preparation, setPreparation] = useState<MissionPreparation>();
  const [loadError, setLoadError] = useState('');
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [statement, setStatement] = useState('');
  const [prompt, setPrompt] = useState('');
  const projects = familiar.projectAccess ?? [];
  const [project, setProject] = useState(projects[0]?.path ?? '');
  const [timeLimit, setTimeLimit] = useState<number>(10);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  // The familiar this panel currently shows. A late answer for another one is
  // dropped (M-11 b).
  const current = useRef(familiarId);
  current.current = familiarId;
  const watched = useRef(new Set<string>());

  const record = useCallback((missionId: string, answer: MissionAnswer) => {
    const view = viewOf(answer);
    if (view && view.familiarId !== current.current) return;
    setTracked((list) => {
      const at = list.findIndex((item) => item.missionId === missionId);
      if (at < 0) return [{ missionId, answer }, ...list];
      const next = [...list];
      next[at] = { missionId, answer: newer(list[at]?.answer, answer) };
      return next;
    });
  }, []);

  const follow = useCallback(
    (missionId: string) => {
      if (watched.current.has(missionId)) return;
      watched.current.add(missionId);
      const owner = current.current;
      void missions
        .watch(missionId, (answer) => {
          if (current.current === owner) record(missionId, answer);
        })
        .catch((reason: unknown) => {
          if (current.current === owner) setNotice(message(reason));
        })
        .finally(() => watched.current.delete(missionId));
    },
    [missions, record],
  );

  // Load what this familiar can do now: again after Try again, or after Coven
  // said the reviewed revision or envelope is out of date.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the reload trigger.
  useEffect(() => {
    let alive = true;
    setPreparation(undefined);
    setLoadError('');
    setReviewing(false);
    void missions
      .prepare(familiarId)
      .then((value) => {
        if (alive) setPreparation(value);
      })
      .catch((reason: unknown) => {
        if (alive) setLoadError(message(reason));
      });
    return () => {
      alive = false;
    };
  }, [familiarId, missions, attempt]);

  // Load the missions Chat sent this familiar, and follow the open ones.
  useEffect(() => {
    let alive = true;
    void missions
      .list(familiarId)
      .then((list) =>
        Promise.all(
          list.map(async (entry) => {
            const answer = await missions.get(entry.missionId);
            if (!alive) return;
            record(entry.missionId, answer);
            if (watching(answer)) follow(entry.missionId);
          }),
        ),
      )
      .catch((reason: unknown) => {
        if (alive) setNotice(message(reason));
      });
    const following = watched.current;
    return () => {
      alive = false;
      for (const missionId of following) void missions.stopWatch(missionId).catch(() => {});
      following.clear();
    };
  }, [familiarId, missions, record, follow]);

  function retry() {
    setNotice('');
    setAttempt((value) => value + 1);
  }

  const ready = preparation?.status === 'ready' ? preparation : undefined;
  const complete =
    statement.trim().length > 0 &&
    [...statement.trim()].length <= STATEMENT_LIMIT &&
    prompt.trim().length > 0 &&
    new TextEncoder().encode(prompt).length <= PROMPT_LIMIT &&
    project.trim().length > 0;

  async function send() {
    if (!ready || sending) return;
    setSending(true);
    setNotice('');
    try {
      const answer = await missions.submit({
        familiarId,
        rootId: ready.rootId,
        revisionId: ready.revisionId,
        envelopeDigest: ready.envelopeDigest,
        projectCwd: project.trim(),
        statement: statement.trim(),
        prompt,
        timeoutMinutes: timeLimit,
      });
      if (current.current !== familiarId) return;
      switch (answer.kind) {
        case 'view':
        case 'checking': {
          const missionId = answer.kind === 'view' ? answer.mission.missionId : answer.missionId;
          record(missionId, answer);
          if (watching(answer)) follow(missionId);
          setReviewing(false);
          setStatement('');
          setPrompt('');
          break;
        }
        case 'refused':
          setNotice(refusalText(answer, name));
          setReviewing(false);
          if (answer.code === 'REVISION_CONFLICT' || answer.code === 'CAPABILITY_UNSUPPORTED')
            setAttempt((value) => value + 1);
          break;
        case 'not-sent':
          setNotice(`The mission wasn’t sent, so nothing changed. ${answer.message}`.trim());
          break;
        default:
          setNotice('Coven answered about a different mission, so Chat ignored the answer.');
      }
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      setSending(false);
    }
  }

  async function act(missionId: string, operation: 'cancel' | 'get') {
    setNotice('');
    try {
      const answer = await missions[operation](missionId);
      if (current.current !== familiarId) return;
      switch (answer.kind) {
        case 'refused':
          setNotice(`Coven refused: ${answer.message || answer.code}`);
          return;
        case 'not-sent':
          setNotice(`Chat couldn’t reach Coven, so nothing changed. ${answer.message}`.trim());
          return;
        case 'mismatch':
          setNotice('Coven answered about a different mission, so Chat ignored the answer.');
          return;
        default:
          record(missionId, answer);
          if (watching(answer)) follow(missionId);
      }
    } catch (reason) {
      setNotice(message(reason));
    }
  }

  function dismiss(missionId: string) {
    setTracked((list) => list.filter((item) => item.missionId !== missionId));
  }

  return (
    <div className="fr-stack coven-missions">
      <div className="coven-details fr-card fr-card--lift">
        <p>
          Ask {name} to look into something in a project. A mission runs on this computer and only
          reads: it can’t change files, run commands, or use paid cloud services.
        </p>
      </div>
      {loadError ? (
        <div className="coven-missions-gate fr-card fr-card--lift" role="alert">
          <p>Chat couldn’t check whether Coven can take missions. {loadError}</p>
          <FamButton size="sm" onClick={retry}>
            Try again
          </FamButton>
        </div>
      ) : !preparation ? (
        <output className="coven-missions-status" aria-live="polite">
          Checking whether Coven can take a mission for {name}…
        </output>
      ) : preparation.status === 'unavailable' ? (
        <div className="coven-missions-gate fr-card fr-card--lift">
          <p>{unavailableText(preparation, familiar, name)}</p>
          {preparation.detail ? (
            <p className="coven-missions-detail">{preparation.detail}</p>
          ) : null}
          <FamButton size="sm" onClick={retry}>
            Try again
          </FamButton>
        </div>
      ) : reviewing ? (
        <section
          className="coven-missions-review fr-card fr-card--lift"
          aria-label="Review mission"
        >
          <span className="fr-eyebrow">Review before sending</span>
          <div className="fr-rows">
            <div className="fr-row">
              <span className="fr-row-label">Mission</span>
              <span className="fr-row-value">{statement.trim()}</span>
            </div>
            <div className="fr-row">
              <span className="fr-row-label">Familiar</span>
              <span className="fr-row-value">
                {name}, version {version(preparation.revisionId)}
              </span>
            </div>
            <div className="fr-row">
              <span className="fr-row-label">Revision</span>
              <code className="fr-row-value coven-row-value--path" title={preparation.rootId}>
                {preparation.revisionId}
              </code>
            </div>
            <div className="fr-row">
              <span className="fr-row-label">Project</span>
              <code className="fr-row-value coven-row-value--path" title={project.trim()}>
                {project.trim()}
              </code>
            </div>
            <div className="fr-row">
              <span className="fr-row-label">Runs</span>
              <span className="fr-row-value">On this computer, read-only. No paid cloud.</span>
            </div>
            <div className="fr-row">
              <span className="fr-row-label">Time limit</span>
              <span className="fr-row-value">{timeLimit} minutes</span>
            </div>
          </div>
          <p className="coven-missions-detail">
            If Coven can’t run the mission, it ends as “Couldn’t run” and nothing in the project
            changes.
          </p>
          <div className="coven-missions-actions">
            <FamButton size="sm" onClick={() => setReviewing(false)} disabled={sending}>
              Edit
            </FamButton>
            <FamButton size="sm" variant="primary" onClick={() => void send()} disabled={sending}>
              {sending ? 'Sending…' : 'Send mission'}
            </FamButton>
          </div>
        </section>
      ) : (
        <form
          className="coven-missions-form fr-card fr-card--lift"
          aria-label="New mission"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) setReviewing(true);
          }}
        >
          <label htmlFor={`${id}-statement`} className="coven-missions-label">
            Title
          </label>
          <input
            id={`${id}-statement`}
            className="coven-missions-input"
            value={statement}
            maxLength={STATEMENT_LIMIT * 2}
            placeholder="Why does the build fail?"
            onChange={(event) => setStatement(event.target.value)}
          />
          <label htmlFor={`${id}-prompt`} className="coven-missions-label">
            What should {name} look into?
          </label>
          <textarea
            id={`${id}-prompt`}
            className="coven-missions-input coven-missions-prompt"
            value={prompt}
            rows={4}
            placeholder="Read the last CI log and explain why the build fails."
            onChange={(event) => setPrompt(event.target.value)}
          />
          <label htmlFor={`${id}-project`} className="coven-missions-label">
            Project folder
          </label>
          <input
            id={`${id}-project`}
            className="coven-missions-input"
            value={project}
            list={projects.length ? `${id}-projects` : undefined}
            placeholder="/path/to/project"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setProject(event.target.value)}
          />
          {projects.length ? (
            <datalist id={`${id}-projects`}>
              {projects.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.name}
                </option>
              ))}
            </datalist>
          ) : null}
          <label htmlFor={`${id}-limit`} className="coven-missions-label">
            Time limit
          </label>
          <select
            id={`${id}-limit`}
            className="coven-missions-input"
            value={timeLimit}
            onChange={(event) => setTimeLimit(Number(event.target.value))}
          >
            {TIME_LIMITS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
          <div className="coven-missions-actions">
            <FamButton size="sm" variant="primary" type="submit" disabled={!complete}>
              Review mission
            </FamButton>
          </div>
        </form>
      )}
      {notice ? (
        <p className="coven-missions-notice" role="alert">
          {notice}
        </p>
      ) : null}
      {tracked.length ? (
        <ul className="coven-missions-list" aria-label="Missions">
          {tracked.map(({ missionId, answer }) => (
            <MissionCard
              key={missionId}
              answer={answer}
              name={name}
              onCancel={() => void act(missionId, 'cancel')}
              onCheck={() => void act(missionId, 'get')}
              onDismiss={() => dismiss(missionId)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MissionCard({
  answer,
  name,
  onCancel,
  onCheck,
  onDismiss,
}: {
  answer: MissionAnswer;
  name: string;
  onCancel: () => void;
  onCheck: () => void;
  onDismiss: () => void;
}) {
  const view = viewOf(answer);
  if (!view) {
    const text =
      answer.kind === 'checking'
        ? 'Checking whether Coven received this mission. Chat will keep asking.'
        : answer.kind === 'never-sent'
          ? 'This mission never reached Coven, so nothing ran.'
          : answer.kind === 'gone'
            ? 'Coven no longer has this mission. It may belong to a different Coven setup.'
            : 'Coven answered about a different mission, so Chat ignored the answer.';
    return (
      <li className="coven-mission fr-card fr-card--lift" data-kind={answer.kind}>
        <p>{text}</p>
        <div className="coven-missions-actions">
          {answer.kind === 'checking' ? (
            <FamButton size="sm" onClick={onCheck}>
              Check again
            </FamButton>
          ) : (
            <FamButton size="sm" onClick={onDismiss}>
              Dismiss
            </FamButton>
          )}
        </div>
      </li>
    );
  }
  const cancellable = ['queued', 'running', 'needs_approval'].includes(view.state);
  const usage = usageText(view);
  return (
    <li className="coven-mission fr-card fr-card--lift" data-state={view.state}>
      <div className="coven-mission-head">
        <span className="coven-mission-title">{view.statement}</span>
        <span className="coven-mission-state">{STATE_LABEL[view.state]}</span>
      </div>
      {view.reason ? <p className="coven-mission-reason">{reasonText(view.reason, name)}</p> : null}
      {answer.kind === 'settled' ? (
        <p className="coven-mission-reason">
          The mission had already finished, so there was nothing to cancel.
        </p>
      ) : null}
      {view.cancellation === 'lost_to_completion' ? (
        <p className="coven-mission-reason">The mission finished before the cancel reached it.</p>
      ) : null}
      <div className="fr-rows">
        <div className="fr-row">
          <span className="fr-row-label">Project</span>
          <code className="fr-row-value coven-row-value--path" title={view.projectCwd}>
            {view.projectCwd}
          </code>
        </div>
        <div className="fr-row">
          <span className="fr-row-label">Sent</span>
          <time className="fr-row-value" dateTime={view.submittedAt}>
            {new Date(view.submittedAt).toLocaleString()}
          </time>
        </div>
        {view.result ? (
          <div className="fr-row">
            <span className="fr-row-label">Reports</span>
            <span className="fr-row-value">{view.result.reports}</span>
          </div>
        ) : null}
        {usage ? (
          <div className="fr-row">
            <span className="fr-row-label">Usage</span>
            <span className="fr-row-value">{usage}</span>
          </div>
        ) : null}
      </div>
      {cancellable ? (
        <div className="coven-missions-actions">
          <FamButton size="sm" onClick={onCancel}>
            Cancel mission
          </FamButton>
        </div>
      ) : null}
    </li>
  );
}
