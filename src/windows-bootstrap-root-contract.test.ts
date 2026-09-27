import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(root, '.github/workflows/client-v1-conformance.yml'), 'utf8');
const assignment = '$bootstrapRoot = Join-Path $runnerTemp "oc$($nonce.Substring(0, 8))"';

// The producer's executable binding tests cover nonce validation. Pin the
// independently implemented PowerShell expression too, without changing the
// frozen workflow, producer bytes, or content-PR/repin boundary.
function requireBootstrapBinding(source: string): void {
  const assignments = source
    .split(/\r?\n/u)
    .filter((line) => /^\s*\$bootstrapRoot\s*=\s*Join-Path\b/u.test(line))
    .map((line) => line.trim());
  expect(assignments).toEqual([assignment]);
}

test('Windows bootstrap uses the exact producer-bound short root', () => {
  requireBootstrapBinding(workflow);
});

test.each([
  ['legacy prefix', '$bootstrapRoot = Join-Path $runnerTemp "opencoven-win32-$nonce"'],
  ['wrong prefix', assignment.replace('oc$(', 'xx$(')],
  ['wrong slice start', assignment.replace('Substring(0, 8)', 'Substring(1, 8)')],
  ['wrong slice length', assignment.replace('Substring(0, 8)', 'Substring(0, 9)')],
  ['wrong nonce', assignment.replace('$nonce.', '$otherNonce.')],
  ['missing assignment', `# ${assignment}`],
  ['duplicate assignment', `${assignment}\n${assignment}`],
])('rejects bootstrap binding drift: %s', (_name, mutation) => {
  const changed = workflow.replace(assignment, () => mutation);
  expect(changed).not.toBe(workflow);
  expect(() => requireBootstrapBinding(changed)).toThrow();
});
