import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autofillUpgradeRow } from './upgrade.mjs';

test('uses the executable installed by the older MSI for its version check and launch', async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'chat-native-upgrade-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const oldExe = join(out, 'OpenCoven Chat', 'opencoven-chat.exe');
  mkdirSync(join(out, 'OpenCoven Chat'));
  writeFileSync(oldExe, 'v0.0.8 executable');

  const versionChecks = [];
  const launches = [];
  const row = await autofillUpgradeRow({
    from: { path: 'v0.0.8.msi', label: 'published msi v0.0.8' },
    to: { path: 'candidate.msi', label: 'candidate' },
    exe: 'candidate.exe',
    installedSha: 'candidate sha',
    launch: async (logName, app) => {
      launches.push({ logName, app });
      throw new Error('stop after checking the launch path');
    },
    shot: () => undefined,
    out,
    familiars: ['Astra', 'Sage'],
    resolveInstalledExe: () => oldExe,
    installMsi: () => 0,
    waitForWebViewGone: async () => true,
    getProductVersion: (app) => {
      versionChecks.push(app);
      return '0.0.8';
    },
  });

  assert.deepEqual(versionChecks, [oldExe]);
  assert.deepEqual(launches, [{ logName: 'app-v0.0.8.log', app: oldExe }]);
  assert.equal(
    row.observations.find(({ label }) => label === 'installed app').value.sha256,
    createHash('sha256').update('v0.0.8 executable').digest('hex'),
  );
});
