# Native input and UI Automation for the Windows acceptance lane (#504).
# Input goes through SendInput, as a mouse and keyboard would, and what the app
# shows is read back from its UI Automation tree, which is what Narrator and NVDA
# read. Nothing here touches the page's DOM or scripts.

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class NativeDriver {
  static string Quote(string text) {
    if (text == null) return "null";
    var builder = new StringBuilder("\"");
    foreach (var c in text) {
      switch (c) {
        case '"': builder.Append("\\\""); break;
        case '\\': builder.Append("\\\\"); break;
        case '\n': builder.Append("\\n"); break;
        case '\r': builder.Append("\\r"); break;
        case '\t': builder.Append("\\t"); break;
        default:
          if (c < 0x20) builder.AppendFormat("\\u{0:x4}", (int)c); else builder.Append(c);
          break;
      }
    }
    return builder.Append('"').ToString();
  }

  static string Value(AutomationElement element) {
    object pattern;
    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
      return ((ValuePattern)pattern).Current.Value;
    if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern))
      return ((RangeValuePattern)pattern).Current.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    return null;
  }

  public static string Summary(AutomationElement element) {
    var current = element.Current;
    var parts = new List<string>();
    parts.Add("\"role\":" + Quote(current.ControlType.ProgrammaticName.Replace("ControlType.", "")));
    if (!string.IsNullOrEmpty(current.Name)) parts.Add("\"name\":" + Quote(current.Name));
    if (!string.IsNullOrEmpty(current.AutomationId)) parts.Add("\"id\":" + Quote(current.AutomationId));
    if (!string.IsNullOrEmpty(current.ClassName)) parts.Add("\"className\":" + Quote(current.ClassName));
    if (!string.IsNullOrEmpty(current.LocalizedControlType)) parts.Add("\"localized\":" + Quote(current.LocalizedControlType));
    if (!string.IsNullOrEmpty(current.HelpText)) parts.Add("\"help\":" + Quote(current.HelpText));
    try { var value = Value(element); if (value != null) parts.Add("\"value\":" + Quote(value)); } catch { }
    parts.Add("\"focused\":" + (current.HasKeyboardFocus ? "true" : "false"));
    parts.Add("\"enabled\":" + (current.IsEnabled ? "true" : "false"));
    var r = current.BoundingRectangle;
    if (!r.IsEmpty && !double.IsInfinity(r.X))
      parts.Add(string.Format(System.Globalization.CultureInfo.InvariantCulture,
        "\"frame\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}}", r.X, r.Y, r.Width, r.Height));
    return "{" + string.Join(",", parts) + "}";
  }

  static int budget;
  static string Walk(AutomationElement element, int depth) {
    budget--;
    var node = Summary(element);
    if (depth <= 0 || budget <= 0) return node;
    var kids = new List<string>();
    var walker = TreeWalker.ControlViewWalker;
    var child = walker.GetFirstChild(element);
    while (child != null && budget > 0) {
      try { kids.Add(Walk(child, depth - 1)); } catch { }
      child = walker.GetNextSibling(child);
    }
    if (kids.Count == 0) return node;
    return node.Substring(0, node.Length - 1) + ",\"children\":[" + string.Join(",", kids) + "]}";
  }

  public static AutomationElement Window(int pid) {
    var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
    return AutomationElement.RootElement.FindFirst(TreeScope.Children, condition);
  }

  public static string Tree(int pid, int depth, int limit) {
    budget = limit;
    var window = Window(pid);
    return window == null ? "null" : Walk(window, depth);
  }

  public static string Focused() {
    var focused = AutomationElement.FocusedElement;
    return focused == null ? "null" : Summary(focused);
  }

  public static string Selection(int pid) {
    var window = Window(pid);
    if (window == null) return null;
    var documents = window.FindAll(TreeScope.Descendants,
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
    var texts = new List<string>();
    foreach (AutomationElement document in documents) {
      object pattern;
      if (!document.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) continue;
      foreach (var range in ((TextPattern)pattern).GetSelection()) texts.Add(range.GetText(-1));
    }
    return string.Join("", texts);
  }

  // ---- SendInput

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  const uint MOUSE = 0, KEYBOARD = 1;
  static void Mouse(uint flags, uint data = 0) {
    var input = new INPUT { type = MOUSE };
    input.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(12);
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(30); Mouse(0x0001); }

  static uint Down(string button) { return button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u; }
  static uint Up(string button) { return button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u; }

  public static void Click(int x, int y, string button, int count) {
    Move(x, y);
    System.Threading.Thread.Sleep(60);
    for (var index = 0; index < Math.Max(count, 1); index++) {
      Mouse(Down(button)); System.Threading.Thread.Sleep(40); Mouse(Up(button)); System.Threading.Thread.Sleep(40);
    }
  }

  public static void Drag(int[] path, int holdMs) {
    Move(path[0], path[1]);
    System.Threading.Thread.Sleep(80);
    Mouse(Down("left"));
    System.Threading.Thread.Sleep(120);
    for (var index = 2; index + 1 < path.Length; index += 2) {
      int fx = path[index - 2], fy = path[index - 1], tx = path[index], ty = path[index + 1];
      var steps = Math.Max((int)(Math.Sqrt((tx - fx) * (tx - fx) + (ty - fy) * (ty - fy)) / 6), 4);
      for (var step = 1; step <= steps; step++) {
        SetCursorPos(fx + (tx - fx) * step / steps, fy + (ty - fy) * step / steps);
        Mouse(0x0001);
        System.Threading.Thread.Sleep(8);
      }
    }
    System.Threading.Thread.Sleep(Math.Max(holdMs, 0));
    Mouse(Up("left"));
  }

  public static void Wheel(int x, int y, int dy, int dx) {
    Move(x, y);
    if (dy != 0) Mouse(0x0800, unchecked((uint)dy));
    if (dx != 0) Mouse(0x1000, unchecked((uint)dx));
  }

  static void Key(ushort vk, bool up) {
    var input = new INPUT { type = KEYBOARD };
    var extended = vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x24 || vk == 0x23 || vk == 0x2E || vk == 0x21 || vk == 0x22;
    input.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = (up ? 0x0002u : 0u) | (extended ? 0x0001u : 0u) };
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(12);
  }

  /// A held key repeats its key down, as the keyboard does, before one key up.
  public static void Press(ushort vk, ushort[] mods, int repeats, int intervalMs) {
    foreach (var mod in mods) Key(mod, false);
    Key(vk, false);
    for (var index = 0; index < repeats; index++) { System.Threading.Thread.Sleep(Math.Max(intervalMs, 1)); Key(vk, false); }
    Key(vk, true);
    for (var index = mods.Length - 1; index >= 0; index--) Key(mods[index], true);
  }

  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  /// Types through virtual keys, so an input method composes it as it would typing.
  public static void Type(string text) {
    foreach (var c in text) {
      var scan = VkKeyScan(c);
      if (scan == -1) {
        var input = new INPUT { type = KEYBOARD };
        input.u.ki = new KEYBDINPUT { wScan = c, dwFlags = 0x0004 };
        var release = input; release.u.ki.dwFlags = 0x0004 | 0x0002;
        SendInput(2, new[] { input, release }, Marshal.SizeOf(typeof(INPUT)));
        continue;
      }
      var vk = (ushort)(scan & 0xff);
      var shift = (scan & 0x100) != 0;
      Press(vk, shift ? new ushort[] { 0x10 } : new ushort[0], 0, 0);
    }
  }

  public static bool Foreground(int pid) {
    var window = Window(pid);
    if (window == null) return false;
    var handle = new IntPtr(window.Current.NativeWindowHandle);
    SetForegroundWindow(handle);
    System.Threading.Thread.Sleep(200);
    uint owner;
    GetWindowThreadProcessId(GetForegroundWindow(), out owner);
    return owner == pid;
  }

  public static void Resize(int pid, double width, double height) {
    var window = Window(pid);
    object pattern;
    if (window != null && window.TryGetCurrentPattern(TransformPattern.Pattern, out pattern))
      ((TransformPattern)pattern).Resize(width, height);
  }
}
'@
[NativeDriver]::SetProcessDPIAware() | Out-Null

function Get-NativeTree([int]$ProcessId, [int]$Depth = 60, [int]$Limit = 6000) {
  [NativeDriver]::Tree($ProcessId, $Depth, $Limit) | ConvertFrom-Json
}
