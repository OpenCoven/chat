import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve, win32 } from 'node:path';

const unixSystemToolDirectories = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
const windowsExecutableExtensions = new Set(['.exe', '.cmd', '.bat', '.com']);
const defaultWindowsPathExt = ['.com', '.exe', '.bat', '.cmd'];
const unsafeWindowsBatchToken = /[&|<>()^%!"\r\n\0]/u;
const safeWindowsBatchToken = /^[A-Za-z0-9 .,:;\\/@+=_~-]+$/u;

function windowsEnvironmentValue(environment, name) {
  const matches = Object.entries(environment).filter(
    ([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === 'string',
  );
  const values = new Set(matches.map(([, value]) => value));
  if (values.size > 1) {
    throw new Error(`Windows ${name} environment is ambiguous.`);
  }
  return matches[0]?.[1];
}

export function normalizeWindowsRealPathForProcess(path) {
  return /^\\\\\?\\[A-Za-z]:\\/u.test(path) ? path.slice(4) : path;
}

function regularExecutable(path, windows) {
  try {
    const stats = lstatSync(path);
    if ((windows && stats.isSymbolicLink()) || (!stats.isFile() && !stats.isSymbolicLink())) {
      return undefined;
    }
    const realPath = realpathSync(path);
    if (!lstatSync(realPath).isFile()) {
      return undefined;
    }
    if (!windows) {
      accessSync(path, constants.X_OK);
    }
    return windows ? normalizeWindowsRealPathForProcess(realPath) : realPath;
  } catch {
    return undefined;
  }
}

function windowsPathExtensions(environment) {
  const configured = windowsEnvironmentValue(environment, 'PATHEXT');
  const entries =
    configured === undefined || configured.length === 0
      ? defaultWindowsPathExt
      : configured.split(';').filter(Boolean);
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const extension = entry.toLowerCase();
    if (!windowsExecutableExtensions.has(extension)) {
      continue;
    }
    if (seen.has(extension)) {
      throw new Error('Windows PATHEXT environment is ambiguous.');
    }
    seen.add(extension);
    normalized.push(extension);
  }
  if (normalized.length === 0) {
    throw new Error('Windows PATHEXT has no supported executable extensions.');
  }
  return normalized;
}

function windowsSearchDirectories(command, environment) {
  if (win32.isAbsolute(command)) {
    return [{ directory: win32.dirname(command), base: win32.basename(command) }];
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new Error('Windows executable paths must be absolute.');
  }
  const configuredPath = windowsEnvironmentValue(environment, 'PATH') ?? '';
  const entries = configuredPath.split(';').filter((entry) => entry.length > 0);
  if (
    entries.some(
      (entry) => entry !== entry.trim() || entry.includes('"') || !win32.isAbsolute(entry),
    )
  ) {
    throw new Error('Windows PATH contains an unsafe search entry.');
  }
  return entries.map((directory) => ({ directory, base: command }));
}

function resolveWindowsCommand(command, environment) {
  const extension = win32.extname(command).toLowerCase();
  if (extension.length > 0 && !windowsExecutableExtensions.has(extension)) {
    throw new Error('Windows executable extension is unsupported.');
  }
  const extensions = extension.length > 0 ? [''] : windowsPathExtensions(environment);
  for (const { directory, base } of windowsSearchDirectories(command, environment)) {
    for (const suffix of extensions) {
      const candidate = regularExecutable(win32.resolve(directory, `${base}${suffix}`), true);
      if (candidate !== undefined) {
        return { path: candidate, extension: win32.extname(candidate).toLowerCase() };
      }
    }
  }
  throw new Error('Supervised executable is unavailable.');
}

function resolveCanonicalWindowsCorepack(args) {
  const runningNode = regularExecutable(process.execPath, true);
  const expectedNode = regularExecutable(
    win32.resolve(win32.dirname(process.execPath), 'node.exe'),
    true,
  );
  const corepackScript = regularExecutable(
    win32.resolve(
      win32.dirname(process.execPath),
      'node_modules',
      'corepack',
      'dist',
      'corepack.js',
    ),
    true,
  );
  if (
    runningNode === undefined ||
    expectedNode === undefined ||
    runningNode !== expectedNode ||
    corepackScript === undefined
  ) {
    throw new Error('Canonical Windows Corepack installation is unavailable.');
  }
  return Object.freeze({
    executable: runningNode,
    args: Object.freeze([corepackScript, ...args]),
    resolvedCommand: corepackScript,
  });
}

export function quoteWindowsBatchCommand(batchPath, args) {
  const tokens = [batchPath, ...args];
  if (
    tokens.some(
      (token) =>
        typeof token !== 'string' ||
        token.length === 0 ||
        unsafeWindowsBatchToken.test(token) ||
        !safeWindowsBatchToken.test(token),
    )
  ) {
    throw new Error('Windows batch invocation contains an unsafe token.');
  }
  return `call ${tokens.map((token) => `"${token}"`).join(' ')}`;
}

export function resolveExecutableInvocation(
  command,
  environment = process.env,
  platform = process.platform,
  args = [],
) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('Supervised executable must be a non-empty string.');
  }
  if (platform !== 'win32') {
    const candidates = isAbsolute(command)
      ? [command]
      : (environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((entry) => resolve(entry, command));
    const invocation = candidates
      .map((candidate) => {
        const resolvedCommand = regularExecutable(candidate, false);
        return resolvedCommand === undefined
          ? undefined
          : { executable: candidate, resolvedCommand };
      })
      .find((candidate) => candidate !== undefined);
    if (invocation === undefined) {
      throw new Error('Supervised executable is unavailable.');
    }
    return Object.freeze({
      executable: invocation.executable,
      args: Object.freeze([...args]),
      resolvedCommand: invocation.resolvedCommand,
    });
  }

  const requestedBase = win32.basename(command).toLowerCase();
  if (requestedBase === 'corepack') {
    if (command.includes('/') || command.includes('\\') || win32.isAbsolute(command)) {
      throw new Error('Windows Corepack must be requested by its logical command name.');
    }
    return resolveCanonicalWindowsCorepack(args);
  }
  if (['corepack.exe', 'corepack.com', 'corepack.cmd', 'corepack.bat'].includes(requestedBase)) {
    throw new Error('Explicit Windows Corepack shim requests are forbidden.');
  }

  const resolved = resolveWindowsCommand(command, environment);
  if (resolved.extension !== '.cmd' && resolved.extension !== '.bat') {
    return Object.freeze({
      executable: resolved.path,
      args: Object.freeze([...args]),
      resolvedCommand: resolved.path,
    });
  }

  const comspec = windowsEnvironmentValue(environment, 'COMSPEC');
  if (typeof comspec !== 'string' || !win32.isAbsolute(comspec)) {
    throw new Error('Windows command interpreter is unavailable.');
  }
  const interpreter = regularExecutable(comspec, true);
  if (
    interpreter === undefined ||
    !['.exe', '.com'].includes(win32.extname(interpreter).toLowerCase())
  ) {
    throw new Error('Windows command interpreter is unavailable.');
  }
  quoteWindowsBatchCommand(resolved.path, args);
  return Object.freeze({
    executable: interpreter,
    args: Object.freeze(['/d', '/s', '/c', resolved.path, ...args]),
    resolvedCommand: resolved.path,
  });
}

// Builds a minimal Unix PATH for a supervised, isolated child process. Each
// entry is the directory of one exactly resolved required executable (found
// through the caller's own ambient PATH), never the ambient PATH itself, so
// unrelated or unsafe ambient entries can never reach the isolated process.
// The four fixed system directories are always appended. Throws (fails
// closed) if any required command cannot be resolved to a safe absolute
// executable.
export function resolveUnixToolPath(
  commands,
  environment = process.env,
  platform = process.platform,
) {
  if (platform === 'win32') {
    throw new Error('Reviewed Unix tool path resolution requires a non-Windows platform.');
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('Reviewed Unix tool path resolution requires at least one command.');
  }
  const directories = commands.map((command) => {
    const invocation = resolveExecutableInvocation(command, environment, platform, []);
    return dirname(invocation.executable);
  });
  directories.push(...unixSystemToolDirectories);

  const seen = new Set();
  const reviewed = [];
  for (const directory of directories) {
    if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
      throw new Error('Resolved Unix tool directory is unsafe.');
    }
    if (!seen.has(directory)) {
      seen.add(directory);
      reviewed.push(directory);
    }
  }
  return reviewed.join(':');
}
