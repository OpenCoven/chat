import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
} from '@opencoven/cave-client/managed';

import lock from '../contract-canary.lock.json';

describe('packed SDK runtime dependency', () => {
  it.each([
    ['@opencoven/sdk-core', 'vendor/sdk/opencoven-sdk-core-0.1.0.tgz'],
    ['@opencoven/cave-client', 'vendor/sdk/opencoven-cave-client-0.1.0.tgz'],
  ] as const)('pins %s to the locked tarball bytes', (packageName, relativePath) => {
    const expected = lock.sdk.packages.find(({ name }) => name === packageName);
    const bytes = readFileSync(resolve(process.cwd(), relativePath));

    expect(expected).toBeDefined();
    expect(bytes.byteLength).toBe(expected?.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected?.sha256);
  });

  it('loads the browser-safe managed parser and orchestrator exports', () => {
    expect(createManagedCaveClient).toBeTypeOf('function');
    expect(discoverManagedCaveEndpoint).toBeTypeOf('function');
  });
});
