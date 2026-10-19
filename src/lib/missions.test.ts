import { describe, expect, it, vi } from 'vitest';
import {
  type AnswerChannel,
  createMissions,
  isMissionAnswer,
  isMissionPreparation,
  isMissionView,
  type MissionView,
} from './missions';

const ROOT = `familiar:${'a'.repeat(32)}`;
const REVISION = `familiar-revision:${'a'.repeat(32)}:3`;
const ID = `mission-${'b'.repeat(32)}`;

function missionView(overrides: Partial<MissionView> = {}): MissionView {
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
    projectCwd: '/work/project',
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

describe('mission answers from the host', () => {
  it('accepts Coven views and rejects inconsistent ones', () => {
    expect(isMissionView(missionView())).toBe(true);
    const queued = missionView({ state: 'queued', terminal: false });
    delete queued.reason;
    delete queued.result;
    expect(isMissionView(queued)).toBe(true);
    for (const bad of [
      missionView({ terminal: false }),
      missionView({ state: 'completed' }),
      missionView({ missionId: 'mission-1' }),
      missionView({ revisionId: 'familiar-revision:x' }),
      missionView({ state: 'submitted' as MissionView['state'] }),
      { ...missionView(), result: { ...missionView().result, usage: { inputTokens: -1 } } },
      { ...queued, result: missionView().result },
    ])
      expect(isMissionView(bad)).toBe(false);
  });

  it('accepts each answer kind in its documented shape', () => {
    for (const answer of [
      { kind: 'view', mission: missionView() },
      { kind: 'settled', mission: missionView() },
      { kind: 'refused', code: 'REVISION_CONFLICT', message: 'stale', currentRevisionId: REVISION },
      { kind: 'not-sent', message: 'no daemon' },
      { kind: 'checking', missionId: ID },
      { kind: 'never-sent', missionId: ID },
      { kind: 'gone', missionId: ID },
      { kind: 'mismatch', missionId: ID },
    ])
      expect(isMissionAnswer(answer)).toBe(true);
    for (const answer of [
      { kind: 'settled', mission: { ...missionView({ state: 'queued', terminal: false }) } },
      { kind: 'checking', missionId: 'mission-x' },
      { kind: 'refused', code: '', message: 'x' },
      { kind: 'launched', missionId: ID },
    ])
      expect(isMissionAnswer(answer)).toBe(false);
  });

  it('accepts a preparation only with the exact revision and envelope', () => {
    const ready = {
      status: 'ready',
      familiarId: 'sage',
      rootId: ROOT,
      revisionId: REVISION,
      envelopeId: 'r0-read.1',
      envelopeDigest: '3'.repeat(64),
    };
    expect(isMissionPreparation(ready)).toBe(true);
    expect(isMissionPreparation({ ...ready, envelopeId: 'exec.1' })).toBe(false);
    expect(isMissionPreparation({ ...ready, envelopeDigest: 'x' })).toBe(false);
    expect(
      isMissionPreparation({ status: 'unavailable', reason: 'update-coven', detail: '' }),
    ).toBe(true);
    expect(isMissionPreparation({ status: 'unavailable', reason: 'other', detail: '' })).toBe(
      false,
    );
  });
});

describe('the missions client', () => {
  it('names commands and arguments exactly, and refuses invalid answers', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'checking', missionId: ID });
    const missions = createMissions({ available: () => true, invoke });
    await missions.get(ID);
    await missions.cancel(ID);
    expect(invoke).toHaveBeenNthCalledWith(1, 'mission_get', { missionId: ID });
    expect(invoke).toHaveBeenNthCalledWith(2, 'mission_cancel', { missionId: ID });
    invoke.mockResolvedValue({ kind: 'view', mission: { missionId: ID } });
    await expect(missions.get(ID)).rejects.toThrow('invalid mission answer');
  });

  it('streams only valid answers from a watch', async () => {
    let channel: AnswerChannel | undefined;
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      channel = args?.onEvent as AnswerChannel;
      channel.onmessage({ kind: 'view', mission: missionView() });
      channel.onmessage({ kind: 'view', mission: { missionId: ID } });
      channel.onmessage({ kind: 'checking', missionId: ID });
      return null;
    });
    const missions = createMissions({
      available: () => true,
      invoke,
      channel: () => ({ onmessage: () => {} }),
    });
    const seen: string[] = [];
    await missions.watch(ID, (answer) => seen.push(answer.kind));
    expect(seen).toEqual(['view', 'checking']);
    expect(invoke).toHaveBeenCalledWith('mission_watch', { missionId: ID, onEvent: channel });
  });

  it('says missions need the desktop app outside it', async () => {
    const invoke = vi.fn();
    const missions = createMissions({ available: () => false, invoke });
    await expect(missions.prepare('sage')).rejects.toThrow('Missions require the desktop app.');
    expect(invoke).not.toHaveBeenCalled();
  });
});
