import { describe, expect, it } from 'vitest';
import { projectEvents } from './events';

const init = { type: 'system', subtype: 'init', session_id: 'ledger-1' };
const exhausted = {
  type: 'result',
  session_id: 'ledger-1',
  harness_session_id: 'engine-1',
  run_budget_version: 1,
  num_turns: 10,
  is_error: true,
  outcome: 'turn_budget_exhausted',
  turn_budget: { max_turns: 10, consumed: 10, source: 'explicit' },
  continuation: { session_id: 'engine-1', resumable: true },
};
const settled = {
  ...exhausted,
  type: 'system',
  subtype: 'run_budget',
  source: 'chat-run-budget',
  settled: true,
};

describe('applied model-round budget evidence', () => {
  it('keeps partial output and marks exhaustion unfinished without a generic retry error', () => {
    const view = projectEvents([
      init,
      { type: 'text_delta', session_id: 'ledger-1', text: 'Partial work' },
      exhausted,
    ]);
    expect(view.error).toBe('');
    expect(view.messages[0]?.text).toBe('Partial work');
    expect(view.budget).toMatchObject({
      limit: 10,
      consumed: 10,
      source: 'explicit',
      unfinished: true,
      canContinue: false,
    });
  });
  it('offers continuation only after native settlement confirms persisted engine backing', () => {
    expect(projectEvents([init, exhausted, settled]).budget).toMatchObject({
      canContinue: true,
      sessionId: 'ledger-1',
    });
    expect(
      projectEvents([
        init,
        exhausted,
        { ...settled, continuation: { session_id: 'engine-1', resumable: false } },
      ]).budget?.canContinue,
    ).toBe(false);
  });
  it('does not reuse an earlier run receipt after another run starts', () => {
    expect(
      projectEvents([init, exhausted, settled, { ...init, session_id: 'ledger-2' }]).budget,
    ).toBeUndefined();
    expect(
      projectEvents([init, exhausted, settled, { ...init, session_id: 'ledger-2' }, settled])
        .budget,
    ).toBeUndefined();
  });
  it('rejects malformed or mismatched applied metadata instead of echoing a preference', () => {
    for (const broken of [
      { ...settled, run_budget_version: 2 },
      { ...settled, turn_budget: { max_turns: 0, consumed: 0, source: 'explicit' } },
      { ...settled, turn_budget: { max_turns: 10, consumed: 11, source: 'explicit' } },
      { ...settled, num_turns: 9 },
      { ...settled, continuation: { session_id: 'another-engine', resumable: true } },
      { ...settled, turn_budget: { max_turns: 10, consumed: 10, source: 'guessed' } },
    ])
      expect(projectEvents([init, broken]).budget).toBeUndefined();
  });
  it('retains provider failure separately even when it has a valid applied budget', () => {
    const failed = { ...exhausted, outcome: undefined, error: 'Authentication failed' };
    expect(projectEvents([init, failed]).error).toBe('Authentication failed');
    expect(projectEvents([init, failed]).budget?.unfinished).toBe(false);
  });
});
