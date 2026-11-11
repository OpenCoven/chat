// Coven Code keeps its state in Coven's managed home (~/.coven/code) when Chat
// runs it, not in its standalone ~/.coven-code. Checked after the lane's runs,
// on a fresh runner where neither existed before Coven was installed.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Row } from './rows.mjs';

/** The engine's two possible homes, as Coven Code resolves them. */
export function engineHomes(env = process.env, home = homedir()) {
  if (env.COVEN_CODE_HOME) return { reason: 'COVEN_CODE_HOME set on this runner' };
  return {
    managed: join(env.COVEN_HOME || join(home, '.coven'), 'code'),
    standalone: join(home, '.coven-code'),
  };
}

export function engineHomeRow(requests) {
  const row = new Row(
    'v010-engine-home',
    "Coven Code runs keep their state in Coven's managed home",
  );
  const homes = engineHomes();
  if (homes.reason) {
    row.block('engine home', homes.reason);
    return row;
  }
  row.check('the lane reached the engine', requests() > 0, requests());
  row.expect(`${homes.standalone} exists`, existsSync(homes.standalone), false);
  row.expect(`${homes.managed} exists`, existsSync(homes.managed), true);
  if (existsSync(homes.managed)) row.note(`${homes.managed} holds`, readdirSync(homes.managed));
  if (existsSync(homes.standalone))
    row.note(`${homes.standalone} holds`, readdirSync(homes.standalone));
  return row;
}
