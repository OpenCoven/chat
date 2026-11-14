# Native input and UI Automation for the Windows acceptance lane (#504).
# Input goes through SendInput, as a mouse and keyboard would, and what the app
# shows is read back from its UI Automation tree, which is what Narrator and NVDA
# read. Nothing here touches the page's DOM or scripts.

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
# BoundingRectangle is a System.Windows.Rect, which lives in WindowsBase.
$references = @(
  'UIAutomationClient', 'UIAutomationTypes', 'System.Windows.Forms', 'System.Drawing',
  [System.Windows.Rect].Assembly.Location
)
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
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

  static string Range(AutomationElement element) {
    object pattern;
    if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) return null;
    var range = ((RangeValuePattern)pattern).Current;
    return string.Format(System.Globalization.CultureInfo.InvariantCulture,
      "\"min\":{0},\"max\":{1}", range.Minimum, range.Maximum);
  }

  // A range's number comes first: with aria-valuetext, Chromium's Value pattern
  // gives the text ("360 pixels") and RangeValue the number, which is what the
  // other platforms report as the value. The text is kept as valueText.
  static string Value(AutomationElement element) {
    object pattern;
    if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern))
      return ((RangeValuePattern)pattern).Current.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
      return ((ValuePattern)pattern).Current.Value;
    return null;
  }

  static string ValueText(AutomationElement element) {
    object pattern;
    if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) return null;
    if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;
    return ((ValuePattern)pattern).Current.Value;
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
    try { var text = ValueText(element); if (!string.IsNullOrEmpty(text)) parts.Add("\"valueText\":" + Quote(text)); } catch { }
    try { var range = Range(element); if (range != null) parts.Add(range); } catch { }
    if (current.Orientation != OrientationType.None) parts.Add("\"orientation\":" + Quote(current.Orientation.ToString()));
    try {
      object pattern;
      if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
        parts.Add("\"selected\":" + (((SelectionItemPattern)pattern).Current.IsSelected ? "true" : "false"));
      else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
        parts.Add("\"selected\":" + (((TogglePattern)pattern).Current.ToggleState == ToggleState.On ? "true" : "false"));
      if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
        parts.Add("\"expanded\":" + (((ExpandCollapsePattern)pattern).Current.ExpandCollapseState == ExpandCollapseState.Expanded ? "true" : "false"));
    } catch { }
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

  /// The process's largest top-level window: the app, not a menu or tooltip it has open.
  public static AutomationElement Window(int pid) {
    var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
    AutomationElement best = null;
    double area = -1;
    foreach (AutomationElement window in AutomationElement.RootElement.FindAll(TreeScope.Children, condition)) {
      var r = window.Current.BoundingRectangle;
      var size = r.IsEmpty ? 0 : r.Width * r.Height;
      if (size > area) { area = size; best = window; }
    }
    return best;
  }

  /// Every open menu on the desktop, by its items' names: a context menu is its own window.
  /// Open context menus: WebView2 draws its menu in a Chromium popup window
  /// (Chrome_WidgetWin_*) of its own process, and Win32 menus use #32768. Their
  /// menu items are read wherever they sit under such a window.
  public static string Menus(int pid) {
    var menus = new List<string>();
    var isItem = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem);
    // WebView2 can host its menu inside the app's own window: its items are
    // read there, leaving out the title bar's System menu.
    var own = Window(pid);
    if (own != null) {
      var items = new List<string>();
      AutomationElementCollection found = null;
      try { found = own.FindAll(TreeScope.Descendants, isItem); } catch { }
      if (found != null) {
        foreach (AutomationElement item in found) {
          try {
            var parent = TreeWalker.ControlViewWalker.GetParent(item);
            if (parent != null && parent.Current.ControlType == ControlType.MenuBar) continue;
            items.Add(Quote(item.Current.Name));
          } catch { }
        }
      }
      if (items.Count > 0) menus.Add("[" + string.Join(",", items) + "]");
    }
    foreach (AutomationElement top in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      string cls;
      try { cls = top.Current.ClassName ?? ""; } catch { continue; }
      if (!cls.StartsWith("Chrome_WidgetWin") && cls != "#32768") continue;
      AutomationElementCollection found;
      try { found = top.FindAll(TreeScope.Subtree, isItem); } catch { continue; }
      var items = new List<string>();
      foreach (AutomationElement item in found) {
        try { items.Add(Quote(item.Current.Name)); } catch { }
      }
      if (items.Count > 0) menus.Add("[" + string.Join(",", items) + "]");
    }
    return "[" + string.Join(",", menus) + "]";
  }

  /// Top-level windows, for the record when no menu could be read.
  /** What accessibility reports at a point on screen: the element, its ancestors, and any menu's items. */
  public static string MenuAt(double x, double y) {
    AutomationElement found = null;
    try { found = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch { }
    if (found == null) return "{\"chain\":[],\"items\":[]}";
    var chain = new List<string>();
    var items = new List<string>();
    var isItem = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem);
    AutomationElement current = found;
    AutomationElement menu = null;
    for (int depth = 0; depth < 10 && current != null; depth += 1) {
      try {
        var info = current.Current;
        chain.Add(Quote(info.ControlType.ProgrammaticName + " | " + info.Name + " | " + info.ClassName + " | pid " + info.ProcessId));
        if (menu == null && (info.ControlType == ControlType.Menu || info.ControlType == ControlType.List)) menu = current;
      } catch { break; }
      try { current = TreeWalker.ControlViewWalker.GetParent(current); } catch { break; }
    }
    if (menu != null) {
      try {
        foreach (AutomationElement item in menu.FindAll(TreeScope.Descendants, isItem)) {
          try { items.Add(Quote(item.Current.Name)); } catch { }
        }
      } catch { }
    }
    return "{\"chain\":[" + string.Join(",", chain) + "],\"items\":[" + string.Join(",", items) + "]}";
  }

  public static string TopWindows() {
    var tops = new List<string>();
    foreach (AutomationElement top in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      try {
        var c = top.Current;
        tops.Add("{\"class\":" + Quote(c.ClassName ?? "") + ",\"name\":" + Quote(c.Name ?? "") + ",\"pid\":" + c.ProcessId + ",\"type\":" + Quote(c.ControlType.ProgrammaticName) + "}");
      } catch { }
    }
    return "[" + string.Join(",", tops) + "]";
  }

  public static void Down(int x, int y) { Move(x, y); System.Threading.Thread.Sleep(60); Mouse(Down("left")); }
  public static void Up(int x, int y) { SetCursorPos(x, y); Mouse(0x0001); Mouse(Up("left")); }

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
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  const uint MOUSE = 0, KEYBOARD = 1;
  static bool Mouse(uint flags, uint data = 0) {
    var input = new INPUT { type = MOUSE };
    input.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    var sent = SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(12);
    return sent == 1;
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

  /// A single click only when UIA's actual point belongs to this exact link
  /// inside Chat's foreground window. Text children may resolve to their link.
  public static string ClickLink(int pid, int x, int y, string name) {
    Move(x, y);
    var foreground = ForegroundPid();
    var hit = AutomationElement.FromPoint(new System.Windows.Point(x, y));
    var link = hit;
    var hitAncestors = new List<string>();
    for (var depth = 0; link != null && depth < 8; depth++) {
      hitAncestors.Add(Summary(link));
      if (link.Current.ControlType == ControlType.Hyperlink) break;
      link = TreeWalker.ControlViewWalker.GetParent(link);
    }
    var belongs = false;
    var window = Window(pid);
    var parent = link;
    var windowAncestors = new List<string>();
    for (var depth = 0; parent != null && window != null && depth < 64; depth++) {
      windowAncestors.Add(Summary(parent));
      if (Automation.Compare(parent, window)) { belongs = true; break; }
      parent = TreeWalker.ControlViewWalker.GetParent(parent);
    }
    var matches = foreground == pid && belongs && link != null &&
      link.Current.ControlType == ControlType.Hyperlink && link.Current.IsEnabled &&
      string.Equals(link.Current.Name, name, StringComparison.Ordinal);
    // Capture UIA summaries before the click makes background nodes inert.
    var hitSummary = hit == null ? "null" : Summary(hit);
    var linkSummary = link == null ? "null" : Summary(link);
    // Rich UIA reads above can take time. Recheck the actual point, requested
    // link and foreground after them, then send input without another read.
    var sameHit = matches && Automation.Compare(AutomationElement.FromPoint(new System.Windows.Point(x, y)), hit);
    var finalName = link == null ? null : link.Current.Name;
    var finalEnabled = link != null && link.Current.IsEnabled;
    var finalRole = link != null && link.Current.ControlType == ControlType.Hyperlink;
    var finalForeground = ForegroundPid();
    POINT cursor;
    var cursorKnown = GetCursorPos(out cursor);
    matches = matches && sameHit && finalForeground == pid && cursorKnown &&
      cursor.X == x && cursor.Y == y && finalEnabled && finalRole &&
      string.Equals(finalName, name, StringComparison.Ordinal);
    var down = false;
    var up = false;
    if (matches) {
      down = Mouse(Down("left"));
      System.Threading.Thread.Sleep(40);
      up = Mouse(Up("left"));
      System.Threading.Thread.Sleep(40);
    }
    var clicked = matches && down && up;
    var error = !matches ? "Native point, cursor or foreground changed; no click sent"
      : !clicked ? "SendInput did not deliver the single link click" : null;
    return "{\"clicked\":" + (clicked ? "true" : "false") +
      ",\"foregroundPid\":" + foreground + ",\"foregroundAfter\":" + ForegroundPid() +
      ",\"cursorKnown\":" + (cursorKnown ? "true" : "false") +
      ",\"cursor\":[" + cursor.X + "," + cursor.Y + "]" +
      ",\"finalHitMatches\":" + (sameHit ? "true" : "false") +
      ",\"finalForegroundPid\":" + finalForeground + ",\"finalName\":" + Quote(finalName) +
      ",\"finalEnabled\":" + (finalEnabled ? "true" : "false") +
      ",\"at\":[" + x + "," + y + "],\"expectedName\":" + Quote(name) +
      ",\"hit\":" + hitSummary +
      ",\"link\":" + linkSummary +
      ",\"hitAncestors\":[" + string.Join(",", hitAncestors) + "]" +
      ",\"windowAncestors\":[" + string.Join(",", windowAncestors) + "]" +
      ",\"belongsToTargetWindow\":" + (belongs ? "true" : "false") +
      ",\"downSent\":" + (down ? "true" : "false") + ",\"upSent\":" + (up ? "true" : "false") +
      ",\"error\":" + Quote(error) + "}";
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
    // A horizontal wheel's positive delta scrolls right; the lane's dx follows
    // the macOS sign, where negative scrolls right.
    if (dx != 0) Mouse(0x1000, unchecked((uint)(-dx)));
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

  public static void Hold(ushort[] mods) { foreach (var mod in mods) Key(mod, false); }
  public static void Release(ushort[] mods) { for (var index = mods.Length - 1; index >= 0; index--) Key(mods[index], true); }
  public static int VirtualKey(char c) { var scan = VkKeyScan(c); return scan == -1 ? -1 : scan & 0xff; }

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
    uint current;
    GetWindowThreadProcessId(GetForegroundWindow(), out current);
    if (current == pid) return true;
    // Windows lets a process take the foreground once it has sent input. A
    // pointer move of zero is that input; an Alt tap would open the window's
    // System menu and leave the app in menu mode.
    Mouse(0x0001);
    SetForegroundWindow(handle);
    System.Threading.Thread.Sleep(200);
    uint owner;
    GetWindowThreadProcessId(GetForegroundWindow(), out owner);
    return owner == pid;
  }

  /// Minimises every top-level window of a process, such as the browser an Open started.
  public static bool Minimize(int pid) {
    var any = false;
    var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
    foreach (AutomationElement window in AutomationElement.RootElement.FindAll(TreeScope.Children, condition)) {
      object pattern;
      if (window.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) {
        ((WindowPattern)pattern).SetWindowVisualState(WindowVisualState.Minimized);
        any = true;
      }
    }
    return any;
  }

  public static int ForegroundPid() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return (int)pid;
  }

  public static void MoveWindow(int pid, double x, double y) {
    var window = Window(pid);
    object pattern;
    if (window != null && window.TryGetCurrentPattern(TransformPattern.Pattern, out pattern))
      ((TransformPattern)pattern).Move(x, y);
  }

  // ---- Input language: the keyboard layout of the app's foreground thread.
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

  public static string Layout() {
    uint pid;
    var thread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return GetKeyboardLayout(thread).ToInt64().ToString("x8");
  }

  /// Asks the foreground window to switch input language, as the language bar does.
  public static bool SelectLayout(int pid, string klid) {
    var layout = LoadKeyboardLayout(klid, 1);
    if (layout == IntPtr.Zero) return false;
    PostMessage(GetForegroundWindow(), 0x0050, IntPtr.Zero, layout);
    System.Threading.Thread.Sleep(400);
    return true;
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
