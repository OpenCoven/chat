import {
  type CaveClient,
  type CaveManagedDiscoveredEndpoint,
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
} from '@opencoven/cave-client/managed';

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
}>;

export function createCaveConnectionHost(invoke: NativeSdkInvoke): CaveConnectionHost {
  return Object.freeze({
    discover: async () => {
      const binding = createCaveManagedDiscoveryBinding(invoke);
      const endpoint = await discoverManagedCaveEndpoint(binding.source);
      const handle = binding.takeHandle();

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
  });
}
