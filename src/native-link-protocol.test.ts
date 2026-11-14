import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('Windows server routes one verified link command and preserves complete success/refusal receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-link-protocol-'));
  try {
    const server = resolve('scripts/native-acceptance/windows/serve.ps1');
    const native = resolve('scripts/native-acceptance/windows/NativeDriver.ps1');
    // UIA and SendInput require Windows. Replace only that external boundary;
    // execute the real server parser, routing and raw JSON response path.
    const source = readFileSync(server, 'utf8').replace(
      /^\. \(Join-Path \$PSScriptRoot 'NativeDriver.ps1'\)\r?\n/m,
      '',
    );
    const runner = join(directory, 'server.ps1');
    writeFileSync(
      runner,
      `param([string]$native, [string]$server)
$ErrorActionPreference = 'Stop'
foreach ($file in @($native, $server)) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) > $null
  if ($errors.Count) { throw ($errors | Out-String) }
}
Add-Type -TypeDefinition @'
using System.Text.Json;
public static class NativeDriver {
  static int calls;
  public static object Window(int pid) { return pid == 123 ? new object() : null; }
  public static string Tree(int pid, int depth, int budget) {
    return JsonSerializer.Serialize(new { pid, depth, budget, children = new[] { new { name = "raw frame", frame = new { x = 1, y = 2, w = 3, h = 4 } } } });
  }
  public static string ClickLink(int pid, int x, int y, string name) {
    calls++;
    if (name == "Native fault") throw new System.InvalidOperationException("native fault before input");
    return JsonSerializer.Serialize(new { clicked = name == "Named login", pid, x, y, name, calls, error = name == "Named login" ? null : "covered; no click sent" });
  }
}
'@
` + source,
    );
    const input = `${[
      { id: 1, cmd: 'target', pid: 123 },
      { id: 2, cmd: 'clickLink', at: [450, 410], name: 'Named login' },
      { id: 3, cmd: 'clickLink', at: [650, 810], name: 'Covered link' },
      { id: 4, cmd: 'clickLink', at: [650, 410], name: 'Native fault' },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n')}\n`;
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', runner, native, server],
      { input, encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const replies = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(replies[0]).toMatchObject({ id: 1, ok: true });
    expect(replies[1]).toMatchObject({
      id: 2,
      ok: true,
      receipt: { clicked: true, pid: 123, x: 450, y: 410, name: 'Named login', calls: 1 },
    });
    expect(replies[2]).toMatchObject({
      id: 3,
      ok: false,
      error: 'covered; no click sent',
      receipt: { clicked: false, pid: 123, x: 650, y: 810, name: 'Covered link', calls: 2 },
    });
    expect(replies[3]).toMatchObject({ id: 4, ok: false, receipt: { clicked: null } });
    expect(replies[3].error).toContain('native fault before input');
    for (const reply of replies.slice(1)) {
      expect(reply.before).toEqual({
        pid: 123,
        depth: 90,
        budget: 9000,
        children: [{ name: 'raw frame', frame: { x: 1, y: 2, w: 3, h: 4 } }],
      });
      expect(reply.after).toEqual(reply.before);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
