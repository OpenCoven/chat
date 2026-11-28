import { describe, expect, it } from 'vitest';
import {
  CONTINUE_PROMPT,
  LOOP_DONE,
  LOOP_NOTHING_SAVED,
  LOOP_SECOND_ROUND,
  loopPrompt,
  loopStep,
} from '../scripts/packaged-acceptance/model-fixture.mjs';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const toolResult = { role: 'user', content: [{ type: 'tool_result', content: 'one round\n' }] };
const toolUse = { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] };

describe('the packaged run-budget fixture', () => {
  const proof = '/tmp/chat run budget/one-round.txt';
  const first = [user(loopPrompt(proof))];

  it('asks for one real Read, so finishing needs a second round', () => {
    expect(loopStep(first)).toEqual({ tool: { name: 'Read', input: { file_path: proof } } });
    expect(loopStep([...first, toolUse, toolResult])).toEqual({ text: LOOP_SECOND_ROUND });
  });

  it('finishes a continuation only when the saved tool result came back', () => {
    expect(loopStep([...first, toolUse, toolResult, user(CONTINUE_PROMPT)])).toEqual({
      text: LOOP_DONE,
    });
    expect(loopStep([...first, user(CONTINUE_PROMPT)])).toEqual({ text: LOOP_NOTHING_SAVED });
  });

  it('leaves other prompts to the other replies', () => {
    expect(loopStep([user('[[links]] hello')])).toBeUndefined();
    expect(loopStep([user(CONTINUE_PROMPT)])).toBeUndefined();
    expect(loopStep([user('[[loop 7878]] relative')])).toBeUndefined();
  });
});
