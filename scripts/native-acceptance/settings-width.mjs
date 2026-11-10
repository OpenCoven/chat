// Independent acceptance expectations for the published Settings row (#548).
// These are native accessibility observations, never reads from the page DOM.
import { walk } from './driver.mjs';

export const WIDTH_LABEL = 'Inspector width';
export const WIDTH_HINT =
  "Drag the inspector's left edge, or focus its Resize inspector handle and use the arrow keys, Home and End. The conversation keeps at least 440px.";

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const ownText = (node) => [node.name, node.value, node.raw?.text].map(clean);

export function settingsWidthEvidence(settings, width) {
  if (!settings?.children?.length) throw new Error('Settings has no accessible tree');
  const all = [...walk(settings)];
  const resets = all.filter(
    (node) => node.role === 'button' && node.name === 'Reset inspector width',
  );
  const reset = resets.length === 1 ? resets[0] : null;
  // Keep assertions inside the Inspector group, so a number or instruction
  // elsewhere in Settings cannot accidentally satisfy this row.
  let group = reset?.parent;
  while (group && group !== settings) {
    if ([...walk(group)].some((node) => node.role === 'heading' && /^inspector$/i.test(node.name)))
      break;
    group = group.parent;
  }
  const nodes = group && group !== settings ? [...walk(group)] : [];
  const hasText = (text) => nodes.some((node) => ownText(node).includes(text));
  const values = nodes.filter((node) => ownText(node).includes(`${width}px`));
  const describedBy = reset?.raw?.relations?.['described-by'] ?? [];
  const relationship = values.some((value) =>
    describedBy.some(
      (target) =>
        value.raw?.id &&
        target.id === value.raw.id &&
        [target.text, target.name].map(clean).includes(`${width}px`),
    ),
  );
  return {
    label: hasText(WIDTH_LABEL),
    hint: hasText(WIDTH_HINT),
    width: values.length > 0,
    reset: reset !== null,
    resetEnabled: reset?.enabled,
    relationship,
    describedBy,
    subtree: group?.raw ?? settings.raw,
    text: nodes.map((node) => ownText(node).filter(Boolean).join(' | ')).filter(Boolean),
  };
}

export function checkSettingsWidth(row, evidence, width) {
  row.check(`Settings ${width}px: Inspector width label`, evidence.label);
  row.check(`Settings ${width}px: complete instruction hint`, evidence.hint);
  row.check(`Settings ${width}px: current width`, evidence.width);
  row.check(`Settings ${width}px: unique Reset control`, evidence.reset);
  row.check(`Settings ${width}px: Reset described by the current width`, evidence.relationship, {
    describedBy: evidence.describedBy,
  });
  row.expect(
    `Settings ${width}px: Reset enabled only away from default`,
    evidence.resetEnabled,
    width !== 360,
  );
}

export function checkSettingsSpeech(row, phrases, width) {
  // Whitespace changes and phrase boundaries are presentation; missing words
  // are not. This checks Orca's generated utterances, not audible human review.
  const spoken = clean(phrases.join(' '));
  row.check(`Orca Settings ${width}px: label`, spoken.includes(WIDTH_LABEL), phrases);
  row.check(
    `Orca Settings ${width}px: complete instruction hint`,
    spoken.includes(WIDTH_HINT),
    phrases,
  );
  row.check(
    `Orca Settings ${width}px: current width`,
    new RegExp(`\\b${width}\\s*(?:px|pixels)\\b`).test(spoken),
    phrases,
  );
}
