import { expect, test } from 'vitest';
import events from '../../tests/fixtures/provider-limit.json';
import { projectEvents } from './events';

test('one interrupted run retains saved output and presents one provider reset', () => {
  const { messages } = projectEvents(events);
  expect(messages.filter((m) => m.notice === 'interruption')).toHaveLength(1);
  expect(messages.map((m) => m.text).join(' ')).toContain('Saved the first result.');
  expect(
    messages
      .map((m) => m.text)
      .join(' ')
      .match(/1:10am/g),
  ).toHaveLength(1);
});

test('a quoted limit in a healthy run is still message content', () => {
  const { messages } = projectEvents(events.slice(0, -2));
  expect(messages.some((m) => m.text.includes("You've hit your 5-hour limit"))).toBe(true);
  expect(messages.some((m) => m.notice === 'interruption')).toBe(false);
});

test('each interruption belongs to its own run and points to the submitted message', () => {
  const again = events.map((e) => ({ ...e, session_id: 'next-run' }));
  const { messages } = projectEvents([...events, ...again]);
  const cards = messages.filter((m) => m.notice === 'interruption');
  expect(cards).toHaveLength(2);
  expect(cards.map((m) => m.progressStart)).toEqual(['1', String(events.length + 1)]);
  expect(cards.every((card) => card.report?.includes('Engine report:'))).toBe(true);
});

test('structured provider limits collapse before the run exits and retain ordinary replies', () => {
  const session_id = 'run';
  const message = 'API Error: Request rejected (429) · Please wait';
  const limit = {
    type: 'provider_limit',
    version: 1,
    session_id,
    limit: { provider_session_id: 'owner', notice: message },
  };
  const frames = [
    { type: 'text_delta', session_id, text: 'Saved report.' },
    limit,
    { type: 'text_delta', session_id, text: message },
    { ...limit, limit: { provider_session_id: 'owner', resets_at: 1893456000 } },
    { type: 'text_delta', session_id, text: message },
    { type: 'text_delta', session_id, text: 'A second result arrived.' },
  ];
  const { messages } = projectEvents(frames);
  expect(messages.map((m) => m.text)).toEqual([
    'Saved report.',
    'Provider limit resets at 2030-01-01 00:00:00 UTC.',
    'A second result arrived.',
  ]);
  expect(projectEvents([limit]).messages[0]?.text).toContain('has not given a reset time');
});

test('a recovered result stays attributed to the selected task after both devices reload', () => {
  const session_id = 'saved-run';
  const id = 'a'.repeat(64);
  const base = { type: 'system', source: 'chat-recovery', session_id };
  const summary = {
    ...base,
    subtype: 'progress',
    interruptionKind: 'research',
    recoverableTasks: [{ id, name: 'Reading order' }],
  };
  const admitted = { ...base, subtype: 'admitted', recoveryId: id };
  const outcome = { ...base, subtype: 'outcome', recoveryId: id, state: 'completed' };
  const card = projectEvents([summary, admitted, outcome]).messages.find(
    (m) => m.notice === 'interruption',
  );
  expect(card?.researchActions).toEqual([
    { id, name: 'Reading order', resetAt: null, requested: true, outcome: 'completed' },
  ]);
  expect(
    projectEvents([summary, admitted, { ...outcome, session_id: 'other' }]).messages[0]
      ?.researchActions?.[0]?.outcome,
  ).toBeUndefined();
});
