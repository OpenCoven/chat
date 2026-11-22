// Reads Chat's pinned Coven release out of the installer source, so the
// installer-pin check downloads and verifies exactly what Chat would install.
// src/installer-pin-source.test.ts runs this over the real file.

export const pinSource = 'src-tauri/src/coven_install.rs';

/** The macOS architectures in the installer's release table, by Node's `process.arch`. */
export const macArches = { arm64: 'aarch64', x64: 'x64' };

/** The release archive name for one macOS architecture. */
export const macAsset = (version, arch) => `coven-v${version}-macos-${arch}.tar.gz`;

/**
 * The pinned version and both macOS archives with their SHA-256 digests.
 * Throws, naming what it couldn't find, rather than return part of the pin.
 */
export function installerPin(source) {
  const version = source.match(/const COVEN_VERSION: &str = "([^"]+)"/)?.[1];
  if (!version) {
    throw new Error(`Cannot find COVEN_VERSION in ${pinSource}; did its format change?`);
  }
  const macos = {};
  for (const arch of Object.values(macArches)) {
    const asset = macAsset(version, arch);
    const sha256 = source.split(`"${asset}",`)[1]?.match(/^\s*"([0-9a-f]{64})"/)?.[1];
    if (!sha256) {
      throw new Error(
        `Cannot find the digest for ${asset} in ${pinSource}: expected the asset name, then its 64-hex SHA-256 as the next string`,
      );
    }
    macos[arch] = { asset, sha256 };
  }
  return { version, macos };
}

/** The archive the check downloads on this Mac. */
export function pinFor(source, nodeArch) {
  const pin = installerPin(source);
  const arch = macArches[nodeArch];
  if (!arch) throw new Error(`No macOS Coven archive for ${nodeArch}`);
  return { version: pin.version, ...pin.macos[arch] };
}
