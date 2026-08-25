import {
  type CaveClient,
  type CaveManagedDiscoveredEndpoint,
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
} from '@opencoven/cave-client/managed';
import { nativeUnavailable } from './diagnostics';
import {
  createCaveManagedCredentialTransport,
  createCaveManagedDiscoveryBinding,
  invokeNative,
  type NativeSdkInvoke,
} from './native-boundary';

export type CaveConnectionHost = Readonly<{
  discover: () => Promise<
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

  return Object.freeze({
    discover: async () => {
      const binding = createCaveManagedDiscoveryBinding(invoke);
      const endpoint = await discoverManagedCaveEndpoint(binding.source);
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
      await invokeNative(invoke, 'cave_launch');
    },
    resetPairing: async () => {
      const handle = currentHandle;
      if (handle === undefined) {
        throw nativeUnavailable();
      }
      const result = await invokeNative(invoke, 'cave_reset_pairing', { handle });
      if (!isPairingResetResult(result)) {
        throw nativeUnavailable();
      }
      if (currentHandle === handle) {
        currentHandle = undefined;
      }
    },
  });
}
