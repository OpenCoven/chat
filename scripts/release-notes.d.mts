export const NOTES_DIR: string;
export const INDEX: string;
export const COMPARE_URL: string;
export const HISTORICAL: readonly string[];

export type ReleaseNotesProblem = Readonly<{
  file: string;
  problem: string;
}>;

export function compareTags(a: string, b: string): number;
export function listNotes(root?: string): string[];
export function previousTag(tag: string, tags: readonly string[]): string | null;
export function changelogLine(previous: string, tag: string): string;
export function checkNotes(
  tag: string,
  markdown: string,
  context: Readonly<{ previous: string | null; index: string }>,
): string[];
export function checkReleaseNotes(root?: string, tag?: string): ReleaseNotesProblem[];
