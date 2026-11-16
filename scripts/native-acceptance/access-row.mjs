// Settings › Access: Refresh project access rereads a familiar's grants while
// Settings stays open, and a long project list sits in a region the keyboard
// can reach. The grants are synthetic Cave metadata, written only where the
// runner has none, and removed again before the row ends.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, until, walk } from './driver.mjs';
import { Row, showFamiliars } from './rows.mjs';

export const ACCESS_PROJECTS = 8;
const LIST_REGION = 'Project access list';
const REFRESH = 'Refresh project access';
/** The actionable unreadable-store explanation on every desktop platform. */
export const UNREADABLE_METADATA = "Chat could not read Coven's project registry or grants";
const declaresNone = (familiar) => `No project access is declared for ${familiar}`;

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
  return namesIn(await settingsText(app));
}

/** All of the Settings dialog's text, as the platform's tree gives it. */
async function settingsText(app) {
  const dialogs = await app.all('dialog', 'Settings');
  if (!dialogs.length) return '';
  return [...walk(dialogs[0])]
    .map((node) =>
      [node.name, node.value, node.raw?.text].filter((part) => typeof part === 'string').join(' '),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The sentence around `phrase` in `text`, for the record. */
export function around(text, phrase) {
  const at = text.indexOf(phrase);
  return at < 0 ? text.slice(0, 200) : text.slice(Math.max(0, at - 20), at + phrase.length + 120);
}

export async function accessRow(lane, familiar) {
  const row = new Row(
    'v012-access',
    'Settings › Access: Refresh project access, and a project list the keyboard reaches',
  );
  const { app } = lane;
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
      const before = await settingsText(app);
      row.check(
        'Settings says no access is declared before any grant',
        before.includes(declaresNone(familiar)),
        around(before, declaresNone(familiar)),
      );

      folder = realpathSync(mkdtempSync(join(tmpdir(), 'chat-native-access-')));
      const metadata = caveMetadata(id, folder);
      for (const project of metadata.projects.projects) mkdirSync(project.root);
      mkdirSync(files.cave, { recursive: true });
      const projectBytes = JSON.stringify(metadata.projects);
      const permissionBytes = JSON.stringify(metadata.permissions);
      writeFileSync(files.projects, projectBytes);
      writeFileSync(files.permissions, permissionBytes);
      row.note('synthetic metadata', {
        projects: files.projects,
        permissions: files.permissions,
        projectsSha256: createHash('sha256').update(projectBytes).digest('hex'),
        permissionsSha256: createHash('sha256').update(permissionBytes).digest('hex'),
      });

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

      await closeSettings(app);
      await lane.clearComposer(familiar);
      await app.type('#Access');
      // Native accessibility APIs expose this named list with different roles.
      const suggestions = await app.one(undefined, 'Context suggestions');
      const suggested = namesIn([...walk(suggestions)].map((node) => node.name ?? '').join(' '));
      row.expect(
        'composer # suggestions use the eight declared projects',
        suggested,
        metadata.projects.projects.map((project) => project.name).sort(),
      );
      lane.shot('access-context-suggestions');
      await app.key('escape');
      await lane.clearComposer(familiar);
      await openSettingsAt(app, 'Access');

      // A malformed current store must be visible, remove stale projects, and recover.
      writeFileSync(files.permissions, '{');
      await app.click(await app.one('button', REFRESH, { within: ['dialog', 'Settings'] }));
      const unreadable = await until(
        'an actionable metadata error',
        async () => {
          const text = await settingsText(app);
          return text.includes(UNREADABLE_METADATA) ? text : null;
        },
        30_000,
        500,
      );
      row.check(
        'unreadable stores say access is unknown and offer recovery',
        unreadable.includes('declared access is unknown') && unreadable.includes('then refresh'),
        around(unreadable, UNREADABLE_METADATA),
      );
      row.expect('unreadable metadata clears stale projects', await projectNames(app), []);
      row.check(
        'unreadable is distinct from absent',
        !unreadable.includes(declaresNone(familiar)),
        unreadable,
      );
      lane.shot('access-unreadable');
      writeFileSync(files.permissions, permissionBytes);
      await app.click(await app.one('button', REFRESH, { within: ['dialog', 'Settings'] }));
      const recovered = await until(
        'metadata recovery after repair',
        async () => {
          const text = await settingsText(app);
          return namesIn(text).length === ACCESS_PROJECTS && !text.includes(UNREADABLE_METADATA)
            ? text
            : null;
        },
        30_000,
        500,
      );
      row.expect(
        'repair restores all eight projects',
        namesIn(recovered),
        metadata.projects.projects.map((project) => project.name).sort(),
      );
      row.check(
        'repair clears stale unreadable error',
        !recovered.includes('declared access is unknown'),
        recovered,
      );
      lane.shot('access-recovered');

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
