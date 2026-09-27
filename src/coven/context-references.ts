import type { CovenProjectAccess } from '../lib/coven-runtime';

export type ContextFamiliar = Readonly<{
  id: string;
  name: string;
  workspace?: string | undefined;
  projectAccess?: readonly CovenProjectAccess[] | undefined;
}>;

export type ContextReference = Readonly<{
  key: string;
  kind: 'familiar' | 'workspace';
  label: string;
  detail: string;
  text: string;
  source: string;
}>;

/** Only observed runtime metadata supplies references; this is not an access grant. */
export function contextReferences(
  familiars: readonly ContextFamiliar[],
  familiarId: string,
): ContextReference[] {
  const people = new Map<string, ContextReference>();
  const roots = new Map<string, CovenProjectAccess>();
  for (const familiar of familiars) {
    people.set(familiar.id, {
      key: `familiar:${familiar.id}`,
      kind: 'familiar',
      label: familiar.name,
      detail: familiar.id,
      text: `@{${familiar.name}} (id: ${JSON.stringify(familiar.id)})`,
      source: 'Mention familiar; not a recipient change',
    });
  }
  for (const project of familiars.find((item) => item.id === familiarId)?.projectAccess ?? []) {
    if (!roots.has(project.path) || project.access === 'write') roots.set(project.path, project);
  }
  return [
    ...people.values(),
    ...Array.from(roots, ([root, project]): ContextReference => {
      const label = project.name;
      return {
        key: `workspace:${root}`,
        kind: 'workspace',
        label,
        detail: root,
        text: `#{${label}} (path: ${JSON.stringify(root)})`,
        source: project.access === 'write' ? 'Write access' : 'Read-only access',
      };
    }),
  ];
}

export function matchContextReferences(
  references: readonly ContextReference[],
  query: string,
): ContextReference[] {
  const kind = query.trim().startsWith('@')
    ? 'familiar'
    : query.trim().startsWith('#')
      ? 'workspace'
      : undefined;
  const tokens = query.trim().replace(/^[@#]/, '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return references.filter((reference) => {
    const searchable = `${reference.label} ${reference.detail}`.toLocaleLowerCase();
    return (
      (!kind || reference.kind === kind) && tokens.every((token) => searchable.includes(token))
    );
  });
}

export function insertContextReference(
  draft: string,
  start: number,
  end: number,
  reference: ContextReference,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, draft.length));
  const to = Math.max(from, Math.min(end, draft.length));
  const before = draft.slice(0, from);
  const after = draft.slice(to);
  const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${reference.text}${!after || !/^\s/.test(after) ? ' ' : ''}`;
  return { value: before + insertion + after, caret: before.length + insertion.length };
}
