export function readContractCanaryLock(lockPath?: string): {
  path: string;
  sdk: { repository: string; revision: string };
  cave: { repository: string; revision: string };
};
export function assertContractCanaryCheckoutHeads(
  lock: {
    sdk: { repository: string; revision: string };
    cave: { repository: string; revision: string };
  },
  options: { sdkRoot: string; caveRoot: string },
): { sdkHead: string; caveHead: string };
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
};
export function main(argv?: string[]): void;
