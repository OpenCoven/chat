import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const safeArtifactSegmentPattern = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function assertSafeArtifactSegment(segment, label = 'Artifact name') {
  if (!safeArtifactSegmentPattern.test(segment)) {
    throw new Error(
      `${label} "${segment}" must be a safe child name using only letters, digits, ".", "_" or "-".`,
    );
  }
}

function assertDescendantPath(basePath, targetPath, label) {
  const normalizedRelativePath = relative(resolve(basePath), resolve(targetPath));

  if (
    normalizedRelativePath.length === 0 ||
    normalizedRelativePath === '..' ||
    normalizedRelativePath.startsWith(`..${sep}`) ||
    normalizedRelativePath.split(sep).includes('..')
  ) {
    throw new Error(`${label} must stay inside a child of ${resolve(basePath)}.`);
  }
}

function assertRealPathWithin(baseRealPath, targetRealPath, label, { allowEqual = true } = {}) {
  const normalizedRelativePath = relative(resolve(baseRealPath), resolve(targetRealPath));

  if (
    (!allowEqual && normalizedRelativePath.length === 0) ||
    normalizedRelativePath === '..' ||
    normalizedRelativePath.startsWith(`..${sep}`) ||
    normalizedRelativePath.split(sep).includes('..')
  ) {
    throw new Error(`${label} must stay inside ${resolve(baseRealPath)}.`);
  }
}

function resolveTrustedRepositoryRoot(repositoryRoot) {
  const trustedRepositoryRoot = realpathSync(repositoryRoot);
  const stats = lstatSync(trustedRepositoryRoot);

  if (!stats.isDirectory()) {
    throw new Error(`Repository root must be a directory: ${trustedRepositoryRoot}`);
  }

  return trustedRepositoryRoot;
}

function ensureRealDirectoryChain(rootPath, segments, label) {
  let currentPath = rootPath;
  let currentRealPath = realpathSync(currentPath);

  for (const segment of segments) {
    if (segment !== '.artifacts') {
      assertSafeArtifactSegment(segment, 'Artifact path segment');
    }

    currentPath = resolve(currentPath, segment);

    const stats = lstatIfExists(currentPath);

    if (stats === undefined) {
      mkdirSync(currentPath);
    } else if (stats.isSymbolicLink()) {
      throw new Error(`${label} component must not be a symlink: ${currentPath}`);
    } else if (!stats.isDirectory()) {
      throw new Error(`${label} component must be a directory: ${currentPath}`);
    }

    const nextRealPath = realpathSync(currentPath);
    assertRealPathWithin(currentRealPath, nextRealPath, `${label} component`, {
      allowEqual: false,
    });
    currentRealPath = nextRealPath;
  }

  return {
    path: currentPath,
    realPath: currentRealPath,
  };
}

function assertCleanupChain(targetPath, artifactBasePath, artifactBaseRealPath) {
  const normalizedBasePath = resolve(artifactBasePath);
  const normalizedTargetPath = resolve(targetPath);
  assertDescendantPath(normalizedBasePath, normalizedTargetPath, 'Artifact cleanup path');

  const segments = relative(normalizedBasePath, normalizedTargetPath).split(sep).filter(Boolean);
  let currentPath = normalizedBasePath;

  for (let index = 0; index < segments.length - 1; index += 1) {
    currentPath = resolve(currentPath, segments[index]);
    const stats = lstatIfExists(currentPath);

    if (stats === undefined) {
      return;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Artifact cleanup ancestor must not be a symlink: ${currentPath}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Artifact cleanup ancestor must be a directory: ${currentPath}`);
    }

    assertRealPathWithin(
      artifactBaseRealPath,
      realpathSync(currentPath),
      'Artifact cleanup parent chain',
    );
  }

  const targetStats = lstatIfExists(normalizedTargetPath);

  if (targetStats === undefined || targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    return;
  }

  assertRealPathWithin(
    artifactBaseRealPath,
    realpathSync(normalizedTargetPath),
    'Artifact cleanup path',
    { allowEqual: false },
  );
}

function removePathWithoutFollowingSymlinks(path) {
  const stats = lstatIfExists(path);

  if (stats === undefined) {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unlinkSync(path);
    return;
  }

  for (const entry of readdirSync(path)) {
    removePathWithoutFollowingSymlinks(resolve(path, entry));
  }

  rmdirSync(path);
}

export function resolveArtifactDirectoryContext({
  repositoryRoot,
  parentSegments = [],
  parentLabel = 'Artifact directory',
} = {}) {
  const trustedRepositoryRoot = resolveTrustedRepositoryRoot(repositoryRoot);
  const artifactBase = ensureRealDirectoryChain(
    trustedRepositoryRoot,
    ['.artifacts'],
    'Artifact base directory',
  );
  const parentDirectory = ensureRealDirectoryChain(artifactBase.path, parentSegments, parentLabel);

  return {
    artifactBasePath: artifactBase.path,
    artifactBaseRealPath: artifactBase.realPath,
    parentPath: parentDirectory.path,
    parentRealPath: parentDirectory.realPath,
    repositoryRoot: trustedRepositoryRoot,
  };
}

export function resolveArtifactDirectory({
  repositoryRoot,
  parentSegments = [],
  artifactName,
  artifactNameLabel = 'Artifact name',
  parentLabel = 'Artifact directory',
} = {}) {
  assertSafeArtifactSegment(artifactName, artifactNameLabel);

  const context = resolveArtifactDirectoryContext({
    repositoryRoot,
    parentSegments,
    parentLabel,
  });

  return {
    ...context,
    artifactPath: resolve(context.parentPath, artifactName),
  };
}

export function removeArtifactPath(targetPath, context) {
  assertCleanupChain(targetPath, context.artifactBasePath, context.artifactBaseRealPath);
  removePathWithoutFollowingSymlinks(resolve(targetPath));
}

export function prepareArtifactDirectory({
  repositoryRoot,
  parentSegments = [],
  artifactName,
  artifactNameLabel = 'Artifact name',
  parentLabel = 'Artifact directory',
} = {}) {
  const context = resolveArtifactDirectory({
    repositoryRoot,
    parentSegments,
    artifactName,
    artifactNameLabel,
    parentLabel,
  });

  removeArtifactPath(context.artifactPath, context);

  return {
    ...context,
    artifactPath: ensureRealDirectoryChain(context.parentPath, [artifactName], artifactNameLabel)
      .path,
  };
}
