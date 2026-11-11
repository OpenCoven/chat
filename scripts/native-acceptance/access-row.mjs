// Settings › Access: Refresh project access rereads a familiar's grants while
// Settings stays open, and a long project list sits in a region the keyboard
// can reach. The grants are synthetic Cave metadata, written only where the
// runner has none, and removed again before the row ends.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM, sleep, until, walk } from './driver.mjs';
import { Row, showFamiliars } from './rows.mjs';

export const ACCESS_PROJECTS = 8;
const LIST_REGION = 'Project access list';
const REFRESH = 'Refresh project access';

/** Cave's project registry and grants for one familiar, in the shape Chat reads. */
export function caveMetadata(familiarId, folder, count = ACCESS_PROJECTS) {
  const stamp = '2026-01-01T00:00:00.000Z';
  const projects = Array.from({ length: count }, (_, index) => ({
    id: `native-access-${index + 1}`,
    name: `Access project ${index + 1}`,
    root: join(folder, `project-${index + 1}`),
    createdAt: stamp,
    updatedAt: stamp,
  }));
  return {
    projects: { version: 1, projects },
    permissions: {
      version: 1,
      projectGrants: projects.map((project, index) => ({
        familiarId,
        projectId: project.id,
        access: index === 0 ? 'write' : 'read',
      })),
    },
  };
}

/** Where Chat reads Cave's metadata on this runner, or why the row can't use it. */
export function caveFiles(env = process.env, home = homedir()) {
  const set = [
    'COVEN_HOME',
    'COVEN_CAVE_HOME',
    'CAVE_PROJECTS_PATH_OVERRIDE',
    'CAVE_PROJECT_PERMISSIONS_PATH_OVERRIDE',
  ].filter((key) => env[key]);
  if (set.length) return { reason: `${set.join(', ')} set on this runner` };
  const cave = join(home, '.coven', 'cave');
  return {
    cave,
    projects: join(cave, 'projects.json'),
    permissions: join(cave, 'project-permissions.json'),
    legacy: [
      join(home, '.coven', 'cave-projects.json'),
      join(home, '.coven', 'cave-project-permissions.json'),
    ],
  };
}

/** The id of the familiar the window shows as `shown` (Coven's `display_name`). */
export function idOf(familiars, shown) {
  return familiars.find((familiar) => (familiar.display_name ?? familiar.name) === shown)?.id;
}

export function familiarId(cli, shown) {
  const listed = spawnSync(cli, ['familiars', '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (listed.status !== 0) throw new Error(`coven familiars --json failed: ${listed.stderr}`);
  const id = idOf(JSON.parse(listed.stdout), shown);
  if (!id) throw new Error(`Coven lists no familiar shown as ${shown}`);
  return id;
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

/** Every synthetic project name in `text`, once each and sorted. */
export function namesIn(text) {
  return [...new Set(String(text).match(/Access project \d+/g) ?? [])].sort();
}

/**
 * The synthetic projects Settings shows. Each platform exposes a list item
 * under its own role, and AT-SPI keeps inline text in its container, so the
 * names are read from all of the dialog's text rather than from list items.
 */
async function projectNames(app) {
  const dialogs = await app.all('dialog', 'Settings');
  if (!dialogs.length) return [];
  const text = [...walk(dialogs[0])]
    .map((node) =>
      [node.name, node.value, node.raw?.text].filter((part) => typeof part === 'string').join(' '),
    )
    .join(' ');
  return namesIn(text);
}

export async function accessRow(lane, familiar) {
  const row = new Row(
    'v010-access',
    'Settings › Access: Refresh project access, and a project list the keyboard reaches',
  );
  const { app } = lane;
  if (PLATFORM === 'windows') {
    row.block(
      'Cave metadata',
      "Chat doesn't read Cave's project metadata on Windows: open_metadata is Unix-only (#587)",
    );
    return row;
  }
  const files = caveFiles();
  if (files.reason) {
    row.block('Cave metadata', files.reason);
    return row;
  }
  const existing = [files.projects, files.permissions, ...files.legacy].filter(existsSync);
  if (existing.length) {
    row.block(
      'Cave metadata',
      `the runner already has ${existing.join(', ')}; the row won't replace it`,
    );
    return row;
  }
  const list = `${familiar}'s declared project access`;
  let folder;
  return lane.attempt(row, async () => {
    try {
      const id = familiarId(lane.cli, familiar);
      row.note('familiar id', id);
      await showFamiliars(lane, row);
      await app.click(await app.one('button', familiar));
      await openSettingsAt(app, 'Access');
      row.expect('projects listed before any grant', await projectNames(app), []);

      folder = realpathSync(mkdtempSync(join(tmpdir(), 'chat-native-access-')));
      const metadata = caveMetadata(id, folder);
      for (const project of metadata.projects.projects) mkdirSync(project.root);
      mkdirSync(files.cave, { recursive: true });
      writeFileSync(files.projects, JSON.stringify(metadata.projects));
      writeFileSync(files.permissions, JSON.stringify(metadata.permissions));

      // The grants changed while Settings was open; only the button rereads them.
      await app.click(await app.one('button', REFRESH, { within: ['dialog', 'Settings'] }));
      const shown = await until(
        `${ACCESS_PROJECTS} granted projects in Settings`,
        async () => {
          const names = await projectNames(app);
          return names.length === ACCESS_PROJECTS ? names : null;
        },
        30_000,
        500,
      ).catch(async () => projectNames(app));
      row.expect(
        'projects listed after Refresh project access',
        [...shown].sort(),
        metadata.projects.projects.map((project) => project.name).sort(),
      );
      row.note(
        `lists named "${list}"`,
        (await app.all(undefined, list, { within: ['dialog', 'Settings'] })).map(
          (node) => node.role,
        ),
      );
      row.expect('Settings stayed open on Access', await app.count('dialog', 'Settings'), 1);
      row.expect(
        `"${LIST_REGION}" region`,
        (await app.all(undefined, LIST_REGION, { within: ['dialog', 'Settings'] })).length,
        1,
      );
      lane.shot('access-refreshed');

      // Tab from the button that was just used reaches the scrolling region.
      await app.click(await app.one('button', REFRESH, { within: ['dialog', 'Settings'] }));
      await until(
        'the list to settle after the second refresh',
        async () => (await projectNames(app)).length === ACCESS_PROJECTS,
        30_000,
        500,
      ).catch(() => undefined);
      const stops = [];
      for (let press = 0; press < 6; press += 1) {
        await app.key('tab');
        await sleep(250);
        const focus = await app.focused();
        stops.push(`${focus?.role ?? '?'} "${focus?.name ?? ''}"`);
        if (focus?.name === LIST_REGION) break;
      }
      row.check('Tab reaches the project list', stops.at(-1)?.endsWith(`"${LIST_REGION}"`), stops);

      rmSync(files.projects);
      rmSync(files.permissions);
      await app.click(await app.one('button', REFRESH, { within: ['dialog', 'Settings'] }));
      const cleared = await until(
        'the grants to go after they were removed',
        async () => ((await projectNames(app)).length === 0 ? [] : null),
        30_000,
        500,
      ).catch(async () => projectNames(app));
      row.expect('projects listed after the grants were removed', cleared, []);
      await closeSettings(app);
    } finally {
      for (const path of [files.projects, files.permissions]) rmSync(path, { force: true });
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });
}
