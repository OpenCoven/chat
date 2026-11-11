import { join } from 'node:path';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/engine-home-row.mjs';
const { engineHomes } = await import(path);

test("the row compares Coven's managed engine home with the standalone one", () => {
  expect(engineHomes({}, '/home/r')).toEqual({
    managed: join('/home/r', '.coven', 'code'),
    standalone: join('/home/r', '.coven-code'),
  });
  expect(engineHomes({ COVEN_HOME: '/c' }, '/home/r').managed).toBe(join('/c', 'code'));
  expect(engineHomes({ COVEN_CODE_HOME: '/e' }, '/home/r')).toEqual({
    reason: 'COVEN_CODE_HOME set on this runner',
  });
});
