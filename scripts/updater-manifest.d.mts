export type UpdaterManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

export function buildUpdaterManifest(options: {
  releaseDir: string;
  version: string;
  tag: string;
  repo: string;
  notes: string;
  pubDate: string;
}): UpdaterManifest;
