#!/usr/bin/env python3
"""Native input and AT-SPI for the Linux acceptance lane (#504).

One JSON command per stdin line, one JSON answer per stdout line. Input goes
through the X server's XTEST extension (xdotool), as a mouse and keyboard would,
so WebKitGTK receives real X events, the input method sees real key presses, and a
drag can leave the window. What the app shows is read back from its AT-SPI tree,
which is what Orca reads. Nothing here touches the page's DOM or scripts.
"""

import json
import subprocess
import sys
import time

import pyatspi

target = 0


def xdotool(*args):
    return subprocess.run(["xdotool", *map(str, args)], capture_output=True, text=True, check=False)


def application(pid=None):
    wanted = target if pid is None else pid
    desktop = pyatspi.Registry.getDesktop(0)
    for index in range(desktop.childCount):
        app = desktop.getChildAtIndex(index)
        try:
            if app is not None and app.get_process_id() == wanted:
                return app
        except Exception:
            continue
    return None


def applications():
    desktop = pyatspi.Registry.getDesktop(0)
    found = []
    for index in range(desktop.childCount):
        app = desktop.getChildAtIndex(index)
        try:
            if app is not None:
                found.append({"pid": app.get_process_id(), "name": app.name})
        except Exception:
            continue
    return found


def text_of(node):
    try:
        text = node.queryText()
        return text.getText(0, min(text.characterCount, 4000))
    except Exception:
        return None


def summary(node):
    item = {"role": node.getRoleName()}
    if node.name:
        item["name"] = node.name
    if node.description:
        item["desc"] = node.description
    try:
        attributes = dict(a.split(":", 1) for a in node.getAttributes() if ":" in a)
        for key in ("id", "class", "tag", "xml-roles"):
            if key in attributes:
                item[key] = attributes[key]
    except Exception:
        pass
    try:
        value = node.queryValue()
        item["min"] = value.minimumValue
        item["max"] = value.maximumValue
    except Exception:
        pass
    if node.getRole() == pyatspi.ROLE_DOCUMENT_WEB:
        try:
            item["url"] = node.queryDocument().getAttributeValue("DocURL")
        except Exception:
            pass
    states = node.getState()
    if states.contains(pyatspi.STATE_VERTICAL):
        item["orientation"] = "vertical"
    elif states.contains(pyatspi.STATE_HORIZONTAL):
        item["orientation"] = "horizontal"
    if states.contains(pyatspi.STATE_CHECKED):
        item["selected"] = True
    for name, state in (
        ("focused", pyatspi.STATE_FOCUSED),
        ("enabled", pyatspi.STATE_ENABLED),
        ("selected", pyatspi.STATE_SELECTED),
        ("expanded", pyatspi.STATE_EXPANDED),
        ("showing", pyatspi.STATE_SHOWING),
    ):
        item[name] = states.contains(state)
    try:
        value = node.queryValue()
        item["value"] = value.currentValue
    except Exception:
        text = text_of(node)
        if text and node.getRole() in (pyatspi.ROLE_ENTRY, pyatspi.ROLE_TEXT, pyatspi.ROLE_STATIC, pyatspi.ROLE_LABEL, pyatspi.ROLE_PARAGRAPH):
            item["value"] = text
    # AT-SPI keeps inline text in its container's Text interface, not in child
    # objects; embedded children show as U+FFFC, which is dropped here.
    text = text_of(node)
    if text:
        item["text"] = text.replace("\ufffc", "").strip()[:600]
    try:
        box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        item["frame"] = {"x": box.x, "y": box.y, "w": box.width, "h": box.height}
    except Exception:
        pass
    return item


budget = 0


def tree(node, depth):
    global budget
    budget -= 1
    item = summary(node)
    if depth > 0 and budget > 0:
        kids = []
        for index in range(node.childCount):
            child = node.getChildAtIndex(index)
            if child is not None and budget > 0:
                kids.append(tree(child, depth - 1))
        if kids:
            item["children"] = kids
    return item


def windows(pid=None):
    app = application(pid)
    if app is None:
        return []
    return [app.getChildAtIndex(i) for i in range(app.childCount) if app.getChildAtIndex(i) is not None]


def focused():
    app = application()
    if app is None:
        return None

    # The web view itself carries the focused state too; the control that has
    # focus is the deepest focused node.
    def walk(node, depth):
        if node is None or depth < 0:
            return None
        deeper = None
        for index in range(node.childCount):
            deeper = walk(node.getChildAtIndex(index), depth - 1)
            if deeper is not None:
                return deeper
        if node.getState().contains(pyatspi.STATE_FOCUSED):
            return node
        return None

    return walk(app, 80)


def selection():
    found = []

    def walk(node, depth):
        if node is None or depth < 0:
            return
        try:
            text = node.queryText()
            for index in range(text.getNSelections()):
                start, end = text.getSelection(index)
                found.append(text.getText(start, end))
        except Exception:
            pass
        for index in range(node.childCount):
            walk(node.getChildAtIndex(index), depth - 1)

    walk(application(), 80)
    return "".join(found)


def menus():
    """Open menus, such as a context menu, by their items' names."""
    found = []

    def walk(node, depth):
        if node is None or depth < 0:
            return
        role = node.getRole()
        if role in (pyatspi.ROLE_MENU, pyatspi.ROLE_POPUP_MENU) and node.getState().contains(pyatspi.STATE_SHOWING):
            items = []
            for index in range(node.childCount):
                child = node.getChildAtIndex(index)
                if child is not None and child.getRole() in (pyatspi.ROLE_MENU_ITEM, pyatspi.ROLE_CHECK_MENU_ITEM, pyatspi.ROLE_RADIO_MENU_ITEM, pyatspi.ROLE_MENU):
                    items.append(child.name or "-")
            if items:
                found.append(items)
            return
        for index in range(node.childCount):
            walk(node.getChildAtIndex(index), depth - 1)

    app = application()
    if app is not None:
        walk(app, 12)
    return found


BUTTONS = {"left": 1, "middle": 2, "right": 3}
MODS = {"ctrl": "ctrl", "shift": "shift", "alt": "alt", "cmd": "super"}


def run(command):
    global target, budget
    name = command.get("cmd")
    mods = [MODS[m] for m in command.get("mods", []) if m in MODS]
    if name == "target":
        target = int(command.get("pid", 0))
        return {"ok": application() is not None}
    if name == "windows":
        return {"ok": True, "windows": [summary(w) for w in windows()]}
    if name == "tree":
        budget = command.get("budget", 6000)
        found = windows(command.get("pid"))
        if not found:
            return {"ok": False, "error": "no window"}
        return {"ok": True, "tree": tree(found[0], command.get("depth", 80))}
    if name == "selectInputSource":
        # IBus engines: anthy composes Japanese, xkb:us::eng types Latin.
        subprocess.run(["ibus", "engine", command.get("source", "")], capture_output=True, text=True, check=False)
        time.sleep(0.5)
        current = subprocess.run(["ibus", "engine"], capture_output=True, text=True, check=False).stdout.strip()
        return {"ok": current == command.get("source"), "current": current}
    if name == "inputSources":
        current = subprocess.run(["ibus", "engine"], capture_output=True, text=True, check=False).stdout.strip()
        return {"ok": True, "current": current}
    if name == "hideApp":
        ids = xdotool("search", "--pid", int(command.get("pid", 0)), "--onlyvisible", "--name", ".").stdout.split()
        for window in ids:
            xdotool("windowminimize", window)
        time.sleep(0.4)
        return {"ok": bool(ids), "windows": ids}
    if name == "frontmost":
        active = xdotool("getactivewindow", "getwindowpid").stdout.strip()
        return {"ok": True, "pid": int(active) if active.isdigit() else 0}
    if name == "running":
        return {"ok": True, "apps": applications()}
    if name == "focused":
        node = focused()
        return {"ok": True, "focused": summary(node) if node is not None else None}
    if name == "selection":
        return {"ok": True, "text": selection()}
    if name == "click":
        x, y = command["at"]
        for mod in mods:
            xdotool("keydown", mod)
        xdotool("mousemove", int(x), int(y))
        time.sleep(0.12)
        xdotool("click", "--repeat", command.get("count", 1), BUTTONS[command.get("button", "left")])
        for mod in reversed(mods):
            xdotool("keyup", mod)
        return {"ok": True}
    if name == "move":
        x, y = command["at"]
        xdotool("mousemove", int(x), int(y))
        return {"ok": True}
    if name == "down":
        x, y = command["at"]
        xdotool("mousemove", int(x), int(y))
        time.sleep(0.06)
        xdotool("mousedown", 1)
        return {"ok": True}
    if name == "up":
        x, y = command["at"]
        xdotool("mousemove", int(x), int(y))
        xdotool("mouseup", 1)
        return {"ok": True}
    if name == "menus":
        return {"ok": True, "menus": menus()}
    if name == "screens":
        geometry = xdotool("getdisplaygeometry").stdout.split()
        return {"ok": True, "screens": [{"w": int(geometry[0]), "h": int(geometry[1])}] if len(geometry) == 2 else []}
    if name == "drag":
        path = command["path"]
        xdotool("mousemove", int(path[0][0]), int(path[0][1]))
        time.sleep(0.08)
        xdotool("mousedown", 1)
        time.sleep(0.12)
        for (fx, fy), (tx, ty) in zip(path, path[1:]):
            steps = max(int(((tx - fx) ** 2 + (ty - fy) ** 2) ** 0.5 / 6), 4)
            for step in range(1, steps + 1):
                xdotool("mousemove", int(fx + (tx - fx) * step / steps), int(fy + (ty - fy) * step / steps))
                time.sleep(0.008)
        time.sleep(command.get("holdMs", 150) / 1000)
        xdotool("mouseup", 1)
        return {"ok": True}
    if name == "scroll":
        x, y = command["at"]
        xdotool("mousemove", int(x), int(y))
        dy, dx = command.get("dy", 0), command.get("dx", 0)
        for _ in range(abs(dy) // 40 or (1 if dy else 0)):
            xdotool("click", 5 if dy < 0 else 4)
        for _ in range(abs(dx) // 40 or (1 if dx else 0)):
            xdotool("click", 7 if dx < 0 else 6)
        return {"ok": True}
    if name == "key":
        key = command["key"]
        combo = "+".join([*mods, key])
        repeats = command.get("repeats", 0)
        if repeats:
            # A held key: the X server repeats the key press until the release.
            xdotool("keydown", combo)
            time.sleep(repeats * command.get("intervalMs", 35) / 1000)
            xdotool("keyup", combo)
        else:
            xdotool("key", "--clearmodifiers", combo)
        return {"ok": True}
    if name == "type":
        xdotool("type", "--delay", 30, command.get("text", ""))
        return {"ok": True}
    if name == "activate":
        result = xdotool("search", "--pid", target, "--onlyvisible", "--name", ".")
        ids = result.stdout.split()
        if ids:
            xdotool("windowactivate", ids[-1])
            time.sleep(0.4)
        return {"ok": bool(ids), "windows": ids}
    if name == "setFrame":
        ids = xdotool("search", "--pid", target, "--onlyvisible", "--name", ".").stdout.split()
        if not ids:
            return {"ok": False, "error": "no window"}
        if "w" in command:
            xdotool("windowsize", ids[-1], int(command["w"]), int(command["h"]))
        if "x" in command:
            xdotool("windowmove", ids[-1], int(command["x"]), int(command["y"]))
        time.sleep(0.3)
        return {"ok": True}
    return {"ok": False, "error": f"unknown command {name}"}


for line in sys.stdin:
    try:
        command = json.loads(line)
    except ValueError:
        print(json.dumps({"ok": False, "error": "unreadable command"}), flush=True)
        continue
    try:
        answer = run(command)
    except Exception as error:  # noqa: BLE001 - every failure is reported, not raised
        answer = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    if "id" in command:
        answer["id"] = command["id"]
    print(json.dumps(answer, ensure_ascii=False), flush=True)
