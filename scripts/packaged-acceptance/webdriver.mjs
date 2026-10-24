// A minimal W3C WebDriver client: just the endpoints the packaged acceptance
// suite uses, over fetch, so the suite adds no browser framework to the tree.

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export const Key = {
  Backspace: '',
  Tab: '',
  Enter: '',
  Shift: '',
  Control: '',
  Escape: '',
  End: '',
  Home: '',
  ArrowLeft: '',
  ArrowRight: '',
};

export class WebDriverError extends Error {
  constructor(method, path, status, value) {
    super(`${method} ${path} -> ${status}: ${value?.error ?? 'error'}: ${value?.message ?? ''}`);
    this.code = value?.error;
  }
}

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok || parsed.value?.error) {
    throw new WebDriverError(method, path, response.status, parsed.value);
  }
  return parsed.value;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown from an `until` probe to fail at once instead of polling on. */
export class Stop extends Error {}

/** Polls `probe` until it returns a truthy value, or fails naming `what`. */
export async function until(what, probe, timeout = 15_000, interval = 100) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error instanceof Stop) throw error;
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`,
      );
    }
    await sleep(interval);
  }
}

// Runs in the page. Finds visible elements by ARIA role and accessible name,
// close enough to Playwright's getByRole for the controls this suite touches.
const QUERY = `
const [role, name, exact, scope] = arguments;
const implicit = {
  button: 'button, [role="button"]',
  link: 'a[href], [role="link"]',
  textbox: 'textarea, input:not([type]), input[type="text"], [role="textbox"]',
  dialog: 'dialog, [role="dialog"], [role="alertdialog"]',
  separator: '[role="separator"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  columnheader: 'th, [role="columnheader"]',
  cell: 'td, [role="cell"]',
  alert: '[role="alert"]',
};
const nameOf = (node) => {
  const label = node.getAttribute('aria-label');
  if (label) return label.trim();
  const by = node.getAttribute('aria-labelledby');
  if (by) {
    return by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ').replace(/\\s+/g, ' ').trim();
  }
  if (node.labels?.length) return node.labels[0].textContent.replace(/\\s+/g, ' ').trim();
  return (node.textContent ?? '').replace(/\\s+/g, ' ').trim();
};
const visible = (node) => {
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
};
const root = scope ?? document;
return [...root.querySelectorAll(implicit[role] ?? '[role="' + role + '"]')].filter((node) => {
  if (!visible(node)) return false;
  if (name === null) return true;
  const actual = nameOf(node);
  return exact ? actual === name : actual.includes(name);
});
`;

export class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  static async start(base, capabilities) {
    const value = await request(base, 'POST', '/session', {
      capabilities: { alwaysMatch: capabilities },
    });
    return new Session(base, value.sessionId);
  }

  call(method, path, body) {
    return request(this.base, method, `/session/${this.id}${path}`, body);
  }

  end() {
    return this.call('DELETE', '');
  }

  execute(script, ...args) {
    return this.call('POST', '/execute/sync', {
      script,
      args: args.map((arg) => (arg instanceof Element ? { [ELEMENT]: arg.ref } : arg)),
    }).then((value) => this.wrap(value));
  }

  /** Runs an async script; it settles by calling the callback passed last. */
  executeAsync(script, ...args) {
    return this.call('POST', '/execute/async', {
      script,
      args: args.map((arg) => (arg instanceof Element ? { [ELEMENT]: arg.ref } : arg)),
    }).then((value) => this.wrap(value));
  }

  wrap(value) {
    if (Array.isArray(value)) return value.map((item) => this.wrap(item));
    if (value && typeof value === 'object' && ELEMENT in value) {
      return new Element(this, value[ELEMENT]);
    }
    return value;
  }

  /** All visible elements with this role and (partial, unless exact) accessible name. */
  all(role, name = null, { exact = true, within } = {}) {
    return this.execute(QUERY, role, name, exact, within ?? null);
  }

  /** Waits for exactly one visible element with this role and name. */
  async one(role, name = null, options = {}) {
    const timeout = options.timeout ?? 15_000;
    return until(
      `one ${role}${name === null ? '' : ` named "${name}"`}`,
      async () => {
        const found = await this.all(role, name, options);
        return found.length === 1 ? found[0] : null;
      },
      timeout,
    );
  }

  async gone(role, name = null, options = {}) {
    await until(
      `no ${role}${name === null ? '' : ` named "${name}"`}`,
      async () => (await this.all(role, name, options)).length === 0,
      options.timeout ?? 15_000,
    );
  }

  async css(selector) {
    return this.execute('return [...document.querySelectorAll(arguments[0])];', selector);
  }

  async active() {
    return this.wrap(await this.call('GET', '/element/active'));
  }

  async isActive(element) {
    return this.execute('return document.activeElement === arguments[0];', element);
  }

  actions(actions) {
    return this.call('POST', '/actions', { actions });
  }

  release() {
    return this.call('DELETE', '/actions');
  }

  /** Presses keys in order; a key listed as `[modifier, key]` is chorded. */
  async press(...keys) {
    const steps = [];
    for (const key of keys) {
      if (Array.isArray(key)) {
        const [modifier, inner] = key;
        steps.push({ type: 'keyDown', value: modifier }, { type: 'keyDown', value: inner });
        steps.push({ type: 'keyUp', value: inner }, { type: 'keyUp', value: modifier });
      } else {
        steps.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
      }
    }
    await this.actions([{ type: 'key', id: 'keyboard', actions: steps }]);
  }

  /**
   * A pointer click on an element's centre with a given button and held
   * modifier, after scrolling it into view as a reader would. WebDriver's own
   * element click refuses controls that appear on hover (opacity 0 until then);
   * a pointer that moves onto them first is what a person does.
   */
  async click(element, { button = 0, modifier } = {}) {
    // Aim at the centre in viewport coordinates, and refuse rather than click
    // whatever covers the target: WebKitWebDriver's element origin rejects a
    // covered element without saying what covers it.
    const aim = await element.evaluate(`node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      const describe = (el) => el ? el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
      const rect = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round).join(','); };
      return { x, y, reachable: Boolean(hit) && (node === hit || node.contains(hit)), cover: describe(hit), target: rect(node), covering: hit ? rect(hit) : '' };`);
    if (!aim.reachable) {
      throw new Error(
        `The target (${aim.target}) is covered at its centre by ${aim.cover} (${aim.covering})`,
      );
    }
    const pointer = {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', origin: 'viewport', x: Math.round(aim.x), y: Math.round(aim.y) },
        { type: 'pointerDown', button },
        { type: 'pointerUp', button },
      ],
    };
    if (!modifier) {
      await this.actions([pointer]);
    } else {
      // Sources dispatch in order within a tick, so the modifier is released a
      // tick after pointerUp; otherwise the click fires with it already up.
      const keys = {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: modifier },
          { type: 'pause' },
          { type: 'pause' },
          { type: 'pause' },
          { type: 'keyUp', value: modifier },
        ],
      };
      pointer.actions.unshift({ type: 'pause' });
      await this.actions([keys, pointer]);
    }
    await this.release();
  }

  /** A primary click at viewport coordinates, on whatever is there. */
  async clickPoint(x, y) {
    await this.actions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: 'viewport', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await this.release();
  }

  async drag(from, to, steps = 5) {
    const moves = [];
    for (let step = 1; step <= steps; step += 1) {
      moves.push({
        type: 'pointerMove',
        origin: 'viewport',
        duration: 20,
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps),
      });
    }
    await this.actions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: 'viewport', x: Math.round(from.x), y: Math.round(from.y) },
          { type: 'pointerDown', button: 0 },
          ...moves,
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await this.release();
  }

  windowRect(rect) {
    return rect === undefined
      ? this.call('GET', '/window/rect')
      : this.call('POST', '/window/rect', rect);
  }

  screenshot() {
    return this.call('GET', '/screenshot');
  }

  refresh() {
    return this.call('POST', '/refresh', {});
  }

  title() {
    return this.call('GET', '/title');
  }
}

export class Element {
  constructor(session, ref) {
    this.session = session;
    this.ref = ref;
  }

  call(method, path, body) {
    return this.session.call(method, `/element/${this.ref}${path}`, body);
  }

  click(options) {
    return this.session.click(this, options);
  }

  type(text) {
    return this.call('POST', '/value', { text });
  }

  clear() {
    return this.call('POST', '/clear', {});
  }

  text() {
    return this.call('GET', '/text');
  }

  attribute(name) {
    return this.call('GET', `/attribute/${encodeURIComponent(name)}`);
  }

  property(name) {
    return this.call('GET', `/property/${encodeURIComponent(name)}`);
  }

  rect() {
    return this.call('GET', '/rect');
  }

  focus() {
    return this.session.execute('arguments[0].focus();', this);
  }

  evaluate(body, ...args) {
    return this.session.execute(`const node = arguments[0]; ${body}`, this, ...args);
  }
}
