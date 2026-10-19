import { beforeEach, describe, expect, it } from 'vitest';
import {
  canAttach,
  DEFAULT_PREFERENCES,
  isValidModel,
  PREFERENCES_KEY,
  readPreferences,
  runOptions,
  sendOptions,
} from './preferences';

describe('stored run preferences', () => {
  beforeEach(() => localStorage.clear());

  it('starts every chat on Coven Code with the engine choosing the rest', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(runOptions(DEFAULT_PREFERENCES)).toEqual({
      harness: 'coven-code',
      model: '',
      think: false,
      speed: 'default',
    });
  });

  it('keeps valid choices and drops anything malformed, field by field', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ harness: 'claude', model: 'anthropic/claude-sonnet-5-5', think: true }),
    );
    expect(readPreferences()).toMatchObject({
      harness: 'claude',
      model: 'anthropic/claude-sonnet-5-5',
      think: true,
      speed: 'default',
    });
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ harness: 'copilot', model: '-rf', think: 'yes', speed: 'turbo' }),
    );
    expect(readPreferences()).toMatchObject({
      harness: 'coven-code',
      model: '',
      think: false,
      speed: 'default',
    });
  });
});

describe('model ids', () => {
  it('accepts empty and provider-qualified ids only', () => {
    for (const ok of [
      '',
      'openai/gpt-5.5',
      'anthropic/claude-opus-5-5',
      'gpt-5.5:latest',
      'm'.repeat(200),
    ]) {
      expect(isValidModel(ok), ok).toBe(true);
    }
    for (const bad of [
      '-rf',
      '--model=x',
      'gpt 5',
      'gpt\n5',
      'modèle',
      'openai/gpt;5',
      'm'.repeat(201),
    ]) {
      expect(isValidModel(bad), bad).toBe(false);
    }
  });
});

describe('what a send carries', () => {
  const chosen = {
    harness: 'codex',
    model: 'openai/gpt-5.5',
    think: true,
    speed: 'fast',
  } as const;

  it('sends nothing extra for the defaults, so the engine decides', () => {
    expect(sendOptions(runOptions(DEFAULT_PREFERENCES))).toEqual({});
    expect(sendOptions(runOptions(DEFAULT_PREFERENCES), 'coven-code')).toEqual({});
  });

  it('names the harness only when a chat starts, and never sends Codex what it ignores', () => {
    expect(sendOptions(chosen)).toEqual({ harness: 'codex', model: 'openai/gpt-5.5' });
    expect(sendOptions({ ...chosen, harness: 'claude', speed: 'thorough' })).toEqual({
      harness: 'claude',
      model: 'openai/gpt-5.5',
      think: true,
      speed: 'thorough',
    });
  });

  it('follows an existing chat’s harness instead of the preference', () => {
    expect(sendOptions(chosen, 'coven-code')).toEqual({
      model: 'openai/gpt-5.5',
      think: true,
      speed: 'fast',
    });
    expect(sendOptions({ ...chosen, harness: 'claude' }, 'codex')).toEqual({
      model: 'openai/gpt-5.5',
    });
    expect(sendOptions({ ...chosen, model: '' }, 'claude')).toEqual({ think: true, speed: 'fast' });
  });

  it('offers attachments only where Coven Code will run the message', () => {
    expect(canAttach(runOptions(DEFAULT_PREFERENCES))).toBe(true);
    expect(canAttach(chosen)).toBe(false);
    expect(canAttach(chosen, 'coven-code')).toBe(true);
    expect(canAttach(runOptions(DEFAULT_PREFERENCES), 'claude')).toBe(false);
  });
});
