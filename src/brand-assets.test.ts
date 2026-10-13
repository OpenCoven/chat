import { readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { canonicalIcns, opaquePng } from '../scripts/render-brand-icons.mjs';

const read = (path: string) => readFileSync(path);
const iosAssets = 'apps/ios/ChatCompanion/Resources/Assets.xcassets';

function pngHeader(bytes: Buffer) {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes[24],
    colorType: bytes[25],
  };
}

const value = (x: number, y: number, channel: number) => (31 * x + 17 * y + 53 * channel) & 0xff;

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** An RGBA PNG whose rows alternate the Sub and Up filters. */
function rgbaPng(width: number, height: number, alpha: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixel = (x: number, y: number, channel: number) =>
    channel === 3 ? alpha : value(x, y, channel);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = y === 0 || y % 2 === 0 ? 1 : 2;
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 4; channel++) {
        const predictor =
          row[0] === 1 ? (x > 0 ? pixel(x - 1, y, channel) : 0) : pixel(x, y - 1, channel);
        row[1 + x * 4 + channel] = (pixel(x, y, channel) - predictor) & 0xff;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('Coven Chat brand assets', () => {
  test('vector copies match their sources in assets/brand', () => {
    expect(read('public/favicon.svg').equals(read('assets/brand/chat-app-icon-rounded.svg'))).toBe(
      true,
    );
    expect(
      read(`${iosAssets}/ChatLogo.imageset/ChatLogo.svg`).equals(
        read('assets/brand/chat-logo.svg'),
      ),
    ).toBe(true);
  });

  test('the iOS app icon is an opaque 1024 px square', () => {
    const icon = pngHeader(read(`${iosAssets}/AppIcon.appiconset/AppIcon-1024.png`));
    expect(icon).toEqual({ width: 1024, height: 1024, depth: 8, colorType: 2 });
    expect(pngHeader(read('public/apple-touch-icon.png'))).toEqual({
      width: 180,
      height: 180,
      depth: 8,
      colorType: 2,
    });
  });

  test('desktop bundle PNGs have the sizes tauri.conf.json names', () => {
    for (const [name, size] of [
      ['32x32.png', 32],
      ['128x128.png', 128],
      ['128x128@2x.png', 256],
      ['icon.png', 512],
    ] as const) {
      const icon = pngHeader(read(`src-tauri/icons/${name}`));
      expect([icon.width, icon.height], name).toEqual([size, size]);
    }
  });

  test('every logo source carries the canonical crown and an outlined bubble', () => {
    const crown = read('assets/brand/chat-logo.svg')
      .toString('utf8')
      .match(/fill-rule="evenodd" d="([^"]+)"/u)?.[1];
    expect(crown).toMatch(/^M 374\.062 9\.750 C/u);
    for (const name of ['chat-logo.svg', 'chat-app-icon.svg', 'chat-app-icon-rounded.svg']) {
      const source = read(`assets/brand/${name}`).toString('utf8');
      expect(source, name).toContain(`d="${crown}"`);
      expect(source, name).toContain('scale(0.67)');
      expect(source, name).toContain('fill="none" stroke=');
    }
  });

  test('opaquePng keeps every colour value and drops only the alpha channel', () => {
    const output = opaquePng(rgbaPng(3, 4, 255));
    expect(pngHeader(output)).toEqual({ width: 3, height: 4, depth: 8, colorType: 2 });
    const data = output.subarray(33 + 8, output.length - 12 - 4);
    expect(output.subarray(37, 41).toString('latin1')).toBe('IDAT');
    const raw = inflateSync(data);
    for (let y = 0; y < 4; y++) {
      expect(raw[y * 10], `row ${y} filter`).toBe(0);
      for (let x = 0; x < 3; x++) {
        for (let channel = 0; channel < 3; channel++) {
          expect(raw[y * 10 + 1 + x * 3 + channel]).toBe(value(x, y, channel));
        }
      }
    }
  });

  test('opaquePng refuses an image with transparent pixels', () => {
    expect(() => opaquePng(rgbaPng(3, 4, 128))).toThrow(/not opaque/u);
  });

  test('the desktop ICNS keeps its entries in canonical order', () => {
    const icns = read('src-tauri/icons/icon.icns');
    expect(canonicalIcns(icns).equals(icns)).toBe(true);
    const entry = (type: string, body: string) => {
      const out = Buffer.alloc(8 + body.length);
      out.write(type, 0, 'latin1');
      out.writeUInt32BE(8 + body.length, 4);
      out.write(body, 8, 'latin1');
      return out;
    };
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'latin1');
    const shuffled = [entry('ic10', 'b'), entry('ic07', 'a'), entry('is32', 'c')];
    const total = 8 + shuffled.reduce((sum, item) => sum + item.length, 0);
    header.writeUInt32BE(total, 4);
    const sorted = canonicalIcns(Buffer.concat([header, ...shuffled]));
    expect(sorted.toString('latin1', 8)).toBe(
      [entry('ic07', 'a'), entry('ic10', 'b'), entry('is32', 'c')]
        .map((item) => item.toString('latin1'))
        .join(''),
    );
  });
});
