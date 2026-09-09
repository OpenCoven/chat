import type {
  CaveExecutionAttempt,
  CaveExecutionWindow,
  CaveFamiliarAnalytics,
  CaveFamiliarContract,
} from '@opencoven/cave-client';
import type {
  CaveCanonicalFamiliar,
  CaveConversation,
  CaveConversationMessage,
} from '@opencoven/cave-client/managed';
import { describe, expect, it } from 'vitest';

import {
  mapConversationSummary,
  mapFamiliarActivity,
  mapFamiliarDetail,
  mapFamiliarSummary,
  mapThreadMessage,
} from './mappers';

describe('mapFamiliarSummary', () => {
  it('renames displayName to name and passes optional fields through', () => {
    const familiar: CaveCanonicalFamiliar = {
      id: 'astra',
      displayName: 'Astra',
      role: 'Research and synthesis',
      description: 'Reads widely.',
      pronouns: 'she/her',
      status: 'working',
    };

    expect(mapFamiliarSummary(familiar)).toEqual({
      id: 'astra',
      name: 'Astra',
      role: 'Research and synthesis',
      description: 'Reads widely.',
      pronouns: 'she/her',
      status: 'working',
    });
  });

  it('defaults an unrecognized or missing status to offline, and omits absent optional fields', () => {
    const bare: CaveCanonicalFamiliar = { id: 'astra', displayName: 'Astra', role: 'Guide' };

    expect(mapFamiliarSummary(bare)).toEqual({
      id: 'astra',
      name: 'Astra',
      role: 'Guide',
      status: 'offline',
    });
    expect(mapFamiliarSummary({ ...bare, status: 'unknown-future-value' })).toMatchObject({
      status: 'offline',
    });
  });
});

describe('mapFamiliarDetail', () => {
  const contract: CaveFamiliarContract = {
    id: 'astra',
    workspace: '/workspace/astra',
    present: { soul: true, identity: true, ward: true, memory: true },
    identity: { name: 'Astra', creature: 'Cartographer', person: 'Val Alexander' },
    ward: {
      version: '0.3.1',
      protectedFiles: ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'ward.toml'],
      invariants: ['familiar.name', 'familiar.person'],
      editablePaths: ['TOOLS.md', 'notes/'],
      approvalTiers: { auto: ['read files'], humanReview: ['publish a finding'] },
    },
    report: {
      specVersion: '0.1.0',
      pass: true,
      properties: [{ property: 'Named Identity', pass: true }],
      violations: [],
      warnings: [{ file: 'MEMORY.md', field: 'entries', message: 'No memory yet.' }],
    },
  };

  it('maps identity, ward, and the contract report field-for-field', () => {
    expect(mapFamiliarDetail(contract)).toEqual({
      id: 'astra',
      workspace: '/workspace/astra',
      present: { soul: true, identity: true, ward: true, memory: true },
      identity: { name: 'Astra', creature: 'Cartographer', person: 'Val Alexander' },
      ward: {
        version: '0.3.1',
        protectedFiles: ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'ward.toml'],
        invariants: ['familiar.name', 'familiar.person'],
        editablePaths: ['TOOLS.md', 'notes/'],
        approvalTiers: { auto: ['read files'], humanReview: ['publish a finding'] },
      },
      report: contract.report,
    });
  });

  it('omits identity and ward when Cave withholds or lacks them', () => {
    const minimal: CaveFamiliarContract = {
      id: 'echo',
      present: { soul: true, identity: true, ward: false, memory: false },
      report: { specVersion: '0.1.0', pass: false, properties: [], violations: [], warnings: [] },
    };

    const detail = mapFamiliarDetail(minimal);
    expect(detail.identity).toBeUndefined();
    expect(detail.ward).toBeUndefined();
    expect(detail.workspace).toBeUndefined();
    expect(detail.present).toEqual({ soul: true, identity: true, ward: false, memory: false });
  });
});

function executionAttempt(overrides: Partial<CaveExecutionAttempt> = {}): CaveExecutionAttempt {
  return {
    id: 'attempt-1',
    executionKind: 'run',
    occurredAt: '2026-08-25T00:00:00.000Z',
    harnessId: 'claude-code',
    status: 'completed',
    toolCalls: 14,
    toolFailures: 0,
    ...overrides,
  };
}

function executionWindow(overrides: Partial<CaveExecutionWindow> = {}): CaveExecutionWindow {
  return {
    attempts: 12,
    completed: 12,
    failed: 0,
    cancelled: 0,
    successRate: 1,
    medianDurationMs: 96_000,
    p95DurationMs: 168_000,
    toolCalls: 148,
    toolFailures: 2,
    models: [],
    harnesses: [
      {
        key: 'files.read',
        attempts: 58,
        completed: 58,
        failed: 0,
        cancelled: 0,
        successRate: 1,
        toolCalls: 58,
        toolFailures: 0,
      },
      {
        key: 'web.fetch',
        label: 'web.fetch',
        attempts: 22,
        completed: 20,
        failed: 2,
        cancelled: 0,
        successRate: 0.9,
        toolCalls: 22,
        toolFailures: 2,
      },
    ],
    coverage: {},
    days: [{ date: '2026-08-24', completed: 3, failed: 1, cancelled: 0 }],
    ...overrides,
  };
}

describe('mapFamiliarActivity', () => {
  it('renames the window fields the plan specifies and maps harnesses to tool usage', () => {
    const analytics: CaveFamiliarAnalytics = {
      generatedAt: '2026-08-25T00:00:00.000Z',
      windows: { '7d': executionWindow() },
      recentAttempts: [
        executionAttempt(),
        executionAttempt({ id: 'attempt-2', status: 'failed', toolFailures: 1 }),
      ],
      backfill: { state: 'complete', imported: 12 },
    };

    expect(mapFamiliarActivity(analytics, '7d')).toEqual({
      window: '7d',
      generatedAt: '2026-08-25T00:00:00.000Z',
      attempts: 12,
      completed: 12,
      failed: 0,
      cancelled: 0,
      completion: 1,
      medianDurationMs: 96_000,
      p95DurationMs: 168_000,
      calls: 148,
      callFailures: 2,
      tools: [
        { name: 'files.read', calls: 58, failed: 0 },
        { name: 'web.fetch', calls: 22, failed: 2 },
      ],
      days: [{ date: '2026-08-24', completed: 3, failed: 1, cancelled: 0 }],
      recent: [
        {
          id: 'attempt-1',
          occurredAt: '2026-08-25T00:00:00.000Z',
          harnessId: 'claude-code',
          status: 'completed',
          toolCalls: 14,
          toolFailures: 0,
        },
        {
          id: 'attempt-2',
          occurredAt: '2026-08-25T00:00:00.000Z',
          harnessId: 'claude-code',
          status: 'failed',
          toolCalls: 14,
          toolFailures: 1,
        },
      ],
      backfillState: 'complete',
    });
  });

  it('omits days on a window that does not carry the runs-per-day series', () => {
    const { days: _days, ...windowWithoutDays } = executionWindow();
    const analytics: CaveFamiliarAnalytics = {
      generatedAt: '2026-08-25T00:00:00.000Z',
      windows: { all: windowWithoutDays },
      recentAttempts: [],
      backfill: { state: 'partial', imported: 40, remaining: 8 },
    };

    expect(mapFamiliarActivity(analytics, 'all')?.days).toBeUndefined();
  });

  it('returns undefined when Cave did not serve the requested window', () => {
    const analytics: CaveFamiliarAnalytics = {
      generatedAt: '2026-08-25T00:00:00.000Z',
      windows: { '7d': executionWindow() },
      recentAttempts: [],
      backfill: { state: 'not-started', imported: 0 },
    };

    expect(mapFamiliarActivity(analytics, '14d')).toBeUndefined();
  });

  it('carries a null completion rate through rather than coercing it to zero', () => {
    const analytics: CaveFamiliarAnalytics = {
      generatedAt: '2026-08-25T00:00:00.000Z',
      windows: {
        '7d': executionWindow({ attempts: 0, completed: 0, failed: 0, successRate: null }),
      },
      recentAttempts: [],
      backfill: { state: 'complete', imported: 0 },
    };

    expect(mapFamiliarActivity(analytics, '7d')?.completion).toBeNull();
  });
});

describe('mapConversationSummary', () => {
  it('derives failed from status and treats a nonzero exit code as failed even with no status', () => {
    const base: CaveConversation = {
      id: 'c1',
      familiarId: 'astra',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    expect(mapConversationSummary(base).failed).toBe(false);
    expect(mapConversationSummary({ ...base, status: 'failed' }).failed).toBe(true);
    expect(mapConversationSummary({ ...base, status: 'error' }).failed).toBe(true);
    expect(mapConversationSummary({ ...base, exitCode: 1 }).failed).toBe(true);
    expect(mapConversationSummary({ ...base, exitCode: 0 }).failed).toBe(false);
    expect(mapConversationSummary({ ...base, exitCode: null }).failed).toBe(false);
  });

  it('maps pending straight through and omits title when Cave omits it', () => {
    const conversation: CaveConversation = {
      id: 'c1',
      familiarId: 'astra',
      title: 'Q3 pricing evidence map',
      updatedAt: '2026-08-25T00:00:00.000Z',
      pending: true,
    };

    expect(mapConversationSummary(conversation)).toEqual({
      id: 'c1',
      familiarId: 'astra',
      title: 'Q3 pricing evidence map',
      updatedAt: '2026-08-25T00:00:00.000Z',
      failed: false,
      pending: true,
    });
    expect(
      mapConversationSummary({
        id: 'c1',
        familiarId: 'astra',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }).title,
    ).toBeUndefined();
  });
});

describe('mapThreadMessage', () => {
  it('maps every field, defaulting isError and cancelled to false', () => {
    const message: CaveConversationMessage = {
      id: 'm1',
      conversationId: 'c1',
      parentId: null,
      role: 'assistant',
      text: 'On it.',
      createdAt: '2026-08-25T00:00:00.000Z',
      attachmentCount: 0,
      toolCount: 3,
    };

    expect(mapThreadMessage(message)).toEqual({
      id: 'm1',
      conversationId: 'c1',
      parentId: null,
      role: 'assistant',
      text: 'On it.',
      createdAt: '2026-08-25T00:00:00.000Z',
      attachmentCount: 0,
      toolCount: 3,
      isError: false,
      cancelled: false,
    });
  });

  it('carries isError and cancelled through when Cave sets them', () => {
    const message: CaveConversationMessage = {
      id: 'm2',
      conversationId: 'c1',
      parentId: 'm1',
      role: 'assistant',
      text: '',
      createdAt: '2026-08-25T00:00:00.000Z',
      attachmentCount: 0,
      toolCount: 0,
      isError: true,
      cancelled: true,
    };

    expect(mapThreadMessage(message)).toMatchObject({
      isError: true,
      cancelled: true,
      parentId: 'm1',
    });
  });
});
