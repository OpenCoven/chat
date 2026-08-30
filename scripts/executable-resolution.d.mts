export function resolveExecutableInvocation(
  command: string,
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  args?: readonly string[],
): Readonly<{
  executable: string;
  args: readonly string[];
  resolvedCommand: string;
}>;
export function quoteWindowsBatchCommand(batchPath: string, args: readonly string[]): string;
export function normalizeWindowsRealPathForProcess(path: string): string;
