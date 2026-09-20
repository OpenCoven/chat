export type AuthorityDrift = {
  group: 'files' | 'productionDeltas';
  path: string;
  pinned: string | null;
  shipped: string | null;
};

export type AuthorityFreshness = {
  revision: string;
  ref: string;
  reachable: boolean;
  adrift: AuthorityDrift[];
  failures: string[];
};

export function checkAuthorityFreshness(ref?: string, repositoryRoot?: string): AuthorityFreshness;
