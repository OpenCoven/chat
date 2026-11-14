import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('the actual native guard rejects a hit or foreground changed during receipt reads before sending input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-link-guard-'));
  try {
    const source = readFileSync(
      resolve('scripts/native-acceptance/windows/NativeDriver.ps1'),
      'utf8',
    );
    const method = source.slice(
      source.indexOf('  public static string ClickLink('),
      source.indexOf('  public static void Drag('),
    );
    // Compile the actual method. Only Windows UIA and SendInput are replaced:
    // a receipt read can move the hit or foreground, as a real UI update can.
    const fixture =
      `
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows.Automation;
namespace System.Windows { public struct Point { public Point(int x, int y) {} } }
namespace System.Windows.Automation {
  public enum ControlType { Text, Hyperlink, Window }
  public class Info { public ControlType ControlType; public string Name; public bool IsEnabled = true; public int ProcessId = 999; }
  public class AutomationElement {
    public Info Current = new Info(); public AutomationElement Parent;
    public static AutomationElement FromPoint(System.Windows.Point point) { return NativeDriver.Hit; }
  }
  public class TreeWalker {
    public static TreeWalker ControlViewWalker = new TreeWalker();
    public AutomationElement GetParent(AutomationElement element) { return element.Parent; }
  }
  public class Automation { public static bool Compare(AutomationElement a, AutomationElement b) { return Object.ReferenceEquals(a, b); } }
}
public static class NativeDriver {
  public static AutomationElement Hit;
  static AutomationElement window, other;
  static string scenario;
  static bool changed;
  static int foreground, hitSummaryReads;
  public static List<uint> Inputs = new List<uint>();
  public static void Reset(string value) {
    scenario = value; changed = false; foreground = 123; hitSummaryReads = 0; Inputs.Clear();
    window = new AutomationElement { Current = new Info { ControlType = ControlType.Window, Name = "Chat" } };
    other = new AutomationElement { Current = new Info { ControlType = ControlType.Window, Name = "Other" } };
    var link = new AutomationElement { Parent = value == "wrong-window" ? other : window, Current = new Info { ControlType = ControlType.Hyperlink, Name = value == "wrong-name" ? "Other link" : "Named login" } };
    Hit = new AutomationElement { Parent = link, Current = new Info { ControlType = ControlType.Text, Name = "Named login" } };
  }
  struct POINT { public int X, Y; }
  static bool GetCursorPos(out POINT point) {
    point = new POINT { X = scenario == "wrong-cursor" ? 900 : 450, Y = 410 };
    return scenario != "unavailable-cursor";
  }
  static void Move(int x, int y) {}
  static int ForegroundPid() { return foreground; }
  static AutomationElement Window(int pid) { return window; }
  static string Summary(AutomationElement element) {
    if (Object.ReferenceEquals(element, Hit) && ++hitSummaryReads == 2) {
      if (scenario == "renamed") Hit.Parent.Current.Name = "Changed link";
      if (scenario == "disabled") Hit.Parent.Current.IsEnabled = false;
    }
    if (!changed) {
      changed = true;
      if (scenario == "moving-point") Hit = other;
      if (scenario == "moving-foreground") foreground = 456;
    }
    return JsonSerializer.Serialize(new { name = element.Current.Name, pid = element.Current.ProcessId });
  }
  static string Quote(string value) { return JsonSerializer.Serialize(value); }
  static uint Down(string button) { return 2; }
  static uint Up(string button) { return 4; }
  static bool Mouse(uint flags) { Inputs.Add(flags); return !(scenario == "input-failure" && flags == 2); }
` +
      method +
      '\n}';
    const cs = join(directory, 'guard.cs');
    writeFileSync(cs, fixture);
    const runner = join(directory, 'guard.ps1');
    writeFileSync(
      runner,
      `param([string]$source)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content -LiteralPath $source -Raw)
foreach ($scenario in @('stable', 'moving-point', 'moving-foreground', 'renamed', 'disabled', 'wrong-window', 'wrong-name', 'wrong-cursor', 'unavailable-cursor', 'input-failure')) {
  [NativeDriver]::Reset($scenario)
  $receipt = [NativeDriver]::ClickLink(123, 450, 410, 'Named login') | ConvertFrom-Json
  @{ scenario = $scenario; receipt = $receipt; inputs = @([NativeDriver]::Inputs) } | ConvertTo-Json -Compress -Depth 20
}
`,
    );
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner, cs], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const receipts = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(10);
    expect(receipts[0]).toMatchObject({
      scenario: 'stable',
      inputs: [2, 4],
      receipt: { clicked: true, belongsToTargetWindow: true },
    });
    for (const receipt of receipts.slice(1, 9)) {
      expect(receipt, receipt.scenario).toMatchObject({
        inputs: [],
        receipt: { clicked: false, downSent: false, upSent: false },
      });
    }
    expect(receipts[9]).toMatchObject({
      scenario: 'input-failure',
      inputs: [2, 4],
      receipt: { clicked: false, downSent: false, upSent: true },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
