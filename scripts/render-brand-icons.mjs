#!/usr/bin/env node
/**
 * Regenerates every raster logo export from the vector sources in
 * `assets/brand` (see assets/brand/README.md for provenance and usage).
 *
 *   node scripts/render-brand-icons.mjs
 *
 * Rendering uses the pinned Tauri CLI's `tauri icon`, so no image tool beyond
 * the locked dependencies is needed. The iOS App Store icon must not carry an
 * alpha channel, which `tauri icon` keeps, so `opaquePng` re-encodes it as RGB
 * after proving every pixel is already opaque.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, 'assets', 'brand');
const iosAssets = join(root, 'apps', 'ios', 'ChatCompanion', 'Resources', 'Assets.xcassets');
const INK = '#050409';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Re-encodes an 8-bit, non-interlaced RGBA PNG as RGB. Throws when the input
 * is any other format or when a pixel is not fully opaque, so a transparent
 * source can never be flattened silently.
 */
export function opaquePng(input) {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');
  let offset = 8;
  let header;
  const data = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('latin1', offset + 4, offset + 8);
    const body = input.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = body;
    if (type === 'IDAT') data.push(body);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (!header) throw new Error('PNG has no IHDR chunk.');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colorType, , , interlace] = header.subarray(8, 13);
  if (depth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error('Expected an 8-bit, non-interlaced RGBA PNG.');
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has the wrong size.');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? (left + up) >> 1
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : -1;
      if (predictor < 0) throw new Error(`Unknown PNG filter ${filter}.`);
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  const rgb = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const source = y * stride + x * 4;
      if (pixels[source + 3] !== 255) {
        throw new Error(`Pixel ${x},${y} is not opaque; refusing to drop its alpha.`);
      }
      pixels.copy(rgb, row + 1 + x * 3, source, source + 3);
    }
  }
  const outputHeader = Buffer.from(header);
  outputHeader[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', outputHeader),
    chunk('IDAT', deflateSync(rgb, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `tauri icon` writes ICNS entries in a different order on each run, though
 * every image is identical. Sorting them by type makes the export reproducible.
 */
export function canonicalIcns(input) {
  if (input.toString('latin1', 0, 4) !== 'icns' || input.readUInt32BE(4) !== input.length) {
    throw new Error('Not an ICNS file.');
  }
  const entries = [];
  for (let offset = 8; offset < input.length; ) {
    const length = input.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > input.length) throw new Error('Malformed ICNS entry.');
    entries.push(input.subarray(offset, offset + length));
    offset += length;
  }
  entries.sort((a, b) => a.toString('latin1', 0, 4).localeCompare(b.toString('latin1', 0, 4)));
  return Buffer.concat([input.subarray(0, 8), ...entries]);
}

function tauriIcon(source, output) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
      'icon',
      source,
      '--output',
      output,
      '--ios-color',
      INK,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`tauri icon failed for ${source}.`);
  }
}

function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'chat-brand-icons-'));
  try {
    // Desktop bundles use the rounded cutout, since macOS, Windows and Linux do not mask icons.
    const desktop = join(scratch, 'desktop');
    tauriIcon(join(brand, 'chat-app-icon-rounded.svg'), desktop);
    for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.png']) {
      copyFileSync(join(desktop, name), join(root, 'src-tauri', 'icons', name));
    }
    writeFileSync(
      join(root, 'src-tauri', 'icons', 'icon.icns'),
      canonicalIcns(readFileSync(join(desktop, 'icon.icns'))),
    );

    // iOS masks its own corners, so the App Store icon is the opaque square.
    const square = join(scratch, 'square');
    tauriIcon(join(brand, 'chat-app-icon.svg'), square);
    writeFileSync(
      join(iosAssets, 'AppIcon.appiconset', 'AppIcon-1024.png'),
      opaquePng(readFileSync(join(square, 'ios', 'AppIcon-512@2x.png'))),
    );
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(
      join(root, 'public', 'apple-touch-icon.png'),
      opaquePng(readFileSync(join(square, 'ios', 'AppIcon-60x60@3x.png'))),
    );

    // Vector copies are byte-identical to their sources; src/brand-assets.test.ts checks them.
    copyFileSync(join(brand, 'chat-app-icon-rounded.svg'), join(root, 'public', 'favicon.svg'));
    copyFileSync(
      join(brand, 'chat-logo.svg'),
      join(iosAssets, 'ChatLogo.imageset', 'ChatLogo.svg'),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
