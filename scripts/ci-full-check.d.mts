export declare const ciFullLabel: string;
export declare const ciFullJobs: readonly string[];
export declare const ciFullRules: readonly { pattern: RegExp; why: string }[];
export declare function governedPaths(lockText: string): string[];
export declare function pathsNeedingCiFull(
  paths: readonly string[],
  governed?: readonly string[],
): { path: string; why: string }[];
export declare function checkCiFull(
  paths: readonly string[],
  labels: readonly string[],
  governed?: readonly string[],
): { status: 0 | 1; message: string };
