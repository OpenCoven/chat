import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveContractCanaryArtifactRoot } from '../scripts/contract-canary.mjs';

const root = resolve(process.cwd());

describe('contract canary artifact directory safety', () => {
  test.each(['.', root, '..', '/Users/buns', '../escape'])(
    'rejects unsafe artifact name %s',
    (artifactName) => {
      expect(() => resolveContractCanaryArtifactRoot(artifactName)).toThrow(
        /safe child name|Artifact cleanup path must stay inside/,
      );
    },
  );

  test('accepts a confined artifact child name', () => {
    expect(resolveContractCanaryArtifactRoot('local-run')).toBe(
      resolve(root, '.artifacts', 'contract-canary', 'local-run'),
    );
  });
});
