// @vitest-environment node
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as ownedTemp from '../scripts/owned-temp-directory.mjs';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
} from '../scripts/phase1-conformance.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

const fault = vi.hoisted(() => ({ operation: '', renamed: false }));
const privateFailure = vi.hoisted(() => new Error('private-path-canary PID-987654 native-message'));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.operation === 'root-rename') throw privateFailure;
      fs.renameSync(...args);
      fault.renamed = true;
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (fault.operation === 'root-precondition' && !fault.renamed) throw privateFailure;
      if (fault.operation === 'root-postrename' && fault.renamed) throw privateFailure;
      if (fault.operation === 'entry-stat' && String(args[0]).endsWith('diagnostic-leaf')) {
        throw privateFailure;
      }
      return fs.lstatSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (fault.operation === 'leaf-remove') throw privateFailure;
      return fs.unlinkSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (fault.operation === 'directory-enumerate') throw privateFailure;
      return fs.readdirSync(...args);
    },
    rmdirSync: (...args: Parameters<typeof fs.rmdirSync>) => {
      if (fault.operation === 'directory-remove') throw privateFailure;
      return fs.rmdirSync(...args);
    },
  };
});

const roots: ReturnType<typeof ownedTemp.createOwnedTempDirectory>[] = [];
afterEach(() => {
  fault.operation = '';
  fault.renamed = false;
  for (const root of roots.splice(0)) {
    rmSync(root.rootPath, { recursive: true, force: true });
    for (const entry of readdirSync(root.parentPath)) {
      if (entry.startsWith(`${basename(root.rootPath)}.deleting-`)) {
        rmSync(resolve(root.parentPath, entry), { recursive: true, force: true });
      }
    }
  }
});

function classify(error: unknown) {
  const classifier = Reflect.get(ownedTemp, 'ownedTempCleanupFailureCategory');
  return typeof classifier === 'function' ? classifier(error) : undefined;
}

test.each([
  'root-precondition',
  'root-rename',
  'root-postrename',
  'entry-stat',
  'leaf-remove',
  'directory-enumerate',
  'directory-remove',
])('classifies the actual %s failure without publishing native details', (operation) => {
  const root = ownedTemp.createOwnedTempDirectory({ prefix: 'cleanup-diagnostic-test' });
  roots.push(root);
  writeFileSync(resolve(root.rootPath, 'diagnostic-leaf'), 'test');
  fault.operation = operation;
  let caught: unknown;
  try {
    ownedTemp.cleanupOwnedTempRoot(root);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(privateFailure);
  expect(classify(caught)).toBe(operation);
  const diagnostic = producer.schemaV2FailureDiagnostic(
    caught,
    'phase1.stage.execution-root-cleanup.failed',
  );
  expect(diagnostic).toBe(`phase1.stage.execution-root-cleanup.${operation}`);
  expect(publicPhase1FailureDiagnostic(new Error(diagnostic, { cause: caught }))).toBe(diagnostic);
  expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
  expect(classify(caught)).not.toMatch(/canary|987654|native-message/);
});

test('does not accept forged public categories, messages or aggregate causes', () => {
  const forged = Object.assign(new Error('root-rename'), { category: 'root-rename' });
  for (const error of [
    forged,
    new AggregateError([forged]),
    { cause: forged },
    null,
    'root-rename',
  ]) {
    expect(classify(error)).toBe('unknown');
  }
});

test('successful cleanup still removes the owned root', () => {
  const root = ownedTemp.createOwnedTempDirectory({ prefix: 'cleanup-diagnostic-test' });
  roots.push(root);
  ownedTemp.cleanupOwnedTempRoot(root);
  expect(existsSync(root.rootPath)).toBe(false);
});
