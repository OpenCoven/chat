import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import chatIconUrl from '../../assets/brand/chat-app-icon-rounded.svg';
import { CopyButton } from '../coven/copy-button';
import { FamButton } from '../design/familiars-ui';
import { Icon } from '../design/minimal-icons';
import {
  chatReachable,
  createSetup,
  type Setup,
  type SetupReport,
  type SetupRunEvent,
  type SetupRunStep,
  setupComplete,
} from '../lib/setup';
import './onboarding.css';

const defaultSetup = createSetup();

type Phase =
  | { kind: 'checking' }
  | { kind: 'report'; report: SetupReport }
  | { kind: 'failed'; message: string }
  | { kind: 'chat' };

/** A step Chat is completing, with its latest progress. */
type Run = {
  step: SetupRunStep;
  id: string;
  stage?: 'download' | 'install';
  received?: number;
  total?: number;
  line?: string;
};
type Runner = {
  run: Run | null;
  failure: { step: SetupRunStep; message: string } | null;
  start: (step: SetupRunStep) => void;
  stop: () => void;
  available: boolean;
};

/** The native message for a stopped run. */
const RUN_CANCELLED = 'Coven run cancelled.';

function runId() {
  return `setup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function advance(run: Run, event: SetupRunEvent): Run {
  if (event.type === 'line') return { ...run, line: event.text };
  if (event.stage === 'install') return { ...run, stage: 'install' };
  return { ...run, stage: 'download', received: event.received, total: event.total };
}

/**
 * First-run setup in front of the chat. It checks what a new person still
 * needs (Coven, its engine, a model sign-in, a familiar) and shows the chat
 * as soon as everything is in place. Coven and its engine are required; the
 * rest can be skipped with **Continue to Chat**, so a sign-in this check
 * cannot see never locks out a working setup.
 */
export function Onboarding({
  setup = defaultSetup,
  children,
}: {
  setup?: Setup;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [rechecking, setRechecking] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<Runner['failure']>(null);
  const latest = useRef(0);
  const running = useRef(false);
  const check = useCallback(async (): Promise<SetupReport | null> => {
    const id = ++latest.current;
    setRechecking(true);
    try {
      const report = await setup.check();
      if (id !== latest.current) return null;
      setPhase(
        report === null || setupComplete(report) ? { kind: 'chat' } : { kind: 'report', report },
      );
      return report;
    } catch (error) {
      if (id !== latest.current) return null;
      setPhase({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Chat could not check your setup.',
      });
      return null;
    } finally {
      if (id === latest.current) setRechecking(false);
    }
  }, [setup]);
  useEffect(() => {
    void check();
  }, [check]);

  const start = useCallback(
    async (step: SetupRunStep) => {
      if (!setup.run || running.current) return;
      running.current = true;
      setFailure(null);
      let next: SetupRunStep | null = step;
      while (next) {
        const current: SetupRunStep = next;
        next = null;
        const id = runId();
        setRun({ step: current, id });
        try {
          await setup.run(id, current, (event) =>
            setRun((value) => (value?.id === id ? advance(value, event) : value)),
          );
        } catch (error) {
          setFailure({
            step: current,
            message:
              error instanceof Error ? error.message : 'This setup step did not finish. Try again.',
          });
          break;
        } finally {
          setRun(null);
        }
        const report = await check();
        // Installing Coven continues straight on to its engine.
        if (current === 'install_coven' && report?.coven.ok && !report.engine.ok) {
          next = 'install_engine';
        }
      }
      running.current = false;
    },
    [setup, check],
  );
  const runner: Runner = {
    run,
    failure,
    start: (step) => void start(step),
    stop: () => {
      if (run && setup.cancel) void setup.cancel(run.id).catch(() => undefined);
    },
    available: Boolean(setup.run),
  };

  if (phase.kind === 'chat') return children;
  return (
    <main className="fr-shell coven-onboarding" aria-busy={rechecking}>
      <div className="coven-onboarding-card">
        <header className="coven-onboarding-header">
          <img src={chatIconUrl} alt="" width={56} height={56} />
          <h1>Set up Coven Chat</h1>
          <p>
            Coven Chat talks to familiars that run on this computer. Here is what it still needs.
          </p>
        </header>
        {phase.kind === 'checking' ? (
          <output className="coven-onboarding-status">Checking your setup…</output>
        ) : phase.kind === 'failed' ? (
          <p className="coven-onboarding-status" role="alert">
            Chat could not check your setup: {phase.message}
          </p>
        ) : (
          <ol className="coven-onboarding-steps">
            <CovenStep report={phase.report} runner={runner} />
            <EngineStep report={phase.report} runner={runner} />
            <SignInStep report={phase.report} />
            <FamiliarStep report={phase.report} />
          </ol>
        )}
        {phase.kind === 'checking' ? null : (
          <footer className="coven-onboarding-actions">
            <FamButton
              variant="primary"
              disabled={rechecking || run !== null}
              onClick={() => void check()}
            >
              {rechecking ? 'Checking…' : 'Check again'}
            </FamButton>
            {run === null && (phase.kind === 'failed' || chatReachable(phase.report)) ? (
              <FamButton onClick={() => setPhase({ kind: 'chat' })}>Continue to Chat</FamButton>
            ) : null}
          </footer>
        )}
      </div>
    </main>
  );
}

function Step({ title, done, children }: { title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="coven-onboarding-step" data-done={done}>
      <Icon name={done ? 'check-circle-fill' : 'warning-circle-fill'} size={18} />
      <section aria-label={title}>
        <h2>
          {title}
          <span className="coven-onboarding-visually-hidden">{done ? ' (done)' : ' (needed)'}</span>
        </h2>
        {children}
      </section>
    </li>
  );
}

function Command({ command }: { command: string }) {
  return (
    <span className="coven-onboarding-command">
      <code>{command}</code>
      <CopyButton text={command} label="Copy command" />
    </span>
  );
}

function percent(run: Run) {
  return run.total ? Math.min(100, Math.floor(((run.received ?? 0) / run.total) * 100)) : 0;
}

function describe(run: Run) {
  if (run.step === 'install_engine') return run.line ?? 'Installing the engine…';
  if (run.stage === 'download') return `Downloading Coven… ${percent(run)}%`;
  if (run.stage === 'install') return 'Installing Coven…';
  return 'Starting…';
}

/** The button that completes a step, its live progress, and why it stopped. */
function RunControls({
  step,
  label,
  runner,
}: {
  step: SetupRunStep;
  label: string;
  runner: Runner;
}) {
  const active = runner.run?.step === step ? runner.run : null;
  const failure = runner.failure?.step === step ? runner.failure.message : null;
  if (active) {
    const measured = active.stage === 'download' && active.total;
    return (
      <div className="coven-onboarding-run">
        <progress
          aria-label={`${label} progress`}
          {...(measured ? { value: active.received ?? 0, max: active.total } : {})}
        />
        <output className="coven-onboarding-run-status">{describe(active)}</output>
        <FamButton size="sm" onClick={runner.stop}>
          Cancel
        </FamButton>
      </div>
    );
  }
  return (
    <>
      <span>
        <FamButton
          variant="primary"
          size="sm"
          disabled={runner.run !== null}
          onClick={() => runner.start(step)}
        >
          {failure ? 'Try again' : label}
        </FamButton>
      </span>
      {failure ? (
        <p className="coven-onboarding-failure" role="alert">
          {failure === RUN_CANCELLED ? 'Stopped. You can start it again.' : failure}
        </p>
      ) : null}
    </>
  );
}

function CovenStep({ report, runner }: { report: SetupReport; runner: Runner }) {
  if (!report.platform.ok) {
    return (
      <Step title="Coven" done={false}>
        <p>Coven Chat does not support this computer yet.</p>
      </Step>
    );
  }
  return (
    <Step title="Coven" done={report.coven.ok}>
      {report.coven.ok ? (
        <p>{report.coven.version ? `Installed: ${report.coven.version}.` : 'Installed.'}</p>
      ) : runner.available ? (
        <>
          <p>Coven runs your familiars on this computer. Chat installs it, then its engine.</p>
          <RunControls step="install_coven" label="Install Coven" runner={runner} />
          <details className="coven-onboarding-manual">
            <summary>Install it in a terminal instead</summary>
            <p>This way needs Node.js.</p>
            <Command command="npm install -g @opencoven/cli" />
          </details>
        </>
      ) : (
        <>
          <p>
            Coven runs your familiars on this computer. Run this in a terminal (it needs Node.js):
          </p>
          <Command command="npm install -g @opencoven/cli" />
        </>
      )}
    </Step>
  );
}

function EngineStep({ report, runner }: { report: SetupReport; runner: Runner }) {
  return (
    <Step title="Coven engine" done={report.engine.ok}>
      {report.engine.ok ? (
        <p>Installed.</p>
      ) : report.coven.ok && runner.available ? (
        <>
          <p>The engine is what answers your messages.</p>
          <RunControls step="install_engine" label="Install the engine" runner={runner} />
          <details className="coven-onboarding-manual">
            <summary>Install it in a terminal instead</summary>
            <Command command="coven engine install" />
          </details>
        </>
      ) : report.coven.ok ? (
        <>
          <p>The engine is what answers your messages. Run this in a terminal:</p>
          <Command command="coven engine install" />
        </>
      ) : (
        <p>Install Coven first.</p>
      )}
    </Step>
  );
}

function SignInStep({ report }: { report: SetupReport }) {
  const { signIn } = report;
  if (signIn.ok) {
    const route =
      signIn.claude === 'signed-in'
        ? 'Signed in with your Claude subscription.'
        : signIn.chatgpt === 'signed-in'
          ? 'Signed in with ChatGPT.'
          : 'Signed in.';
    return (
      <Step title="Model sign-in" done>
        <p>{route}</p>
      </Step>
    );
  }
  return (
    <Step title="Model sign-in" done={false}>
      <p>Familiars need a model to answer. To use your Claude subscription:</p>
      {signIn.claude === 'missing' ? (
        <>
          <p>
            Install Claude Code in a{' '}
            {report.platform.os === 'windows' ? 'PowerShell window' : 'terminal'}:
          </p>
          <Command command={signIn.claudeInstaller} />
          <p>Then sign in:</p>
        </>
      ) : (
        <p>Sign in to Claude Code in a terminal:</p>
      )}
      <Command command="claude auth login" />
    </Step>
  );
}

function FamiliarStep({ report }: { report: SetupReport }) {
  const { count, ok } = report.familiar;
  return (
    <Step title="A familiar" done={ok}>
      {ok ? (
        <p>{count === 1 ? 'One familiar is ready.' : `${count} familiars are ready.`}</p>
      ) : (
        <p>You do not have a familiar yet. Creating your first one here is coming next.</p>
      )}
    </Step>
  );
}
