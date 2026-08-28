import {
  type CaveClient,
  type CaveManagedDiscoveredEndpoint,
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
} from '@opencoven/cave-client/managed';
import type { OperationOptions } from '@opencoven/sdk-core/browser';

import { nativeUnavailable } from './diagnostics';
import {
  createCaveManagedCredentialTransport,
  createCaveManagedDiscoveryBinding,
  invokeNative,
  type NativeSdkInvoke,
} from './native-boundary';

export type CaveConnectionHost = Readonly<{
  discover: (options?: OperationOptions) => Promise<
    Readonly<{
      endpoint: CaveManagedDiscoveredEndpoint;
      client: CaveClient;
    }>
  >;
  launch: () => Promise<void>;
  resetPairing: () => Promise<void>;
}>;

function isPairingResetResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 1 && result.status === 'invalidated';
}

export function createCaveConnectionHost(invoke: NativeSdkInvoke): CaveConnectionHost {
  let currentHandle: string | undefined;
  let discoveryGeneration = 0;

  return Object.freeze({
    discover: async (options = {}) => {
      const generation = discoveryGeneration + 1;
      discoveryGeneration = generation;
      currentHandle = undefined;
      const binding = createCaveManagedDiscoveryBinding(invoke);
      const endpoint = await discoverManagedCaveEndpoint(binding.source, options);
      if (generation !== discoveryGeneration) {
        throw nativeUnavailable();
      }
      const handle = binding.takeHandle();
      currentHandle = handle;

      return Object.freeze({
        endpoint,
        client: createManagedCaveClient({
          transport: createCaveManagedCredentialTransport(invoke, handle),
        }),
      });
    },
    launch: async () => {
      discoveryGeneration += 1;
      currentHandle = undefined;
      await invokeNative(invoke, 'cave_launch');
    },
    resetPairing: async () => {
      const handle = currentHandle;
      if (handle === undefined) {
        throw nativeUnavailable();
      }
      discoveryGeneration += 1;
      currentHandle = undefined;
      const result = await invokeNative(invoke, 'cave_reset_pairing', { handle });
      if (!isPairingResetResult(result)) {
        throw nativeUnavailable();
      }
    },
  });
}
