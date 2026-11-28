export type ModelStep =
  | { text: string; tool?: undefined }
  | { text?: undefined; tool: { name: string; input: Record<string, unknown> } };

export const CONTINUE_PROMPT: string;
export const LOOP_DONE: string;
export const LOOP_SECOND_ROUND: string;
export const LOOP_NOTHING_SAVED: string;
export function loopPrompt(path: string): string;
export function loopStep(messages: readonly unknown[]): ModelStep | undefined;
