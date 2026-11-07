// The native lane's view of the app: one helper process per platform that sends
// real input (CGEvent, SendInput, XTEST) and reads the accessibility tree back.
// Roles and names are normalised here so the rows read the same on every
// platform. Nothing in this file evaluates script in the page or reads its DOM.

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const PLATFORM =
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
/** Cmd on macOS, Ctrl elsewhere: the app's shell chord (rail-shortcuts.ts). */
export const MOD = PLATFORM === 'mac' ? 'cmd' : 'ctrl';

export async function until(what, probe, timeout = 15_000, interval = 250) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

// ---- Role normalisation

const MAC_ROLES = {
  AXButton: 'button',
  AXPopUpButton: 'button',
  AXMenuButton: 'button',
  AXDisclosureTriangle: 'button',
  AXLink: 'link',
  AXTextArea: 'textbox',
  AXTextField: 'textbox',
  AXComboBox: 'combobox',
  AXHeading: 'heading',
  AXSplitter: 'separator',
  AXTable: 'table',
  AXGrid: 'table',
  AXCell: 'cell',
  AXRow: 'row',
  AXStaticText: 'text',
  AXRadioButton: 'radio',
  AXRadioGroup: 'radiogroup',
  AXCheckBox: 'checkbox',
  AXMenu: 'menu',
  AXMenuItem: 'menuitem',
  AXList: 'list',
  AXWebArea: 'document',
  AXImage: 'img',
  AXTabGroup: 'tablist',
  AXGroup: 'group',
  AXWindow: 'window',
};
const MAC_SUBROLES = {
  AXApplicationDialog: 'dialog',
  AXApplicationAlertDialog: 'alertdialog',
  AXApplicationStatus: 'status',
  AXApplicationAlert: 'alert',
  AXApplicationLog: 'log',
  AXLandmarkRegion: 'region',
  AXLandmarkNavigation: 'navigation',
  AXLandmarkMain: 'main',
  AXLandmarkComplementary: 'complementary',
  AXLandmarkSearch: 'search',
  AXSwitch: 'switch',
  AXSearchField: 'textbox',
  AXTabButton: 'tab',
};
const WINDOWS_LOCALIZED = {
  dialog: 'dialog',
  'alert dialog': 'alertdialog',
  heading: 'heading',
  status: 'status',
  region: 'region',
  complementary: 'complementary',
  alert: 'alert',
  splitter: 'separator',
  separator: 'separator',
  link: 'link',
  button: 'button',
  'toggle button': 'button',
  'menu button': 'button',
  edit: 'textbox',
  'radio button': 'radio',
  'check box': 'checkbox',
  switch: 'switch',
  table: 'table',
  cell: 'cell',
  menu: 'menu',
  'menu item': 'menuitem',
  document: 'document',
};
const WINDOWS_TYPES = {
  Button: 'button',
  Hyperlink: 'link',
  Edit: 'textbox',
  Text: 'text',
  Document: 'document',
  Table: 'table',
  DataItem: 'cell',
  RadioButton: 'radio',
  CheckBox: 'checkbox',
  Menu: 'menu',
  MenuItem: 'menuitem',
  List: 'list',
  Separator: 'separator',
  Thumb: 'separator',
  Window: 'window',
  Group: 'group',
  StatusBar: 'status',
};
const LINUX_ROLES = {
  'push button': 'button',
  'toggle button': 'button',
  link: 'link',
  entry: 'textbox',
  'password text': 'textbox',
  heading: 'heading',
  dialog: 'dialog',
  'alert dialog': 'alertdialog',
  separator: 'separator',
  splitter: 'separator',
  table: 'table',
  'table cell': 'cell',
  'status bar': 'status',
  notification: 'alert',
  alert: 'alert',
  'radio button': 'radio',
  'check box': 'checkbox',
  switch: 'switch',
  menu: 'menu',
  'popup menu': 'menu',
  'menu item': 'menuitem',
  'document web': 'document',
  paragraph: 'text',
  'description term': 'text',
  'description value': 'text',
  'block quote': 'text',
  caption: 'text',
  frame: 'window',
  label: 'text',
  static: 'text',
};

const NAMED_BY_CONTENT = new Set(['heading', 'link', 'button', 'cell', 'menuitem', 'radio']);
const clean = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

function textOf(node) {
  if (!node) return '';
  const own = node.role === 'text' ? clean(String(node.value ?? node.name ?? '')) : '';
  return [own, ...(node.children ?? []).map(textOf)].filter(Boolean).join(' ');
}

function roleOf(raw) {
  if (PLATFORM === 'mac') return MAC_SUBROLES[raw.subrole] ?? MAC_ROLES[raw.role] ?? raw.role;
  if (PLATFORM === 'windows') {
    return (
      WINDOWS_LOCALIZED[(raw.localized ?? '').toLowerCase()] ?? WINDOWS_TYPES[raw.role] ?? raw.role
    );
  }
  const xml = (raw['xml-roles'] ?? '').split(/\s+/)[0];
  if (
    xml &&
    ['dialog', 'alertdialog', 'status', 'region', 'complementary', 'separator', 'switch'].includes(
      xml,
    )
  ) {
    return xml;
  }
  return LINUX_ROLES[raw.role] ?? raw.role;
}

/** One platform node as { role, name, value, focused, frame, children, raw }. */
export function normalize(raw, parent = null) {
  if (!raw || typeof raw !== 'object') return null;
  const node = {
    role: roleOf(raw),
    name: '',
    value: raw.value,
    focused: Boolean(raw.focused),
    enabled: raw.enabled !== false,
    expanded: raw.expanded,
    selected: raw.selected,
    frame: raw.frame ?? null,
    url: raw.url,
    raw,
    parent,
    children: [],
  };
  node.children = (raw.children ?? []).map((child) => normalize(child, node)).filter(Boolean);
  if (PLATFORM === 'mac') {
    node.name = clean(raw.desc) || clean(raw.title);
    node.description = clean(raw.help);
    node.roleDescription = raw.roleDescription;
  } else if (PLATFORM === 'windows') {
    node.name = clean(raw.name);
    node.description = clean(raw.help);
    node.roleDescription = raw.localized;
  } else {
    node.name = clean(raw.name);
    node.description = clean(raw.desc);
    node.roleDescription = raw.role;
    // Inline text lives in its container on AT-SPI (see native_driver.py).
    if (node.role === 'text' && node.value === undefined && raw.text) node.value = raw.text;
    if (!node.name && NAMED_BY_CONTENT.has(node.role) && raw.text) node.name = clean(raw.text);
  }
  if (!node.name && NAMED_BY_CONTENT.has(node.role)) node.name = clean(textOf(node));
  return node;
}

export function* walk(node) {
  if (!node) return;
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function matches(node, role, name, { exact = true } = {}) {
  if (role && node.role !== role) return false;
  if (name === undefined) return true;
  if (name instanceof RegExp) return name.test(node.name);
  return exact ? node.name === name : node.name.includes(name);
}

export function center(node) {
  const f = node?.frame;
  if (!f || !(f.w > 0) || !(f.h > 0))
    throw new Error(`${node?.role} "${node?.name}" has no on-screen frame`);
  return [Math.round(f.x + f.w / 2), Math.round(f.y + f.h / 2)];
}

/** A compact outline of a tree, for failure notes and for learning a platform's tree. */
export function outline(node, depth = 0, lines = [], max = 400) {
  if (!node || lines.length >= max) return lines;
  const value =
    node.value === undefined || node.value === ''
      ? ''
      : ` = ${JSON.stringify(String(node.value).slice(0, 60))}`;
  if (node.role !== 'group' || node.name || depth < 2) {
    lines.push(
      `${'  '.repeat(Math.min(depth, 20))}${node.role}${node.name ? ` "${node.name.slice(0, 80)}"` : ''}${value}${node.focused ? ' [focused]' : ''}`,
    );
  }
  for (const child of node.children) outline(child, depth + 1, lines, max);
  return lines;
}

// ---- The helper process

const KEYS_LINUX = {
  tab: 'Tab',
  return: 'Return',
  enter: 'Return',
  escape: 'Escape',
  space: 'space',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  home: 'Home',
  end: 'End',
  delete: 'BackSpace',
  forwarddelete: 'Delete',
  pageup: 'Prior',
  pagedown: 'Next',
  '[': 'bracketleft',
  ']': 'bracketright',
  f10: 'F10',
  apps: 'Menu',
};

export class Native {
  constructor(command, args, { log } = {}) {
    this.command = command;
    this.args = args;
    this.log = log;
    this.next = 1;
    this.stderr = [];
    this.restarts = [];
    this.start();
  }

  start() {
    this.child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let answer;
      try {
        answer = JSON.parse(line);
      } catch {
        this.stderr.push(`unparsed: ${line.slice(0, 200)}`);
        return;
      }
      const waiting = this.pending.get(answer.id);
      if (waiting) {
        this.pending.delete(answer.id);
        waiting(answer);
      }
    });
    this.child.stderr.on('data', (chunk) => this.stderr.push(String(chunk)));
    this.child.on('exit', (code) => {
      for (const waiting of this.pending.values())
        waiting({ ok: false, error: `helper exited ${code}` });
      this.pending.clear();
    });
  }

  /**
   * A platform call that never returns (UI Automation can block on a busy
   * window) would wedge every later call, so the helper is replaced and told
   * its target again; each replacement is kept for the record.
   */
  restart(reason) {
    this.restarts.push(reason);
    const old = this.child;
    old.removeAllListeners('exit');
    for (const waiting of this.pending.values())
      waiting({ ok: false, error: `helper restarted: ${reason}` });
    old.kill();
    this.start();
    if (this.target)
      this.child.stdin.write(`${JSON.stringify({ ...this.target, id: this.next++ })}\n`);
  }

  call(command, timeout = 60_000) {
    if (command.cmd === 'target') this.target = command;
    if (this.child.exitCode !== null) {
      return Promise.resolve({
        ok: false,
        error: `helper exited ${this.child.exitCode}: ${this.stderr.join('').slice(-400)}`,
      });
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart(`${command.cmd} unanswered after ${timeout}ms`);
        reject(new Error(`helper did not answer ${command.cmd} in ${timeout}ms`));
      }, timeout);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  async must(command, timeout) {
    const answer = await this.call(command, timeout);
    if (!answer.ok) throw new Error(`${command.cmd}: ${answer.error ?? 'failed'}`);
    return answer;
  }

  close() {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 2_000).unref();
  }
}

/** The app as a person sees it: snapshots of its tree, and real input. */
export class App {
  constructor(native, pid) {
    this.native = native;
    this.pid = pid;
  }

  async snapshot() {
    const command =
      PLATFORM === 'mac'
        ? { cmd: 'web', depth: 90, budget: 9000 }
        : { cmd: 'tree', depth: 90, budget: 9000 };
    const answer = await this.native.call(command);
    if (!answer.ok) return null;
    return normalize(answer.tree);
  }

  async all(role, name, options = {}) {
    const root = await this.snapshot();
    let scope = root ? [root] : [];
    if (options.within) {
      const [withinRole, withinName] = options.within;
      scope = [...walk(root)].filter((node) => matches(node, withinRole, withinName));
    }
    const found = [];
    for (const top of scope)
      for (const node of walk(top)) if (matches(node, role, name, options)) found.push(node);
    return found;
  }

  async one(role, name, options = {}) {
    let seen = [];
    try {
      return await until(
        `one ${role} "${name}"`,
        async () => {
          seen = await this.all(role, name, options);
          return seen.length === 1 ? seen[0] : seen.length > 1 && options.first ? seen[0] : null;
        },
        options.timeout ?? 15_000,
      );
    } catch (error) {
      throw new Error(`${error.message} (found ${seen.length})`);
    }
  }

  async gone(role, name, options = {}) {
    await until(
      `${role} "${name}" to close`,
      async () => (await this.all(role, name, options)).length === 0,
      options.timeout ?? 10_000,
    );
  }

  async count(role, name, options) {
    return (await this.all(role, name, options)).length;
  }

  async focused() {
    const answer = await this.native.call({ cmd: 'focused' });
    return answer.ok && answer.focused ? normalize(answer.focused) : null;
  }

  async focusedName() {
    const node = await this.focused();
    return node ? node.name || `(${node.role})` : null;
  }

  async selection() {
    const answer = await this.native.call({ cmd: 'selection' });
    return answer.ok ? (answer.text ?? '') : null;
  }

  async click(nodeOrPoint, { button = 'left', mods = [], count = 1 } = {}) {
    if (!nodeOrPoint) throw new Error('nothing to click: the control was not found');
    const at = Array.isArray(nodeOrPoint) ? nodeOrPoint : center(await this.visible(nodeOrPoint));
    await this.native.must({ cmd: 'click', at, button, mods, count });
    await sleep(250);
  }

  /** The part of the screen where the window's content can be seen. */
  async viewport() {
    const frame = (await this.window())?.frame;
    const sw = this.screen?.w ?? Number.POSITIVE_INFINITY;
    const sh = this.screen?.h ?? Number.POSITIVE_INFINITY;
    return {
      frame,
      top: Math.max((frame?.y ?? 0) + 30, 30),
      bottom: Math.min(frame ? frame.y + frame.h : sh, sh) - 6,
      left: Math.max(frame?.x ?? 0, 0),
      right: Math.min(frame ? frame.x + frame.w : sw, sw),
      sw,
      sh,
    };
  }

  /** Whether a node's whole height and its centre are inside the visible window. */
  async onScreen(node) {
    if (!node?.frame) return false;
    const { top, bottom, left, right } = await this.viewport();
    const [cx] = center(node);
    return node.frame.y >= top && node.frame.y + node.frame.h <= bottom && cx > left && cx < right;
  }

  /**
   * Scrolls until a node sits in the middle of the window, clear of the header
   * and the composer that cover the transcript's top and bottom edges.
   */
  async middle(node, find) {
    let current = node;
    for (let attempt = 0; attempt < 20 && current?.frame; attempt += 1) {
      const { top, bottom, left, right } = await this.viewport();
      const band = [top + (bottom - top) * 0.25, top + (bottom - top) * 0.6];
      const [, cy] = center(current);
      if (cy >= band[0] && cy <= band[1]) return current;
      await this.native.must({
        cmd: 'scroll',
        at: [Math.round((left + right) / 2), Math.round((top + bottom) / 2)],
        dy: cy > band[1] ? -120 : 120,
      });
      await sleep(350);
      current = (await find()) ?? current;
    }
    return current;
  }

  /**
   * A control below the window's edge (or under the Dock) is scrolled into view
   * with the wheel, as a person would, before it is clicked; a click never lands
   * on whatever happens to cover it.
   */
  async visible(node) {
    if (!node?.frame) return node;
    let current = node;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { frame, top, bottom, left, right, sw, sh } = await this.viewport();
      const [cx, cy] = center(current);
      if (cy > top && cy < bottom && cx > left && cx < right) return current;
      const across = cx <= left || cx >= right;
      if (across && (cy <= top || cy >= bottom)) {
        throw new Error(
          `${current.role} "${current.name}" is outside the visible window (at ${cx},${cy}; window ${JSON.stringify(frame)}; screen ${sw}x${sh})`,
        );
      }
      const before = await this.all(current.role, current.name);
      const index = Math.max(
        before.findIndex(
          (each) => each.frame?.y === current.frame.y && each.frame?.x === current.frame.x,
        ),
        0,
      );
      // Across: the wheel over the node's own row scrolls its container sideways.
      await this.native.must(
        across
          ? {
              cmd: 'scroll',
              at: [Math.round((left + right) / 2), cy],
              dx: cx >= right ? -240 : 240,
              dy: 0,
            }
          : {
              cmd: 'scroll',
              at: [Math.round((left + right) / 2), Math.round((top + bottom) / 2)],
              dy: cy >= bottom ? -240 : 240,
            },
      );
      await sleep(400);
      const after = await this.all(current.role, current.name);
      current = after[index] ?? after[0] ?? current;
    }
    throw new Error(`${node.role} "${node.name}" could not be scrolled into view`);
  }

  async move(at) {
    await this.native.must({ cmd: 'move', at });
  }

  async drag(path, holdMs = 150) {
    await this.native.must({ cmd: 'drag', path, holdMs }, 120_000);
    await sleep(250);
  }

  async key(name, mods = [], { repeats = 0, intervalMs = 35 } = {}) {
    const key = PLATFORM === 'linux' ? (KEYS_LINUX[name.toLowerCase()] ?? name) : name;
    await this.native.must({ cmd: 'key', key, mods, repeats, intervalMs });
    await sleep(200);
  }

  async type(text) {
    await this.native.must({ cmd: 'type', text }, 120_000);
    await sleep(200);
  }

  async activate() {
    return (await this.native.call({ cmd: 'activate' })).ok;
  }

  /** The app's main window: the largest, never a candidate or tooltip panel. */
  async window() {
    const answer = await this.native.call({ cmd: 'windows' });
    if (!answer.ok) return null;
    const area = (each) => (each?.frame ? each.frame.w * each.frame.h : 0);
    const largest = [...(answer.windows ?? [])].sort((a, b) => area(b) - area(a))[0];
    return normalize(largest);
  }

  async setFrame(frame) {
    return this.native.must({ cmd: 'setFrame', ...frame });
  }
}

// ---- Clipboard, read and reset by separate processes, never by the page

export function readClipboard() {
  if (PLATFORM === 'mac') return execFileSync('pbpaste', [], { encoding: 'utf8', timeout: 10_000 });
  if (PLATFORM === 'windows') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    return out.replace(/\r\n/g, '\n');
  }
  try {
    return execFileSync('xclip', ['-o', '-selection', 'clipboard'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.status === 1) return '';
    throw error;
  }
}

/** Puts a marker on the clipboard so a later read proves the app wrote it. */
export function markClipboard(text = 'clipboard-marker') {
  if (PLATFORM === 'mac') execFileSync('pbcopy', [], { input: text });
  else if (PLATFORM === 'windows') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Set-Clipboard -Value '${text}'`,
    ]);
  } else {
    const child = spawn('xclip', ['-selection', 'clipboard'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.stdin.end(text);
    child.unref();
  }
  return text;
}

export function screenshot(path) {
  try {
    if (PLATFORM === 'mac') execFileSync('screencapture', ['-x', path], { timeout: 20_000 });
    else if (PLATFORM === 'windows') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size); $i.Save('${path}')`,
        ],
        { timeout: 30_000 },
      );
    } else execFileSync('import', ['-window', 'root', path], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
