import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  decodeWindowsSupervisorSource,
  renderWindowsSupervisorSource,
} from '../scripts/windows-supervisor-source.mjs';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(resolve('scripts/windows-job-supervisor.cs'));
const expected = { size: source.length, sha256: sha256(source) };
const sentinel = Buffer.from(
  'public static class BoundedSourceSentinel { public static int Value = 42; }\n',
);

function replacePayload(block: string, bytes: Buffer): string {
  const encoded = bytes.toString('base64');
  return block
    .replace(/\$encodedSupervisor = @'\n[\s\S]*?\n'@/u, `$encodedSupervisor = @'\n${encoded}\n'@`)
    .replace(
      /\$encodedSupervisor.Length -ne \d+/u,
      `$encodedSupervisor.Length -ne ${encoded.length}`,
    )
    .replace(
      /\$compressedSupervisor.Length -ne \d+/u,
      `$compressedSupervisor.Length -ne ${bytes.length}`,
    )
    .replace(
      /\$compressedSupervisorDigest -cne '[a-f0-9]{64}'/u,
      `$compressedSupervisorDigest -cne '${sha256(bytes)}'`,
    );
}

function runPowerShell(block: string) {
  const script = `$ErrorActionPreference = 'Stop'\ntry {\n${block}\nAdd-Type -TypeDefinition $jobSupervisorSource -Language CSharp\nWrite-Output 'COMPILED'\n} catch { Write-Output 'REJECTED'; exit 19 }\n`;
  const directory = mkdtempSync(resolve(tmpdir(), 'chat-supervisor-codec-'));
  try {
    const scriptPath = resolve(directory, 'compile.ps1');
    writeFileSync(scriptPath, script);
    return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

describe('bounded Windows supervisor source', () => {
  test('verifies the checked-in workflow payload with the current platform compressor', () => {
    const workflow = readFileSync(resolve('.github/workflows/client-v1-conformance.yml'), 'utf8');
    const start = workflow.indexOf('          # BEGIN bounded Windows supervisor source v1');
    const endMarker = '          # END bounded Windows supervisor source v1';
    const end = workflow.indexOf(endMarker, start) + endMarker.length;
    expect(start).toBeGreaterThan(-1);
    const block = workflow
      .slice(start, end)
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n');
    expect(decodeWindowsSupervisorSource(block, expected)).toEqual(source);
    if (process.platform === 'win32') expect(pwshAvailable).toBe(true);
  });

  test('uses a platform-neutral gzip header for cross-platform canonical verification', () => {
    const block = renderWindowsSupervisorSource(source);
    const encoded = /\$encodedSupervisor = @'\n([^\n]+)/u.exec(block)?.[1];
    expect(encoded).toBeDefined();
    expect([...Buffer.from(encoded ?? '', 'base64').subarray(0, 10)]).toEqual([
      31, 139, 8, 0, 0, 0, 0, 0, 2, 255,
    ]);
  });

  test('retains exact canonical C# bytes with enough workflow capacity for root repair', () => {
    const block = renderWindowsSupervisorSource(source);
    expect(Buffer.byteLength(block)).toBeLessThan(100_000);
    expect(decodeWindowsSupervisorSource(block, expected)).toEqual(source);
    expect(renderWindowsSupervisorSource(source)).toBe(block);
  });

  test('rejects altered decoder or compile injection even with intact source bytes', () => {
    const block = renderWindowsSupervisorSource(source);
    for (const changed of [
      block.replace('ReadByte() -ne -1', 'ReadByte() -ne -2'),
      block.replace('$jobSupervisorSource =', "$jobSupervisorSource = 'injected'; $unused ="),
      `${block}\nAdd-Type -TypeDefinition 'injected'`,
    ])
      expect(() => decodeWindowsSupervisorSource(changed, expected)).toThrow();
  });

  test('requires caller-owned source identity and valid bounded sizes', () => {
    const block = renderWindowsSupervisorSource(source);
    for (const identity of [
      { ...expected, size: expected.size - 1 },
      { ...expected, sha256: '0'.repeat(64) },
      { ...expected, size: 0 },
      { ...expected, size: 1_048_577 },
    ])
      expect(() => decodeWindowsSupervisorSource(block, identity)).toThrow();
    expect(() => renderWindowsSupervisorSource(Buffer.alloc(1_048_577))).toThrow();
  });

  test('rejects trailing gzip data and noncanonical payloads even with refreshed compressed hashes', () => {
    const block = renderWindowsSupervisorSource(source);
    const encoded = /\$encodedSupervisor = @'\n([^\n]+)/u.exec(block)?.[1];
    expect(encoded).toBeDefined();
    const compressed = Buffer.from(encoded ?? '', 'base64');
    expect(decodeWindowsSupervisorSource(replacePayload(block, compressed), expected)).toEqual(
      source,
    );
    const alternateCompression = gzipSync(source, { level: 1 });
    alternateCompression[9] = 255;
    for (const payload of [
      Buffer.concat([compressed, Buffer.alloc(4)]),
      Buffer.concat([compressed, gzipSync(Buffer.from('extra'))]),
      alternateCompression,
      Buffer.from('not gzip'),
    ])
      expect(() =>
        decodeWindowsSupervisorSource(replacePayload(block, payload), expected),
      ).toThrow();
  });

  test.skipIf(!pwshAvailable)('PowerShell decodes and compiles the complete supervisor', () => {
    const result = runPowerShell(renderWindowsSupervisorSource(source));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('COMPILED');
  });

  test.skipIf(!pwshAvailable)('PowerShell decodes and compiles the verified source', () => {
    const result = runPowerShell(renderWindowsSupervisorSource(sentinel));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('COMPILED');
  });

  test.skipIf(!pwshAvailable)(
    'PowerShell rejects invalid size, digest and payload before compilation',
    () => {
      const block = renderWindowsSupervisorSource(sentinel);
      for (const invalid of [
        block.replace(
          `$supervisorSourceSize = ${sentinel.length}`,
          `$supervisorSourceSize = ${sentinel.length - 1}`,
        ),
        block.replace(
          `$supervisorSourceSize = ${sentinel.length}`,
          `$supervisorSourceSize = ${sentinel.length + 1}`,
        ),
        block.replace(sha256(sentinel), '0'.repeat(64)),
        block.replace("$encodedSupervisor = @'\n", "$encodedSupervisor = @'\n!"),
        replacePayload(block, Buffer.from('not gzip')),
        replacePayload(block, gzipSync(Buffer.from([0xff])))
          .replace(`$supervisorSourceSize = ${sentinel.length}`, '$supervisorSourceSize = 1')
          .replace(sha256(sentinel), sha256(Buffer.from([0xff]))),
      ]) {
        const result = runPowerShell(invalid);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(19);
        expect(result.stdout).not.toContain('COMPILED');
      }
    },
  );
});
