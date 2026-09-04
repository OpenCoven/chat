import { describe, expect, it } from 'vitest';

import { FAM_CONVERSATIONS, FAM_MESSAGES } from '../demo/familiars-data';
import { MOCK_FAMILIARS } from '../demo/mock-familiars';
import { createMockFamiliarsSource } from './mock-source';
import type { QueryResult } from './source';

function unwrap<T>(result: QueryResult<T>): T {
  if (result.status !== 'ok') {
    throw new Error(`Expected an ok result, got ${result.status}.`);
  }
  return result.data;
}

describe('createMockFamiliarsSource', () => {
  it('lists every mock familiar as a summary', async () => {
    const source = createMockFamiliarsSource();
    const page = unwrap(await source.familiars());

    expect(page.data.map((familiar) => familiar.id)).toEqual(
      MOCK_FAMILIARS.map((familiar) => familiar.id),
    );
    expect(page.data[0]).toEqual({
      id: 'astra',
      name: 'Astra',
      role: 'Research and synthesis',
      description: MOCK_FAMILIARS[0]?.description,
      pronouns: 'she/her',
      status: 'available',
    });
  });

  it('resolves a known familiar detail with identity, ward, and a passing report', async () => {
    const source = createMockFamiliarsSource();
    const detail = unwrap(await source.familiar('astra'));

    expect(detail.id).toBe('astra');
    expect(detail.identity).toEqual({
      name: 'Astra',
      creature: 'Cartographer',
      person: 'Val Alexander',
    });
    expect(detail.ward?.approvalTiers.humanReview).toContain('publish a finding');
    expect(detail.report.pass).toBe(true);
    expect(detail.present).toEqual({ soul: true, identity: true, ward: true, memory: true });
  });

  it('reports memory absence as a failing contract property with a matching violation', async () => {
    const source = createMockFamiliarsSource();
    const detail = unwrap(await source.familiar('echo'));

    expect(detail.present.memory).toBe(false);
    expect(detail.report.pass).toBe(false);
    expect(
      detail.report.violations.some((violation) => violation.field === 'Persistent Memory'),
    ).toBe(true);
  });

  it('returns not_found for an unknown familiar id', async () => {
    const source = createMockFamiliarsSource();
    expect(await source.familiar('nonexistent')).toEqual({ status: 'error', code: 'not_found' });
  });

  it('derives a numeric activity view from the presentation-shaped mock data', async () => {
    const source = createMockFamiliarsSource({ now: () => new Date('2026-08-25T00:00:00.000Z') });
    const activity = unwrap(await source.activity('astra'));

    expect(activity.window).toBe('7d');
    expect(activity.completion).toBe(1);
    expect(activity.completed).toBe(13); // 12 completed + 1 held-for-you
    expect(activity.failed).toBe(0);
    expect(activity.calls).toBe(148);
    expect(activity.medianDurationMs).toBe(96_000); // "1m 36s"
    expect(activity.days).toHaveLength(7);
    expect(activity.days?.[6]?.date).toBe('2026-08-25');
    expect(activity.recent.length).toBeGreaterThan(0);
    expect(activity.recent[0]?.toolCalls).toBe(14);
  });

  it('returns not_found activity for a familiar id with no activity entry', async () => {
    const source = createMockFamiliarsSource();
    expect(await source.activity('nonexistent')).toEqual({ status: 'error', code: 'not_found' });
  });

  it('lists conversations with held mapped to pending and failed carried through', async () => {
    const source = createMockFamiliarsSource();
    const page = unwrap(await source.conversations());

    expect(page.data).toHaveLength(FAM_CONVERSATIONS.length);
    const pricing = page.data.find((conversation) => conversation.id === 'pricing');
    expect(pricing?.pending).toBe(true);
    expect(pricing?.failed).toBe(false);
    const flaky = page.data.find((conversation) => conversation.id === 'flaky');
    expect(flaky?.failed).toBe(true);
    expect(flaky?.pending).toBe(false);
  });

  it('drops reasoning, hold, image, and divider messages, keeping only user and familiar text', async () => {
    const source = createMockFamiliarsSource();
    const page = unwrap(await source.messages('pricing'));
    const sourceKinds = new Set(FAM_MESSAGES.pricing?.map((message) => message.kind));

    expect(sourceKinds.has('reasoning')).toBe(true); // the fixture actually exercises the drop
    expect(
      page.data.every((message) => message.role === 'user' || message.role === 'assistant'),
    ).toBe(true);
    expect(page.data.length).toBeLessThan(FAM_MESSAGES.pricing?.length ?? 0);
  });

  it('chains parentId across the filtered message list, not the original index', async () => {
    const source = createMockFamiliarsSource();
    const page = unwrap(await source.messages('pricing'));

    expect(page.data[0]?.parentId).toBeNull();
    for (let index = 1; index < page.data.length; index += 1) {
      expect(page.data[index]?.parentId).toBe(page.data[index - 1]?.id);
    }
  });

  it('returns not_found for an unknown conversation id', async () => {
    const source = createMockFamiliarsSource();
    expect(await source.messages('nonexistent')).toEqual({ status: 'error', code: 'not_found' });
  });

  it('advertises the Stage 1 capability set by default and honors an override', async () => {
    expect([...createMockFamiliarsSource().capabilities()].sort()).toEqual([
      'conversation-messages',
      'conversations',
      'familiar-analytics',
      'familiar-contract',
      'familiars',
    ]);
    const empty = createMockFamiliarsSource({ capabilities: new Set() });
    expect(empty.capabilities().size).toBe(0);
  });
});
