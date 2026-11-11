// Settings › Model › Every message: the Model dropdown offers the chat's engine
// presets, and the preset a person picks is the model the engine asks for.
// The model stand-in records each request's model, so the check reads what
// reached the provider, not only what the window shows.

import { sleep, until, walk } from './driver.mjs';
import { Row, showFamiliars } from './rows.mjs';

export const PRESET = 'Claude Sonnet 5.5';
/** What the engine sends for the Coven Code preset `anthropic/claude-sonnet-5-5`. */
export const PRESET_MODEL = 'claude-sonnet-5-5';
const POPUP_ROLES = new Set(['AXPopUpButton', 'combo box', 'ComboBox', 'combobox']);

/** The dropdown itself, not the Settings section that shares its name. */
export function modelDropdown(nodes) {
  return nodes.find(
    (node) =>
      node.name === 'Model' &&
      (node.role === 'combobox' ||
        POPUP_ROLES.has(node.raw?.role) ||
        POPUP_ROLES.has(node.roleDescription)),
  );
}

/**
 * The option a closed dropdown shows. macOS (AXValue) and Windows (the Value
 * pattern) report it as the value; AT-SPI keeps it in the combo box's text, or
 * marks the chosen option selected.
 */
export function shownChoice(node) {
  if (!node) return '';
  if (node.value !== undefined && node.value !== null && String(node.value) !== '')
    return String(node.value);
  if (node.raw?.text) return String(node.raw.text).trim();
  const picked = [...walk(node)].find((child) => child !== node && child.selected && child.name);
  return picked?.name ?? '';
}

/** The models the engine requested since `before` requests had been made. */
export function requestedSince(models, before) {
  return models.slice(before).filter(Boolean);
}

async function openSettingsAt(app, section) {
  await app.click(await app.one('button', 'Open settings'));
  await app.one('dialog', 'Settings');
  const buttons = await app.all('button', section, { within: ['dialog', 'Settings'] });
  await app.click(
    buttons[0] ?? (await app.one('tab', section, { within: ['dialog', 'Settings'] })),
  );
  await sleep(400);
}

async function closeSettings(app) {
  await app.click(await app.one('button', 'Close settings'));
  await app.gone('dialog', 'Settings', { timeout: 3_000 }).catch(async () => {
    await app.key('escape');
    await app.gone('dialog', 'Settings');
  });
}

async function dropdown(app) {
  return until(
    'the Model dropdown',
    async () => modelDropdown([...walk(await app.snapshot())]) ?? null,
    10_000,
    500,
  );
}

const shown = async (app) => shownChoice(await dropdown(app));

/**
 * Picks `label` from the keyboard, as a person can on every platform: open the
 * dropdown, type the option's name, press Return. A list that takes no typing
 * (GTK's) is walked one option at a time instead, reading the choice back.
 */
async function choose(app, row, label) {
  await app.click(await dropdown(app));
  await sleep(500);
  await app.type(label);
  await app.key('return');
  await sleep(500);
  if ((await shown(app)).includes(label)) {
    row.note(`chose "${label}"`, 'typed its name into the open dropdown');
    return shown(app);
  }
  const passed = [];
  for (const direction of ['down', 'up']) {
    // A list that opens with nothing highlighted spends one press on the
    // current option, so only two presses that change nothing end the walk.
    let stuck = 0;
    for (let step = 0; step < 12 && stuck < 2; step += 1) {
      const before = await shown(app);
      await app.click(await dropdown(app));
      await sleep(400);
      await app.key(direction);
      await app.key('return');
      await sleep(400);
      const now = await shown(app);
      passed.push(now);
      if (now.includes(label)) {
        row.note(`chose "${label}"`, `pressed ${direction} through ${JSON.stringify(passed)}`);
        return now;
      }
      stuck = now === before ? stuck + 1 : 0;
    }
  }
  row.note(`could not choose "${label}"`, passed);
  return shown(app);
}

export async function modelRow(lane, familiar, models) {
  const row = new Row(
    'v010-model',
    'Settings › Model: a preset from the dropdown is the model the engine uses',
  );
  const { app } = lane;
  return lane.attempt(row, async () => {
    await showFamiliars(lane, row);
    await app.click(await app.one('button', familiar));
    await openSettingsAt(app, 'Model');
    row.note('Model dropdown before', await shown(app));
    const picked = await choose(app, row, PRESET);
    row.check(`the dropdown shows "${PRESET}"`, picked.includes(PRESET), picked);
    lane.shot('model-preset');
    await closeSettings(app);

    const before = models().length;
    await lane.clearComposer(familiar);
    await lane.send(familiar, '[[table]] Show me the table.', 'button', 'Expand table');
    const requested = requestedSince(models(), before);
    row.check(
      `the engine asked the provider for ${PRESET_MODEL}`,
      requested.includes(PRESET_MODEL),
      requested,
    );

    await openSettingsAt(app, 'Model');
    const reset = await choose(app, row, 'Engine default');
    row.check('the dropdown is back on "Engine default"', reset.includes('Engine default'), reset);
    await closeSettings(app);
  });
}
