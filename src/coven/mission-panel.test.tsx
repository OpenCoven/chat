import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MissionAnswer, MissionPreparation, Missions, MissionView } from '../lib/missions';
import { MissionPanel } from './mission-panel';

const ROOT = `familiar:${'a'.repeat(32)}`;
const REVISION = `familiar-revision:${'a'.repeat(32)}:4`;
const DIGEST = '3'.repeat(64);
const ID = `mission-${'b'.repeat(32)}`;
const familiar = {
  id: 'sage',
  projectAccess: [{ name: 'Chat', path: '/work/chat', access: 'read' as const }],
};
const ready: MissionPreparation = {
  status: 'ready',
  familiarId: 'sage',
  rootId: ROOT,
  revisionId: REVISION,
  envelopeId: 'r0-read.1',
  envelopeDigest: DIGEST,
};

function view(overrides: Partial<MissionView> = {}): MissionView {
  return {
    missionId: ID,
    familiarId: 'sage',
    revision: 2,
    state: 'unavailable',
    terminal: true,
    reason: 'authority_unavailable',
    rootId: ROOT,
    revisionId: REVISION,
    principalId: `principal:coven-local-owner:${'c'.repeat(32)}`,
    statement: 'Why does the build fail?',
    projectCwd: '/work/chat',
    submittedAt: '2026-10-18T12:00:00.000Z',
    validUntil: '2026-10-18T12:10:00.000Z',
    attempts: 0,
    result: {
      outcome: 'unavailable',
      settledAt: '2026-10-18T12:00:01.000Z',
      observation: 'unknown',
      reports: 0,
      usage: null,
    },
    ...overrides,
  };
}

function queued(): MissionView {
  const mission = view({ state: 'queued', terminal: false, revision: 1 });
  delete mission.reason;
  delete mission.result;
  return mission;
}

function client(overrides: Partial<Missions> = {}): Missions {
  return {
    prepare: vi.fn().mockResolvedValue(ready),
    list: vi.fn().mockResolvedValue([]),
    submit: vi.fn().mockResolvedValue({ kind: 'view', mission: view() }),
    get: vi.fn().mockResolvedValue({ kind: 'view', mission: view() }),
    cancel: vi.fn().mockResolvedValue({ kind: 'settled', mission: view({ revision: 4 }) }),
    watch: vi.fn().mockResolvedValue(undefined),
    stopWatch: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function compose() {
  fireEvent.change(await screen.findByLabelText('Title'), {
    target: { value: 'Why does the build fail?' },
  });
  fireEvent.change(screen.getByLabelText('What should Sage look into?'), {
    target: { value: 'Read the last CI log.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review mission' }));
}

describe('Missions tab', () => {
  it('says why a familiar cannot take a mission and retries on request', async () => {
    const api = client({
      prepare: vi
        .fn()
        .mockResolvedValueOnce({ status: 'unavailable', reason: 'update-coven', detail: '' })
        .mockResolvedValueOnce({
          status: 'unavailable',
          reason: 'familiar-unregistered',
          detail: '',
        }),
    });
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    expect(await screen.findByText(/Missions need a newer version of Coven/)).toBeVisible();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(/run coven familiar-ledger register sage, then choose Try again/),
    ).toBeVisible();
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('shows the exact familiar revision before sending, then Coven’s answer', async () => {
    const api = client();
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    await compose();
    const review = screen.getByRole('region', { name: 'Review mission' });
    expect(review).toHaveTextContent('Sage, version 4');
    expect(review).toHaveTextContent(REVISION);
    expect(review).toHaveTextContent('/work/chat');
    expect(review).toHaveTextContent('On this computer, read-only. No paid cloud.');
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send mission' }));
    expect(await screen.findByText('Couldn’t run')).toBeVisible();
    expect(
      screen.getByText(
        'Nothing ran. This version of Coven records missions but can’t run them yet.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Coven reported no usage.')).toBeVisible();
    expect(api.submit).toHaveBeenCalledWith({
      familiarId: 'sage',
      rootId: ROOT,
      revisionId: REVISION,
      envelopeDigest: DIGEST,
      projectCwd: '/work/chat',
      statement: 'Why does the build fail?',
      prompt: 'Read the last CI log.',
      timeoutMinutes: 10,
    });
    // A settled mission is followed no further, and offers no cancel.
    expect(api.watch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel mission' })).not.toBeInTheDocument();
  });

  it('asks for a fresh review when the familiar changed', async () => {
    const api = client({
      submit: vi.fn().mockResolvedValue({
        kind: 'refused',
        code: 'REVISION_CONFLICT',
        message: 'stale',
        currentRevisionId: `familiar-revision:${'a'.repeat(32)}:5`,
      }),
    });
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    await compose();
    fireEvent.click(screen.getByRole('button', { name: 'Send mission' }));
    expect(
      await screen.findByText(
        'Sage changed since you reviewed this mission. Review it again before sending.',
      ),
    ).toBeVisible();
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2));
  });

  it('never presents an unanswered submit as nothing happened', async () => {
    const api = client({
      submit: vi.fn().mockResolvedValue({ kind: 'checking', missionId: ID }),
      get: vi.fn().mockResolvedValue({ kind: 'never-sent', missionId: ID }),
    });
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    await compose();
    fireEvent.click(screen.getByRole('button', { name: 'Send mission' }));
    expect(
      await screen.findByText(
        'Checking whether Coven received this mission. Chat will keep asking.',
      ),
    ).toBeVisible();
    expect(api.watch).toHaveBeenCalledWith(ID, expect.any(Function));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(
      await screen.findByText('This mission never reached Coven, so nothing ran.'),
    ).toBeVisible();
  });

  it('follows open missions, drops answers for another familiar, and cancels', async () => {
    let push: (answer: MissionAnswer) => void = () => {};
    const api = client({
      list: vi.fn().mockResolvedValue([{ missionId: ID, phase: 'committed' }]),
      get: vi.fn().mockResolvedValue({ kind: 'view', mission: queued() }),
      watch: vi.fn((_id: string, onAnswer: (answer: MissionAnswer) => void) => {
        push = onAnswer;
        return new Promise<void>(() => {});
      }),
    });
    const { unmount } = render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    expect(await screen.findByText('Waiting to start')).toBeVisible();
    await waitFor(() => expect(api.watch).toHaveBeenCalledTimes(1));

    // M-11 b: a view for another familiar never reaches the card.
    act(() =>
      push({ kind: 'view', mission: { ...queued(), familiarId: 'astra', state: 'running' } }),
    );
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    // An older revision never replaces a newer one.
    act(() => push({ kind: 'view', mission: { ...queued(), revision: 3, state: 'running' } }));
    expect(screen.getByText('Running')).toBeVisible();
    act(() => push({ kind: 'view', mission: queued() }));
    expect(screen.getByText('Running')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel mission' }));
    expect(
      await screen.findByText('The mission had already finished, so there was nothing to cancel.'),
    ).toBeVisible();
    expect(api.cancel).toHaveBeenCalledWith(ID);
    unmount();
    expect(api.stopWatch).toHaveBeenCalledWith(ID);
  });

  it('shows missions kept from before a restart and removes a finished one', async () => {
    const api = client({
      list: vi.fn().mockResolvedValue([{ missionId: ID, phase: 'terminal' }]),
    });
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    expect(await screen.findByText('Couldn’t run')).toBeVisible();
    expect(api.get).toHaveBeenCalledWith(ID);
    expect(api.watch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Couldn’t run')).not.toBeInTheDocument());
    expect(api.remove).toHaveBeenCalledWith(ID);
  });

  it('says a mission that was not sent changed nothing', async () => {
    const api = client({
      submit: vi.fn().mockResolvedValue({ kind: 'not-sent', message: 'No running Coven daemon.' }),
    });
    render(<MissionPanel familiar={familiar} name="Sage" missions={api} />);
    await compose();
    fireEvent.click(screen.getByRole('button', { name: 'Send mission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The mission wasn’t sent, so nothing changed. No running Coven daemon.',
    );
    // The review stays open so the person can send it again.
    expect(screen.getByRole('button', { name: 'Send mission' })).toBeEnabled();
  });
});
