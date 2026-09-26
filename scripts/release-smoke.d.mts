export const PRODUCT_NAME: 'OpenCoven Chat';
export const IDENTIFIER: 'ai.opencoven.chat';

export function expectedInstallers(version: string, product?: string): string[];
export function expectedUpdaterArchives(version: string, product?: string): Map<string, string>;
export function parseChecksums(text: string): { entries: Map<string, string>; problems: string[] };

export type ReleaseSmokeReport = {
  ok: boolean;
  failures: string[];
  version: string;
  installers: string[];
  updater:
    | { state: 'enabled'; archives: string[]; manifest: boolean }
    | { state: 'disabled'; reason: string };
  signing: { state: 'unsigned' | 'required'; reason: string };
};

export function smokeTestRelease(options: {
  releaseDir: string;
  root: string;
  version: string;
  tag?: string;
  allowUnsigned?: boolean;
}): ReleaseSmokeReport;
