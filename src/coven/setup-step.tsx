import type { CovenSetupStep } from '../lib/coven-runtime';
import { CopyButton } from './copy-button';
import './setup-step.css';

/**
 * The one command that gets Coven past the step it reported missing. Chat
 * never runs it: installing software is the user's call, made in their own
 * terminal, and **Check again** below picks up the result.
 */
const STEPS: Readonly<Record<CovenSetupStep, { title: string; text: string; command: string }>> = {
  'install-cli': {
    title: 'Install the Coven CLI',
    text: 'Run this in a terminal, then choose Check again. It needs Node.js.',
    command: 'npm install -g @opencoven/cli',
  },
  'install-engine': {
    title: 'Install the Coven engine',
    text: 'Coven is installed, but its engine is not. Run this in a terminal, then choose Check again.',
    command: 'coven engine install',
  },
};

export function SetupStep({ step }: { step: CovenSetupStep }) {
  const { title, text, command } = STEPS[step];
  return (
    <section className="coven-setup-step" aria-label={title}>
      <span className="coven-setup-step-title">{title}</span>
      <span className="coven-setup-step-text">{text}</span>
      <span className="coven-setup-step-command">
        <code>{command}</code>
        <CopyButton text={command} label="Copy command" />
      </span>
    </section>
  );
}
