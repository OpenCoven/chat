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
  cancelPairing: (requestId: string) => Promise<void>;
}>;

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
    cancelPairing: async (requestId) => {
      const handle = currentHandle;
      if (handle === undefined) {
        throw nativeUnavailable();
      }
      await invokeNative(invoke, 'cave_cancel_pairing', { handle, requestId });
    },
  });
}
