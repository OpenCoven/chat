import {
  type CaveClient,
  type CaveManagedDiscoveredEndpoint,
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
} from '@opencoven/cave-client/managed';

import {
  createCaveManagedCredentialTransport,
  createCaveManagedDiscoverySource,
  invokeNative,
  type NativeSdkInvoke,
} from './native-boundary';

export type CaveConnectionHost = Readonly<{
  client: CaveClient;
  discover: () => Promise<CaveManagedDiscoveredEndpoint>;
  launch: () => Promise<void>;
}>;

export function createCaveConnectionHost(invoke: NativeSdkInvoke): CaveConnectionHost {
  const discovery = createCaveManagedDiscoverySource(invoke);

  return Object.freeze({
    client: createManagedCaveClient({
      transport: createCaveManagedCredentialTransport(invoke),
    }),
    discover: () => discoverManagedCaveEndpoint(discovery),
    launch: async () => {
      await invokeNative(invoke, 'cave_launch');
    },
  });
}
