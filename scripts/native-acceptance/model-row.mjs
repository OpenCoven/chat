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

/** Picks `label` the way a person does: open the dropdown, choose the option. */
async function choose(app, row, label) {
  await app.click(await dropdown(app));
  const option = await until(
    `the "${label}" option`,
    async () =>
      (await app.all(undefined, label)).find((node) =>
        ['menuitem', 'option', 'listitem', 'list item', 'menu item'].includes(node.role),
      ) ?? null,
    5_000,
    250,
  ).catch(() => null);
  if (option) {
    await app.click(option);
    row.note(`chose "${label}"`, `clicked its ${option.role}`);
  } else {
    // Some web views draw the open list where the tree can't see it; their
    // dropdowns still take type-to-select from the keyboard.
    await app.type(label);
    await app.key('enter');
    row.note(`chose "${label}"`, 'typed its name into the open dropdown');
  }
  await sleep(500);
  return String((await dropdown(app)).value ?? '');
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
    row.note('Model dropdown before', String((await dropdown(app)).value ?? ''));
    const shown = await choose(app, row, PRESET);
    row.check(`the dropdown shows "${PRESET}"`, shown.includes(PRESET), shown);
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
