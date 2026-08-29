import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  APPROVED_PHASE1_DIAGNOSTIC_IDS,
  REQUIRED_PHASE1_ASSERTION_IDS,
  scanPhase1Artifacts,
} from '../scripts/phase1-artifact-secret-scan.mjs';
import {
  createProcessOwnedArtifactRoot,
  type ProcessOwnedArtifactRoot,
} from '../scripts/process-owned-artifact-root.mjs';

const activeRoots = new Set<ProcessOwnedArtifactRoot>();

afterEach(async () => {
  for (const root of activeRoots) {
    await root.cleanup().catch(() => undefined);
  }
  activeRoots.clear();
});

function createRoot() {
  const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-secret-scan' });
  activeRoots.add(root);
  return root;
}

function validReport() {
  return {
    schemaVersion: 1,
    completed: true,
    status: 'passed',
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    versions: {
      node: process.versions.node,
      harness: '1.0.0',
    },
    revisions: {
      chat: '0021d30d0cddc5d3f00a41c55d025cf3ce4611c5',
      sdk: '163961f4e59cfdef51d2271fa98e7c514977203f',
      cave: '061ddca45ab00028ecc0335face6239e5553f24a',
      coven: '721437b84026c042e431b0882dcd14fdb29ac07d',
    },
    artifactDigests: {
      'chat-bundle': 'a'.repeat(64),
      'sdk-core': 'b'.repeat(64),
    },
    assertions: REQUIRED_PHASE1_ASSERTION_IDS.map((id) => ({
      id,
      status: 'passed',
      diagnosticIds: ['phase1.assertion.passed'],
    })),
    summary: {
      required: REQUIRED_PHASE1_ASSERTION_IDS.length,
      passed: REQUIRED_PHASE1_ASSERTION_IDS.length,
      failed: 0,
      blocked: 0,
      skipped: 0,
    },
    diagnosticIds: ['phase1.conformance.passed'],
  };
}

function assertionAt(report: ReturnType<typeof validReport>, index: number) {
  const assertion = report.assertions[index];
  if (assertion === undefined) {
    throw new Error(`missing test assertion at index ${index}`);
  }
  return assertion;
}

async function scanReport(report: unknown) {
  const root = createRoot();
  writeFileSync(resolve(root.rootPath, 'report.json'), `${JSON.stringify(report)}\n`);
  return scanPhase1Artifacts({ artifactRoot: root.rootPath });
}

describe('Phase 1 retained-artifact secret scan', () => {
  test('accepts only the approved secret-free report schema', async () => {
    expect(APPROVED_PHASE1_DIAGNOSTIC_IDS).toContain('phase1.conformance.passed');
    const result = await scanReport(validReport());

    expect(result).toEqual({
      filesScanned: 1,
      bytesScanned: expect.any(Number),
      reportCount: 1,
    });
  });

  test.each([
    ['pairing secret', { pairingSecret: 'pairing-secret-value' }],
    ['bearer', { bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-value' }],
    ['authorization header', { Authorization: 'Bearer secret-value' }],
    ['raw keychain value', { rawKeychainValue: 'keychain-secret-value' }],
    ['protected request plaintext', { protectedRequestPlaintext: '{"secret":true}' }],
    ['protected response plaintext', { protectedResponsePlaintext: '{"message":"private"}' }],
    ['user prompt', { prompt: 'private user prompt' }],
    ['message body', { messageBody: 'private conversation content' }],
    ['attachment', { attachment: 'private-document.pdf' }],
    ['private macOS path', { diagnostic: '/Users/private-user/Library/Keychains/login.keychain' }],
    ['private Linux path', { diagnostic: '/home/private-user/.config/opencoven' }],
    ['socket handle', { socketPath: '/private/var/folders/secret/cave.sock' }],
  ])('rejects %s content', async (_label, leak) => {
    await expect(scanReport({ ...validReport(), leak })).rejects.toThrow(
      /prohibited secret or private content/,
    );
  });

  test('rejects unknown fields even when their values do not look secret', async () => {
    await expect(scanReport({ ...validReport(), note: 'ordinary-looking text' })).rejects.toThrow(
      /approved report schema/,
    );
  });

  test('rejects unknown assertion and diagnostic identifiers', async () => {
    const unknownAssertion = validReport();
    unknownAssertion.assertions[0] = {
      ...assertionAt(unknownAssertion, 0),
      id: 'phase1.unknown.assertion',
    };
    await expect(scanReport(unknownAssertion)).rejects.toThrow(/approved assertion ID/);

    const unknownDiagnostic = validReport();
    unknownDiagnostic.diagnosticIds = ['phase1.unknown.diagnostic'];
    await expect(scanReport(unknownDiagnostic)).rejects.toThrow(/approved diagnostic ID/);
  });

  test('rejects duplicate or missing assertion identifiers', async () => {
    const duplicate = validReport();
    duplicate.assertions[1] = {
      ...assertionAt(duplicate, 1),
      id: assertionAt(duplicate, 0).id,
    };
    await expect(scanReport(duplicate)).rejects.toThrow(/exact required assertion set/);

    const missing = validReport();
    missing.assertions.pop();
    await expect(scanReport(missing)).rejects.toThrow(/exact required assertion set/);
  });

  test('rejects skipped assertions and inconsistent summary counts', async () => {
    const skipped = validReport();
    skipped.assertions[0] = {
      ...assertionAt(skipped, 0),
      status: 'skipped' as never,
    };
    await expect(scanReport(skipped)).rejects.toThrow(/approved pass-fail status/);

    const inconsistent = validReport();
    inconsistent.summary.passed -= 1;
    inconsistent.summary.failed += 1;
    await expect(scanReport(inconsistent)).rejects.toThrow(/summary does not match/);
  });

  test('rejects non-JSON artifacts and artifact symlinks without following them', async () => {
    const nonJsonRoot = createRoot();
    writeFileSync(resolve(nonJsonRoot.rootPath, 'debug.log'), 'secret-free but unapproved\n');
    await expect(scanPhase1Artifacts({ artifactRoot: nonJsonRoot.rootPath })).rejects.toThrow(
      /only JSON artifacts/,
    );

    const symlinkRoot = createRoot();
    const outsideDirectory = resolve(symlinkRoot.rootPath, 'outside');
    mkdirSync(outsideDirectory);
    writeFileSync(resolve(outsideDirectory, 'report.json'), `${JSON.stringify(validReport())}\n`);
    symlinkSync(outsideDirectory, resolve(symlinkRoot.rootPath, 'report-link'));
    await expect(scanPhase1Artifacts({ artifactRoot: symlinkRoot.rootPath })).rejects.toThrow(
      /must not contain symlinks/,
    );
  });

  test('rejects oversized artifacts before parsing them', async () => {
    const root = createRoot();
    writeFileSync(resolve(root.rootPath, 'report.json'), 'x'.repeat(1_048_577));
    await expect(scanPhase1Artifacts({ artifactRoot: root.rootPath })).rejects.toThrow(
      /size limits/,
    );
  });
});
