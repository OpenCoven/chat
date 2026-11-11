// Coven Code run from Chat reads Coven's managed engine home (~/.coven/code),
// not its standalone ~/.coven-code. Each home gets a settings file naming a
// different model, and the model stand-in records which one the engine asked
// for. Both homes must be absent at the start; the row removes what it made.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Row } from './rows.mjs';

/** The model each home's settings name: the engine's request says which it read. */
export const HOME_MODELS = { managed: 'claude-haiku-5-5', standalone: 'claude-opus-5-5' };

/** The engine's two possible homes, as Coven Code resolves them. */
export function engineHomes(env = process.env, home = homedir()) {
  if (env.COVEN_CODE_HOME) return { reason: 'COVEN_CODE_HOME set on this runner' };
  return {
    managed: join(env.COVEN_HOME || join(home, '.coven'), 'code'),
    standalone: join(home, '.coven-code'),
  };
}

/** Coven Code's global settings, choosing only the model. */
export function settingsFor(model) {
  return { version: 1, config: { model } };
}

/** The models the engine requested since `before` requests had been made. */
export function requestedSince(models, before) {
  return models.slice(before).filter(Boolean);
}

export async function engineHomeRow(lane, familiar, models) {
  const row = new Row('v010-engine-home', "Coven Code run from Chat reads Coven's managed home");
  const homes = engineHomes();
  if (homes.reason) {
    row.block('engine home', homes.reason);
    return row;
  }
  const present = [homes.managed, homes.standalone].filter(existsSync);
  if (present.length) {
    row.block('engine home', `${present.join(', ')} already exist; the row won't replace them`);
    return row;
  }
  const made = [];
  return lane.attempt(row, async () => {
    try {
      for (const which of ['managed', 'standalone']) {
        mkdirSync(homes[which], { recursive: true });
        made.push(homes[which]);
        writeFileSync(
          join(homes[which], 'settings.json'),
          JSON.stringify(settingsFor(HOME_MODELS[which])),
        );
        row.note(`${homes[which]}/settings.json names`, HOME_MODELS[which]);
      }
      const before = models().length;
      await lane.clearComposer(familiar);
      await lane.send(familiar, '[[table]] Show me the table.', 'button', 'Expand table');
      const requested = requestedSince(models(), before);
      row.note('models the engine requested', requested);
      row.check(
        `the engine used the managed home's ${HOME_MODELS.managed}`,
        requested.length > 0 && requested.every((model) => model === HOME_MODELS.managed),
        requested,
      );
      row.expect(
        `the engine used the standalone home's ${HOME_MODELS.standalone}`,
        requested.includes(HOME_MODELS.standalone),
        false,
      );
      for (const home of made) row.note(`${home} holds after the run`, readdirSync(home));
    } finally {
      for (const home of made) rmSync(home, { recursive: true, force: true });
    }
  });
}
