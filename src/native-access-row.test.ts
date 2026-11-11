import { join } from 'node:path';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/access-row.mjs';
const { caveFiles, caveMetadata } = await import(path);

test('the synthetic grants give one familiar every project, the first writable', () => {
  const { projects, permissions } = caveMetadata('astra', '/work', 3);
  expect(projects.version).toBe(1);
  expect(projects.projects.map((project: { name: string }) => project.name)).toEqual([
    'Access project 1',
    'Access project 2',
    'Access project 3',
  ]);
  expect(projects.projects[0].root).toBe(join('/work', 'project-1'));
  expect(permissions.projectGrants).toEqual([
    { familiarId: 'astra', projectId: 'native-access-1', access: 'write' },
    { familiarId: 'astra', projectId: 'native-access-2', access: 'read' },
    { familiarId: 'astra', projectId: 'native-access-3', access: 'read' },
  ]);
});

test('the row writes only where Chat reads Cave metadata by default', () => {
  expect(caveFiles({}, '/home/runner')).toMatchObject({
    projects: join('/home/runner', '.coven', 'cave', 'projects.json'),
    permissions: join('/home/runner', '.coven', 'cave', 'project-permissions.json'),
  });
  expect(caveFiles({ COVEN_CAVE_HOME: '/elsewhere' }, '/home/runner')).toEqual({
    reason: 'COVEN_CAVE_HOME set on this runner',
  });
});
