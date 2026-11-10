import { expect, test, vi } from 'vitest';

vi.mock('../scripts/native-acceptance/driver.mjs', async (original) => ({
  ...(await original<object>()),
  PLATFORM: 'linux',
  sleep: async () => {},
}));

const rowsPath = '../scripts/native-acceptance/rows.mjs';
const rows = await import(rowsPath);
const settingsPath = '../scripts/native-acceptance/settings-width.mjs';
const settings = await import(settingsPath);

type Raw = {
  role: string;
  name: string;
  children: Raw[];
  id?: string;
  text?: string;
  enabled?: boolean;
  relations?: Record<string, { id: string; text: string }[]>;
};
type Node = {
  role: string;
  name: string;
  enabled: boolean;
  value: string | undefined;
  raw: Raw;
  parent: Node | null;
  children: Node[];
};

function tree(width = 400) {
  const raw = (role: string, name = '', children: Raw[] = [], extra: Partial<Raw> = {}) => ({
    role,
    name,
    children,
    ...extra,
  });
  const value = raw('text', '', [], { id: 'width', text: `${width}px` });
  const reset = raw('button', 'Reset inspector width', [], {
    enabled: width !== 360,
    relations: { 'described-by': [{ id: 'width', text: `${width}px` }] },
  });
  const root = raw('dialog', 'Settings', [
    raw('text', 'Unrelated settings text '.repeat(100)),
    raw('group', '', [
      raw('heading', 'INSPECTOR'),
      raw('text', settings.WIDTH_LABEL),
      raw('text', settings.WIDTH_HINT),
      value,
      reset,
    ]),
  ]);
  const normalize = (source: Raw, parent: Node | null = null): Node => {
    const node: Node = {
      role: source.role,
      name: source.name,
      enabled: source.enabled !== false,
      value: source.text,
      raw: source,
      parent,
      children: [],
    };
    node.children = source.children.map((child: Raw) => normalize(child, node));
    return node;
  };
  return { root: normalize(root), raw: root, value, reset };
}

for (const width of [400, 600, 360]) {
  test(`native Settings checks the complete row at ${width}px beyond the old truncated prefix`, () => {
    const fixture = tree(width);
    const evidence = settings.settingsWidthEvidence(fixture.root, width);
    const row = new rows.Row('504-6', 'Inspector');
    settings.checkSettingsWidth(row, evidence, width);
    expect(row.status).toBe('observed');
    expect(evidence.subtree.nodes).toEqual(fixture.raw.children[1]?.children);
    expect(evidence.text.join(' ')).toContain(settings.WIDTH_HINT);
  });
}

test.each(['label', 'hint', 'width', 'relation', 'wrong-target', 'reset-state'])(
  'native Settings fails when %s is missing or incorrect',
  (missing) => {
    const fixture = tree();
    const group = fixture.raw.children[1];
    if (!group?.children[1] || !group.children[2]) throw new Error('Invalid fixture');
    if (missing === 'label') group.children[1].name = '';
    if (missing === 'hint') group.children[2].name = settings.WIDTH_HINT.slice(0, 100);
    if (missing === 'width') fixture.value.text = '600px';
    if (missing === 'relation') fixture.reset.relations = {};
    if (missing === 'wrong-target')
      fixture.reset.relations = { 'described-by': [{ id: 'elsewhere', text: '400px' }] };
    if (missing === 'reset-state') fixture.reset.enabled = false;
    // Rebuild the normalized snapshot as a native helper would after the mutation.
    const apply = (node: Node) => {
      node.name = node.raw.name;
      node.value = node.raw.text;
      node.enabled = node.raw.enabled !== false;
      node.children.forEach(apply);
    };
    apply(fixture.root);
    const row = new rows.Row('504-6', 'Inspector');
    settings.checkSettingsWidth(row, settings.settingsWidthEvidence(fixture.root, 400), 400);
    expect(row.status).toBe('failed');
  },
);

test('width and label elsewhere in Settings do not satisfy the Inspector row', () => {
  const fixture = tree();
  const [other, group] = fixture.root.children;
  if (!other || !group) throw new Error('Invalid fixture');
  other.name = `${settings.WIDTH_LABEL} ${settings.WIDTH_HINT} 400px`;
  group.children.splice(1, 3);
  const evidence = settings.settingsWidthEvidence(fixture.root, 400);
  expect(evidence.label).toBe(false);
  expect(evidence.hint).toBe(false);
  expect(evidence.width).toBe(false);
});

test.each([null, { children: [] }])('an unavailable Settings tree %j cannot pass', (root) => {
  expect(() => settings.settingsWidthEvidence(root, 400)).toThrow(/accessible tree/);
});

test.each(['full', 'truncated', 'wrong-width', 'empty'])(
  'Orca utterances must include the entire row: %s',
  (kind) => {
    const phrases =
      kind === 'empty'
        ? []
        : [
            settings.WIDTH_LABEL,
            kind === 'truncated' ? settings.WIDTH_HINT.slice(0, 100) : settings.WIDTH_HINT,
            kind === 'wrong-width' ? '600px' : '400px',
          ];
    const row = new rows.Row('504-6', 'Inspector speech');
    settings.checkSettingsSpeech(row, phrases, 400);
    expect(row.status).toBe(kind === 'full' ? 'observed' : 'failed');
  },
);

test.each([true, false])(
  'the live row enforces the new checks and saves success/failure evidence: %s',
  async (complete) => {
    const fixture = tree();
    const label = fixture.root.children[1]?.children[1];
    if (!label) throw new Error('Invalid fixture');
    if (!complete) label.name = label.raw.name = '';
    const saved: Record<string, string> = {};
    const shots: string[] = [];
    const app = {
      one: async () => fixture.root,
      activate: async () => {},
      click: async () => {},
      key: async () => {},
    };
    const lane = {
      app,
      save: (name: string, value: string) => {
        saved[name] = value;
      },
      shot: (name: string) => shots.push(name),
      reader: {
        start: async () => {},
        stop: async () => {},
        mark: async () => 0,
        since: async () => [settings.WIDTH_LABEL, settings.WIDTH_HINT, '400px'],
      },
    };
    const row = new rows.Row('504-6', 'Inspector');
    await rows.settingsShowWidth(lane, row, 'width', 400);
    expect(row.status).toBe(complete ? 'observed' : 'failed');
    expect(saved['settings-tree-400.json']).toContain('Unrelated settings text');
    expect(saved['settings-inspector-400.json']).toContain(settings.WIDTH_HINT);
    expect(saved['settings-orca-400.json']).toContain(settings.WIDTH_HINT);
    expect(shots).toEqual(['settings-width-400']);
  },
);

test('flattened native General peers outside the Inspector heading range cannot satisfy its checks', () => {
  const fixture = tree();
  const group = fixture.root.children[1];
  if (!group) throw new Error('Invalid fixture');
  group.children.splice(1, 3);
  group.children.push({
    role: 'heading',
    name: 'TOOL ACTIVITY',
    enabled: true,
    parent: group,
    raw: { role: 'heading', name: 'TOOL ACTIVITY', children: [] },
    value: undefined,
    children: [],
  });
  group.children.push({
    role: 'text',
    name: `${settings.WIDTH_LABEL}`,
    enabled: true,
    parent: group,
    raw: { role: 'text', name: '', text: settings.WIDTH_HINT, children: [] },
    value: '400px',
    children: [],
  });
  const evidence = settings.settingsWidthEvidence(fixture.root, 400);
  expect(evidence.label).toBe(false);
  expect(evidence.hint).toBe(false);
  expect(evidence.width).toBe(false);
});

test('spatial Orca review retains every hint word when adjacent controls occur between wrapped lines', () => {
  const phrases = [
    settings.WIDTH_LABEL,
    settings.WIDTH_HINT.replace('the arrow keys', 'the 400px Reset arrow keys'),
  ];
  const row = new rows.Row('504-6', 'Inspector speech');
  settings.checkSettingsSpeech(row, phrases, 400);
  expect(row.status).toBe('observed');
});
