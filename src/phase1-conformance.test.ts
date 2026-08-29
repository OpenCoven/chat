import { describe, expect, test } from 'vitest';

import { REQUIRED_PHASE1_ASSERTION_IDS } from '../scripts/phase1-artifact-secret-scan.mjs';
import {
  assertExactAssertionResults,
  assertPairingStatus,
  buildPhase1Report,
  parseArgs,
  parseCaveConformanceOutput,
} from '../scripts/phase1-conformance.mjs';

function passingAssertions(): Array<{
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  diagnosticIds: string[];
}> {
  return REQUIRED_PHASE1_ASSERTION_IDS.map((id) => ({
    id,
    status: 'passed' as const,
    diagnosticIds: ['phase1.assertion.passed'],
  }));
}

function assertionAt(assertions: ReturnType<typeof passingAssertions>, index: number) {
  const assertion = assertions[index];
  if (assertion === undefined) {
    throw new Error(`missing test assertion at index ${index}`);
  }
  return assertion;
}

describe('Phase 1 real-authority conformance harness', () => {
  test('requires every assertion ID exactly once with no skipped result', () => {
    const assertions = passingAssertions();
    expect(assertExactAssertionResults(assertions)).toEqual(assertions);

    expect(() => assertExactAssertionResults(assertions.slice(1))).toThrow(
      /missing required assertion ID/,
    );
    expect(() => assertExactAssertionResults([...assertions, assertionAt(assertions, 0)])).toThrow(
      /duplicate assertion ID/,
    );
    expect(() =>
      assertExactAssertionResults([
        ...assertions.slice(1),
        {
          id: 'phase1.unexpected',
          status: 'passed',
          diagnosticIds: ['phase1.assertion.passed'],
        },
      ]),
    ).toThrow(/unexpected assertion ID/);
    expect(() =>
      assertExactAssertionResults([
        { ...assertionAt(assertions, 0), status: 'skipped' as never },
        ...assertions.slice(1),
      ]),
    ).toThrow(/skipped assertion/);
  });

  test('builds the approved sanitized report and derives a blocked summary', () => {
    const assertions = passingAssertions();
    assertions[8] = {
      ...assertionAt(assertions, 8),
      status: 'blocked',
      diagnosticIds: ['phase1.producer.compatibility-control-unavailable'],
    };

    const report = buildPhase1Report({
      assertions,
      revisions: {
        chat: '0'.repeat(40),
        sdk: '1'.repeat(40),
        cave: '2'.repeat(40),
        coven: '3'.repeat(40),
      },
      artifactDigests: {
        'chat-native-rpc': 'a'.repeat(64),
      },
      versions: {
        harness: '1.0.0',
        node: process.versions.node,
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.completed).toBe(true);
    expect(report.summary).toEqual({
      required: REQUIRED_PHASE1_ASSERTION_IDS.length,
      passed: REQUIRED_PHASE1_ASSERTION_IDS.length - 1,
      failed: 0,
      blocked: 1,
      skipped: 0,
    });
    expect(report.diagnosticIds).toEqual(['phase1.conformance.blocked']);
  });

  test('parses only the complete all-scenario command line', () => {
    expect(
      parseArgs([
        '--lock',
        './phase1-conformance.lock.json',
        '--scenario',
        'all',
        '--retain-sanitized-report',
        './test-results/phase1-conformance/report.json',
      ]),
    ).toMatchObject({
      scenario: 'all',
      lockPath: expect.stringContaining('phase1-conformance.lock.json'),
      retainSanitizedReport: expect.stringContaining('report.json'),
    });

    expect(() => parseArgs(['--scenario', 'pairing-only'])).toThrow(
      /only --scenario all is supported/,
    );
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown option/);
  });

  test('parses Cave assertion output without retaining diagnostic prose', () => {
    const parsed = parseCaveConformanceOutput(
      [
        'client-v1-conformance: phase B on http://127.0.0.1:54321',
        'ok pairing.poll-pending — private detail omitted by the caller',
        'ok pairing.admin-approve',
        'FAIL pairing.exchange — response included sensitive prose',
        'skip reads.messages-canonical-conversation-id — platform condition',
      ].join('\n'),
    );

    expect(parsed.get('pairing.poll-pending')).toBe('passed');
    expect(parsed.get('pairing.admin-approve')).toBe('passed');
    expect(parsed.get('pairing.exchange')).toBe('failed');
    expect(parsed.get('reads.messages-canonical-conversation-id')).toBe('skipped');
    expect([...parsed.keys()].join(' ')).not.toContain('private detail');
  });

  test('accepts pairing denial as a successful status envelope', () => {
    expect(assertPairingStatus({ status: 'denied' }, 'denied')).toEqual({ status: 'denied' });
    expect(() => assertPairingStatus({ status: 'pending' }, 'denied')).toThrow(
      /pairing status was pending instead of denied/,
    );
  });
});
