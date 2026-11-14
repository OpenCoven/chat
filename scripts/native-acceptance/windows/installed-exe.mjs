// Bounded Windows installation discovery, shared by the lane and row 578.
// Never search caches or unrelated directories for a similarly named binary.
import { statSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EARLIER_NAMES = ['OpenCoven Chat'];

/** The current executable, then its counterparts under earlier product names. */
export function installPaths(exe, names = EARLIER_NAMES) {
  const paths = /\\|^[a-z]:/i.test(exe) ? win32 : posix;
  const parent = paths.dirname(paths.dirname(exe));
  const binary = paths.basename(exe);
  return [...new Set([exe, ...names.map((name) => paths.join(parent, name, binary))])];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Caller supplies stage-specific preference: old first for staging, new first after upgrade. */
export function installedAt(paths, exists = isFile) {
  return paths.find((path) => exists(path)) ?? null;
}

/** Known installer locations only; per-user and machine-wide, current name first. */
export function knownInstallPaths(env = process.env) {
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
    env.LOCALAPPDATA,
    env.ProgramFiles,
  ].filter(Boolean);
  return ['Coven Chat', ...EARLIER_NAMES].flatMap((name) =>
    roots.map((root) => join(root, name, 'opencoven-chat.exe')),
  );
}

// PowerShell invokes this same file after initial installation. Upgrade staging
// imports installedAt and supplies the version-specific locations in its own order.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exe = installedAt(knownInstallPaths());
  if (!exe) {
    console.error('The installed opencoven-chat.exe was not found in known installer locations.');
    process.exitCode = 1;
  } else {
    console.log(exe);
  }
}
