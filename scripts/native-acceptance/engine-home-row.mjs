// Coven Code run from Chat reads Coven's managed engine home (~/.coven/code),
// not its standalone ~/.coven-code. Only the managed home gets a settings file,
// naming a model the engine wouldn't otherwise ask for; the model stand-in
// records what the engine asked for. The standalone home must stay absent:
// Coven Code also treats any ancestor's .coven-code/settings.json as project
// settings, which win over the global file, so a file there would decide the
// model whichever home the engine used. The row removes what it made.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Row } from './rows.mjs';

/** The model the managed home's settings name; the engine's default differs. */
export const MANAGED_MODEL = 'claude-haiku-5-5';

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
  const row = new Row('v012-engine-home', "Coven Code run from Chat reads Coven's managed home");
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
  return lane.attempt(row, async () => {
    try {
      mkdirSync(homes.managed, { recursive: true });
      writeFileSync(
        join(homes.managed, 'settings.json'),
        JSON.stringify(settingsFor(MANAGED_MODEL)),
      );
      row.note(`${homes.managed}/settings.json names`, MANAGED_MODEL);
      const before = models().length;
      await lane.clearComposer(familiar);
      await lane.send(familiar, '[[table]] Show me the table.', 'button', 'Expand table');
      const requested = requestedSince(models(), before);
      row.check(
        `the engine asked for the managed home's ${MANAGED_MODEL}`,
        requested.length > 0 && requested.every((model) => model === MANAGED_MODEL),
        requested,
      );
      row.note(`${homes.managed} holds after the run`, readdirSync(homes.managed));
      row.expect(`${homes.standalone} exists after the run`, existsSync(homes.standalone), false);
    } finally {
      rmSync(homes.managed, { recursive: true, force: true });
    }
  });
}
