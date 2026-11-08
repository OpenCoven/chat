export type BundlerTool = {
  name: string;
  repository: string;
  id: number;
  size: number;
  sha256: string;
};
export type AssetFetcher = (url: URL, options: RequestInit) => Promise<Response>;
export const TOOLS: Record<'apprun' | 'linuxdeploy' | 'wix', BundlerTool>;
export function downloadVerifiedTool(
  tool: BundlerTool,
  token: string | undefined,
  fetcher?: AssetFetcher,
): Promise<Buffer>;
export function prepareBundlerTools(options: {
  platform: NodeJS.Platform;
  cacheDir: string;
  token: string | undefined;
  fetcher?: AssetFetcher;
}): Promise<void>;
