import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/model-row.mjs';
const { modelDropdown, requestedSince, shownChoice } = await import(path);

test('the dropdown is told apart from the Settings section named Model', () => {
  const section = { role: 'button', name: 'Model', raw: { role: 'AXButton' } };
  const mac = { role: 'button', name: 'Model', raw: { role: 'AXPopUpButton' } };
  const linux = { role: 'button', name: 'Model', raw: { role: 'combo box' } };
  const windows = { role: 'combobox', name: 'Model', raw: { role: 'ComboBox' } };
  expect(modelDropdown([section, mac])).toBe(mac);
  expect(modelDropdown([section, linux])).toBe(linux);
  expect(modelDropdown([section, windows])).toBe(windows);
  expect(modelDropdown([section])).toBeUndefined();
});

test('only requests made after the send count', () => {
  expect(requestedSince(['claude-haiku-5-5', null, 'claude-sonnet-5-5'], 1)).toEqual([
    'claude-sonnet-5-5',
  ]);
});

test('the shown option is read the way each platform reports it', () => {
  expect(shownChoice({ value: 'Engine default', raw: {} })).toBe('Engine default');
  expect(shownChoice({ value: undefined, raw: { text: ' Claude Sonnet 5.5 ' } })).toBe(
    'Claude Sonnet 5.5',
  );
  const option = { name: 'Claude Sonnet 5.5', selected: true, children: [] };
  const other = { name: 'Engine default', selected: false, children: [] };
  expect(shownChoice({ value: '', raw: {}, children: [{ children: [other, option] }] })).toBe(
    'Claude Sonnet 5.5',
  );
  expect(shownChoice(undefined)).toBe('');
});
