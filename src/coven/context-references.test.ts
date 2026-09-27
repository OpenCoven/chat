import { describe, expect, it } from 'vitest';
import {
  type ContextFamiliar,
  contextReferences,
  insertContextReference,
  matchContextReferences,
} from './context-references';

const familiars: readonly ContextFamiliar[] = [
  {
    id: 'astra-one',
    name: 'Astra (research)',
    workspace: '/familiars/astra',
    projectAccess: [
      { name: 'chat', path: '/work/chat', access: 'write' },
      { name: 'chat', path: '/other/chat', access: 'read' },
    ],
  },
  {
    id: 'astra-two',
    name: 'Astra (research)',
    workspace: '/familiars/other',
    projectAccess: [{ name: 'private', path: '/private/project', access: 'write' }],
  },
];

describe('context references', () => {
  it('keeps duplicate familiar names distinct and scopes projects to the current familiar', () => {
    const references = contextReferences(familiars, 'astra-one');
    expect(references).toHaveLength(4);
    expect(references[0]?.text).toBe('@{Astra (research)} (id: "astra-one")');
    expect(references[1]?.text).toContain('"astra-two"');
    expect(references[2]?.source).toBe('Write access');
    expect(references[3]?.source).toBe('Read-only access');
    expect(
      references.filter((item) => item.kind === 'workspace').map((item) => item.detail),
    ).toEqual(['/work/chat', '/other/chat']);
    expect(
      contextReferences(familiars, 'astra-two').filter((item) => item.kind === 'workspace'),
    ).toEqual([expect.objectContaining({ detail: '/private/project', source: 'Write access' })]);
    expect(contextReferences(familiars, 'missing')).toHaveLength(2);
  });

  it('does not infer project access from familiar home directories', () => {
    expect(
      contextReferences([{ id: 'one', name: 'One', workspace: '/home/one' }], 'one'),
    ).toHaveLength(1);
  });

  it('deduplicates paths and retains declared write access over read access', () => {
    const references = contextReferences(
      [
        {
          id: 'one',
          name: 'One',
          projectAccess: [
            { name: 'repo', path: '/repo', access: 'read' },
            { name: 'repo', path: '/repo', access: 'write' },
            { name: 'repo', path: '/repo', access: 'read' },
          ],
        },
      ],
      'one',
    );
    expect(references).toHaveLength(2);
    expect(references[1]?.source).toBe('Write access');
  });

  it('matches names, IDs and paths without resolving ambiguity', () => {
    const references = contextReferences(familiars, 'astra-one');
    expect(matchContextReferences(references, '@AST research')).toHaveLength(2);
    expect(matchContextReferences(references, '@two')[0]?.detail).toBe('astra-two');
    expect(matchContextReferences(references, '#chat')).toHaveLength(2);
    expect(matchContextReferences(references, '#other')[0]?.detail).toBe('/other/chat');
    expect(matchContextReferences(references, '@missing')).toEqual([]);
  });

  it('replaces selected text while retaining suffixes and canonical paths', () => {
    const reference = contextReferences(familiars, 'astra-one')[2];
    if (!reference) throw new Error('Missing reference');
    const result = insertContextReference('Ask this today', 4, 8, reference);
    expect(result.value).toBe('Ask #{chat} (path: "/work/chat") today');
    expect(result.value.slice(result.caret)).toBe(' today');
    expect(insertContextReference('', 0, 0, reference).value).toBe('#{chat} (path: "/work/chat") ');
  });
});
