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
  setupComplete,
} from '../lib/setup';
import './onboarding.css';

const defaultSetup = createSetup();

type Phase =
  | { kind: 'checking' }
  | { kind: 'report'; report: SetupReport }
  | { kind: 'failed'; message: string }
  | { kind: 'chat' };

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
  const latest = useRef(0);
  const check = useCallback(async () => {
    const id = ++latest.current;
    setRechecking(true);
    try {
      const report = await setup.check();
      if (id !== latest.current) return;
      setPhase(
        report === null || setupComplete(report) ? { kind: 'chat' } : { kind: 'report', report },
      );
    } catch (error) {
      if (id !== latest.current) return;
      setPhase({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Chat could not check your setup.',
      });
    } finally {
      if (id === latest.current) setRechecking(false);
    }
  }, [setup]);
  useEffect(() => {
    void check();
  }, [check]);

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
            <CovenStep report={phase.report} />
            <EngineStep report={phase.report} />
            <SignInStep report={phase.report} />
            <FamiliarStep report={phase.report} />
          </ol>
        )}
        {phase.kind === 'checking' ? null : (
          <footer className="coven-onboarding-actions">
            <FamButton variant="primary" disabled={rechecking} onClick={() => void check()}>
              {rechecking ? 'Checking…' : 'Check again'}
            </FamButton>
            {phase.kind === 'failed' || chatReachable(phase.report) ? (
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

function CovenStep({ report }: { report: SetupReport }) {
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

function EngineStep({ report }: { report: SetupReport }) {
  return (
    <Step title="Coven engine" done={report.engine.ok}>
      {report.engine.ok ? (
        <p>Installed.</p>
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
