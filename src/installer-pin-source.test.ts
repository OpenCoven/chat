import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const path = '../scripts/native-acceptance/installer-pin-source.mjs';
const { installerPin, macAsset, pinFor, pinSource } = await import(path);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, pinSource), 'utf8');
const script = readFileSync(resolve(root, 'scripts/native-acceptance/installer-pin.mjs'), 'utf8');

// Read the table a second way, by its match arms, so the parser can't agree with itself.
function armDigest(arch: string) {
  const arm = new RegExp(
    String.raw`\("macos", "${arch}"\) => Some\(release\(\s*"([^"]+)",\s*"([^"]+)"`,
  ).exec(source);
  return arm && { asset: arm[1], sha256: arm[2] };
}

test("the check reads the installer's version and both macOS digests", () => {
  const pin = installerPin(source);
  expect(pin.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  expect(source).toContain(`const COVEN_VERSION: &str = "${pin.version}";`);
  expect(Object.keys(pin.macos).sort()).toEqual(['aarch64', 'x64']);
  const arches: [string, string][] = [
    ['aarch64', 'aarch64'],
    ['x64', 'x86_64'],
  ];
  for (const [arch, rustArch] of arches) {
    expect(pin.macos[arch].asset).toBe(macAsset(pin.version, arch));
    expect(pin.macos[arch].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.macos[arch]).toEqual(armDigest(rustArch));
  }
  expect(pin.macos.aarch64.sha256).not.toBe(pin.macos.x64.sha256);
});

test('the script downloads the archive the parser names for this Mac', () => {
  const pin = installerPin(source);
  expect(pinFor(source, 'arm64')).toEqual({ version: pin.version, ...pin.macos.aarch64 });
  expect(pinFor(source, 'x64')).toEqual({ version: pin.version, ...pin.macos.x64 });
  expect(() => pinFor(source, 'ia32')).toThrow('No macOS Coven archive for ia32');
  // The script takes its pin from this module, not a copy of the parsing.
  expect(script).toContain("from './installer-pin-source.mjs'");
  expect(script).toContain("pinFor(readFileSync(pinSource, 'utf8'), process.arch)");
  expect(script).not.toMatch(/COVEN_VERSION|\[0-9a-f\]\{64\}/);
});

test('a reformatted release table fails loudly instead of returning part of the pin', () => {
  const { version, macos } = installerPin(source);
  // Struct fields instead of positional arguments: the digest no longer follows the name.
  const named = source.replace(
    `"${macos.x64.asset}",\n            "${macos.x64.sha256}",`,
    `asset: "${macos.x64.asset}",\n            sha256: "${macos.x64.sha256}",`,
  );
  expect(named).not.toBe(source);
  expect(() => installerPin(named)).toThrow(
    `Cannot find the digest for ${macos.x64.asset} in ${pinSource}`,
  );
  expect(() => pinFor(named, 'arm64')).toThrow(macos.x64.asset);
  // The version moves into a different declaration.
  const moved = source.replace(
    `const COVEN_VERSION: &str = "${version}";`,
    `const COVEN_VERSION: Version = Version::new("${version}");`,
  );
  expect(moved).not.toBe(source);
  expect(() => installerPin(moved)).toThrow(`Cannot find COVEN_VERSION in ${pinSource}`);
  // The version is bumped without renaming the archives.
  const bumped = source.replace(
    `const COVEN_VERSION: &str = "${version}";`,
    'const COVEN_VERSION: &str = "9.9.9";',
  );
  expect(() => installerPin(bumped)).toThrow('coven-v9.9.9-macos-aarch64.tar.gz');
});
