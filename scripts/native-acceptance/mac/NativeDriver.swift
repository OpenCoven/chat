// Native input and accessibility for the macOS acceptance lane (#504).
//
// One JSON command per stdin line, one JSON answer per stdout line. Input goes
// through the window server as real HID events (CGEvent at the HID tap), so the
// app receives what a mouse and keyboard would send: WebKit sees native NSEvents,
// the input method sees real key codes, and a drag can leave the window. What the
// app shows is read back from its accessibility tree, the same tree VoiceOver reads.
// Nothing here touches the page's DOM or scripts.

import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

var target: pid_t = 0
let encoder = JSONSerialization.self

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8)
  else {
    print("{\"ok\":false,\"error\":\"unencodable reply\"}")
    fflush(stdout)
    return
  }
  print(line)
  fflush(stdout)
}

// MARK: Accessibility reading

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func names(_ element: AXUIElement) -> [String] {
  var list: CFArray?
  guard AXUIElementCopyAttributeNames(element, &list) == .success, let list = list as? [String]
  else { return [] }
  return list
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  guard let position = attribute(element, kAXPositionAttribute),
    let size = attribute(element, kAXSizeAttribute)
  else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  AXValueGetValue(position as! AXValue, .cgPoint, &point)
  AXValueGetValue(size as! AXValue, .cgSize, &extent)
  return ["x": point.x, "y": point.y, "w": extent.width, "h": extent.height]
}

func plain(_ value: AnyObject?) -> Any? {
  switch value {
  case let text as String: return text.count > 4000 ? String(text.prefix(4000)) + "…" : text
  case let number as NSNumber: return number
  case let url as URL: return url.absoluteString
  default: return nil
  }
}

func summary(_ element: AXUIElement) -> [String: Any] {
  var node: [String: Any] = [:]
  for (key, name) in [
    ("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute),
    ("roleDescription", kAXRoleDescriptionAttribute), ("title", kAXTitleAttribute),
    ("desc", kAXDescriptionAttribute), ("help", kAXHelpAttribute),
    ("identifier", kAXIdentifierAttribute), ("placeholder", kAXPlaceholderValueAttribute),
  ] {
    if let value = plain(attribute(element, name)) as? String, !value.isEmpty { node[key] = value }
  }
  if let value = plain(attribute(element, kAXValueAttribute)) { node["value"] = value }
  if let url = plain(attribute(element, kAXURLAttribute)) as? String { node["url"] = url }
  for (key, name) in [
    ("orientation", kAXOrientationAttribute), ("min", kAXMinValueAttribute),
    ("max", kAXMaxValueAttribute),
  ] {
    if let value = plain(attribute(element, name)) { node[key] = value }
  }
  for (key, name) in [
    ("focused", kAXFocusedAttribute), ("enabled", kAXEnabledAttribute),
    ("selected", kAXSelectedAttribute), ("expanded", kAXExpandedAttribute),
  ] {
    if let flag = attribute(element, name) as? Bool { node[key] = flag }
  }
  if let value = attribute(element, "AXDOMIdentifier") as? String, !value.isEmpty {
    node["domId"] = value
  }
  if let classes = attribute(element, "AXDOMClassList") as? [String], !classes.isEmpty {
    node["classes"] = classes
  }
  if let box = frame(element) { node["frame"] = box }
  return node
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

var budget = 0
func tree(_ element: AXUIElement, depth: Int) -> [String: Any] {
  budget -= 1
  var node = summary(element)
  if depth > 0, budget > 0 {
    let kids = children(element).map { tree($0, depth: depth - 1) }
    if !kids.isEmpty { node["children"] = kids }
  }
  return node
}

func application() -> AXUIElement { AXUIElementCreateApplication(target) }

func windows() -> [AXUIElement] {
  (attribute(application(), kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

func mainWindow() -> AXUIElement? {
  if let focused = attribute(application(), kAXFocusedWindowAttribute) {
    return (focused as! AXUIElement)
  }
  return windows().first
}

func find(_ element: AXUIElement, role: String, depth: Int = 60) -> AXUIElement? {
  if (attribute(element, kAXRoleAttribute) as? String) == role { return element }
  guard depth > 0 else { return nil }
  for child in children(element) {
    if let found = find(child, role: role, depth: depth - 1) { return found }
  }
  return nil
}

/// The page itself. WebKit fills in its tree only once an assistive client asks
/// for it, so the walk also starts from the focused element's ancestors.
func webArea() -> AXUIElement? {
  if let window = mainWindow(), let web = find(window, role: "AXWebArea") { return web }
  var cursor = attribute(application(), kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
  while let current = cursor {
    if (attribute(current, kAXRoleAttribute) as? String) == "AXWebArea" { return current }
    cursor = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
  }
  return nil
}

/// The page's selection as text, through WebKit's text markers.
func selectedText() -> Any {
  guard let web = webArea() else {
    return NSNull()
  }
  guard let range = attribute(web, "AXSelectedTextMarkerRange") else { return "" }
  var text: AnyObject?
  let status = AXUIElementCopyParameterizedAttributeValue(
    web, "AXStringForTextMarkerRange" as CFString, range, &text)
  return status == .success ? ((text as? String) ?? "") : ""
}

/// Menus the app has open, such as a context menu: their items' titles.
func openMenus() -> [[String]] {
  var menus: [[String]] = []
  func walk(_ element: AXUIElement, depth: Int) {
    if (attribute(element, kAXRoleAttribute) as? String) == kAXMenuRole {
      menus.append(
        children(element).map { item in
          let title = (attribute(item, kAXTitleAttribute) as? String) ?? ""
          return title.isEmpty ? "—" : title
        })
      return
    }
    guard depth > 0 else { return }
    for child in children(element) {
      // The menu bar's menus exist while closed; only a menu that is open counts.
      if (attribute(child, kAXRoleAttribute) as? String) == kAXMenuBarRole { continue }
      walk(child, depth: depth - 1)
    }
  }
  walk(application(), depth: 3)
  return menus
}

// MARK: Input

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
  usleep(12_000)
}

func flags(_ names: [String]) -> CGEventFlags {
  var value: CGEventFlags = []
  for name in names {
    switch name {
    case "cmd": value.insert(.maskCommand)
    case "shift": value.insert(.maskShift)
    case "alt": value.insert(.maskAlternate)
    case "ctrl": value.insert(.maskControl)
    default: break
    }
  }
  return value
}

func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, _ mods: CGEventFlags,
  clicks: Int = 1
) {
  let event = CGEvent(
    mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.flags = mods
  event?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
  post(event)
}

func buttonEvents(_ name: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
  switch name {
  case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
  case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
  default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
  }
}

func click(_ point: CGPoint, button: String, mods: CGEventFlags, count: Int) {
  let (down, up, _, which) = buttonEvents(button)
  mouse(.mouseMoved, point, .left, [])
  usleep(60_000)
  for index in 1...max(count, 1) {
    mouse(down, point, which, mods, clicks: index)
    usleep(40_000)
    mouse(up, point, which, mods, clicks: index)
    usleep(40_000)
  }
}

func drag(_ path: [CGPoint], holdMs: Int, button: String) {
  guard let first = path.first, let last = path.last else { return }
  let (down, up, dragged, which) = buttonEvents(button)
  mouse(.mouseMoved, first, .left, [])
  usleep(80_000)
  mouse(down, first, which, [])
  usleep(120_000)
  for (from, to) in zip(path, path.dropFirst()) {
    let steps = max(Int(hypot(to.x - from.x, to.y - from.y) / 6), 4)
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      mouse(dragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t),
        which, [])
      usleep(8_000)
    }
  }
  usleep(useconds_t(max(holdMs, 0) * 1000))
  mouse(up, last, which, [])
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
  "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "forwarddelete": 117,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124,
  "down": 125, "up": 126, "f5": 96,
  // JIS かな and 英数: switch the frontmost app's input to Japanese and back.
  "kana": 104, "eisu": 102,
]
let shifted: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9",
  ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",",
  ">": ".", "?": "/", "~": "`",
]

func key(_ code: CGKeyCode, mods: CGEventFlags, repeats: Int, intervalMs: Int) {
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  down?.flags = mods
  post(down)
  // A held key: the keyboard driver repeats the key down, marked as a repeat.
  for _ in 0..<max(repeats, 0) {
    usleep(useconds_t(max(intervalMs, 1) * 1000))
    let again = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    again?.flags = mods
    again?.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
    post(again)
  }
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  up?.flags = mods
  post(up)
}

/// Types through key codes, so an input method composes it as it would typing.
/// Characters a US layout can't produce go in as Unicode strings.
func type(_ text: String) {
  for character in text {
    let lower = Character(character.lowercased())
    if let code = keyCodes[String(lower)], character.isLetter || character == lower {
      let upper = character.isUppercase
      key(code, mods: upper ? .maskShift : [], repeats: 0, intervalMs: 0)
    } else if let base = shifted[character], let code = keyCodes[String(base)] {
      key(code, mods: .maskShift, repeats: 0, intervalMs: 0)
    } else if character == "\n" {
      key(36, mods: .maskShift, repeats: 0, intervalMs: 0)
    } else {
      let units = Array(String(character).utf16)
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        post(event)
      }
    }
  }
}

// MARK: Input sources

func inputSource(_ id: String) -> TISInputSource? {
  let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource]
  else { return nil }
  return list.first
}

func sourceID(_ source: TISInputSource) -> String {
  guard let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "" }
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}

// MARK: Commands

func point(_ value: Any?) -> CGPoint? {
  guard let pair = value as? [Double], pair.count == 2 else { return nil }
  return CGPoint(x: pair[0], y: pair[1])
}

func run(_ command: [String: Any]) -> [String: Any] {
  let name = command["cmd"] as? String ?? ""
  let mods = flags(command["mods"] as? [String] ?? [])
  switch name {
  case "trust":
    return [
      "ok": true, "accessibility": AXIsProcessTrusted(),
      "postEvent": CGPreflightPostEventAccess(), "screen": CGPreflightScreenCaptureAccess(),
    ]
  case "target":
    target = pid_t(command["pid"] as? Int ?? 0)
    // What VoiceOver sets when it starts: the app exposes its full tree.
    let app = application()
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return ["ok": target > 0]
  case "activate":
    let app = NSRunningApplication(processIdentifier: target)
    let done = app?.activate(options: [.activateAllWindows]) ?? false
    return ["ok": done]
  case "frontmost":
    return ["ok": true, "pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]
  case "windows":
    return ["ok": true, "windows": windows().map(summary)]
  case "tree":
    budget = command["budget"] as? Int ?? 6000
    guard let window = mainWindow() else { return ["ok": false, "error": "no window"] }
    return ["ok": true, "tree": tree(window, depth: command["depth"] as? Int ?? 80)]
  case "web":
    budget = command["budget"] as? Int ?? 8000
    guard let web = webArea() else { return ["ok": false, "error": "no web area"] }
    return ["ok": true, "tree": tree(web, depth: command["depth"] as? Int ?? 80)]
  case "otherTree":
    // Another app's front window, such as the browser an Open handed off to.
    budget = command["budget"] as? Int ?? 3000
    let other = AXUIElementCreateApplication(pid_t(command["pid"] as? Int ?? 0))
    let front = attribute(other, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
      ?? ((attribute(other, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first
    guard let window = front else { return ["ok": false, "error": "no window"] }
    return ["ok": true, "tree": tree(window, depth: command["depth"] as? Int ?? 30)]
  case "running":
    // Which apps are running, by bundle identifier: the browser before and after an Open.
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    return [
      "ok": true,
      "apps": apps.map { ["pid": Int($0.processIdentifier), "bundle": $0.bundleIdentifier ?? ""] },
      "frontmost": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0),
    ]
  case "hideApp":
    // Puts another app (the browser an Open started) out of the way, as Cmd-H would.
    let app = NSRunningApplication(processIdentifier: pid_t(command["pid"] as? Int ?? 0))
    return ["ok": app?.hide() ?? false]
  case "defaultBrowser":
    let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com/")!)
    return ["ok": true, "app": url?.path ?? "", "bundle": url.flatMap { Bundle(url: $0)?.bundleIdentifier } ?? ""]
  case "appTree":
    budget = command["budget"] as? Int ?? 2000
    return ["ok": true, "tree": tree(application(), depth: command["depth"] as? Int ?? 4)]
  case "focused":
    guard let focused = attribute(application(), kAXFocusedUIElementAttribute) else {
      return ["ok": true, "focused": NSNull()]
    }
    let element = focused as! AXUIElement
    var chain: [[String: Any]] = []
    var cursor: AXUIElement? = element
    while let current = cursor, chain.count < 12 {
      chain.append(summary(current))
      cursor = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return ["ok": true, "focused": summary(element), "ancestors": Array(chain.dropFirst())]
  case "selection":
    return ["ok": true, "text": selectedText()]
  case "menus":
    return ["ok": true, "menus": openMenus()]
  case "setFrame":
    guard let window = mainWindow() else { return ["ok": false, "error": "no window"] }
    if let x = command["x"] as? Double, let y = command["y"] as? Double {
      var origin = CGPoint(x: x, y: y)
      AXUIElementSetAttributeValue(
        window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    }
    if let w = command["w"] as? Double, let h = command["h"] as? Double {
      var size = CGSize(width: w, height: h)
      AXUIElementSetAttributeValue(
        window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    }
    usleep(300_000)
    return ["ok": true, "frame": frame(window) ?? [:]]
  case "click":
    guard let at = point(command["at"]) else { return ["ok": false, "error": "no point"] }
    click(at, button: command["button"] as? String ?? "left", mods: mods,
      count: command["count"] as? Int ?? 1)
    return ["ok": true]
  case "move":
    // With held: true the left button is down, so the window server sends drags.
    guard let at = point(command["at"]) else { return ["ok": false, "error": "no point"] }
    mouse((command["held"] as? Bool ?? false) ? .leftMouseDragged : .mouseMoved, at, .left, [])
    return ["ok": true]
  case "down":
    guard let at = point(command["at"]) else { return ["ok": false, "error": "no point"] }
    mouse(.mouseMoved, at, .left, [])
    usleep(60_000)
    mouse(.leftMouseDown, at, .left, [], clicks: 1)
    return ["ok": true]
  case "up":
    guard let at = point(command["at"]) else { return ["ok": false, "error": "no point"] }
    mouse(.leftMouseUp, at, .left, [], clicks: 1)
    return ["ok": true]
  case "screens":
    return [
      "ok": true,
      "screens": NSScreen.screens.map {
        ["w": $0.frame.width, "h": $0.frame.height, "scale": $0.backingScaleFactor]
      },
    ]
  case "drag":
    let path = (command["path"] as? [Any] ?? []).compactMap(point)
    guard path.count >= 2 else { return ["ok": false, "error": "a drag needs two points"] }
    drag(path, holdMs: command["holdMs"] as? Int ?? 150, button: command["button"] as? String ?? "left")
    return ["ok": true]
  case "scroll":
    guard let at = point(command["at"]) else { return ["ok": false, "error": "no point"] }
    mouse(.mouseMoved, at, .left, [])
    usleep(60_000)
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
      wheel1: Int32(command["dy"] as? Int ?? 0), wheel2: Int32(command["dx"] as? Int ?? 0),
      wheel3: 0)
    event?.flags = mods
    post(event)
    return ["ok": true]
  case "key":
    let label = (command["key"] as? String ?? "").lowercased()
    guard let code = keyCodes[label] ?? (command["code"] as? Int).map({ CGKeyCode($0) }) else {
      return ["ok": false, "error": "unknown key \(label)"]
    }
    key(code, mods: mods, repeats: command["repeats"] as? Int ?? 0,
      intervalMs: command["intervalMs"] as? Int ?? 35)
    return ["ok": true]
  case "type":
    type(command["text"] as? String ?? "")
    return ["ok": true]
  case "inputSources":
    let list =
      (TISCreateInputSourceList(nil, false)?.takeRetainedValue() as? [TISInputSource]) ?? []
    let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
    return [
      "ok": true, "enabled": list.map(sourceID),
      "current": current.map(sourceID) ?? "",
    ]
  case "selectInputSource":
    let id = command["source"] as? String ?? ""
    guard let found = inputSource(id) else { return ["ok": false, "error": "no input source \(id)"] }
    // An input mode (Kotoeri's Japanese) is selectable only once its input
    // method is enabled too, so the parent is enabled first.
    var parentEnabled: Int? = nil
    if let dot = id.lastIndex(of: "."), let parent = inputSource(String(id[..<dot])) {
      parentEnabled = Int(TISEnableInputSource(parent))
    }
    let enabled = TISEnableInputSource(found)
    var selected = TISSelectInputSource(found)
    for _ in 0..<8 where selected != noErr {
      usleep(500_000)
      selected = TISSelectInputSource(found)
    }
    usleep(300_000)
    let capable = TISGetInputSourceProperty(found, kTISPropertyInputSourceIsSelectCapable).map {
      CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque($0).takeUnretainedValue())
    }
    let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
    return [
      "ok": selected == noErr, "enable": Int(enabled), "select": Int(selected),
      "parentEnable": parentEnabled ?? "no parent", "selectCapable": capable ?? "unknown",
      "current": current.map(sourceID) ?? "",
    ]
  default:
    return ["ok": false, "error": "unknown command \(name)"]
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  guard let data = line.data(using: .utf8),
    let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else {
    reply(["ok": false, "error": "unreadable command"])
    continue
  }
  var answer = run(command)
  if let id = command["id"] { answer["id"] = id }
  reply(answer)
}
