// Just enough of the DOM to drive AsciiField and EmptyTabRipple across two windows in Node.

/** Shared wall clock; each fake window reports it relative to its own timeOrigin like a real document. */
export const clock = { wall: 1_000_000 };

function fakeContext() {
  return new Proxy(
    { measureText: () => ({ width: 7 }) },
    { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
  );
}

export function fakeCanvas(ownerDocument) {
  return { width: 0, height: 0, ownerDocument, isConnected: true, getContext: () => fakeContext(), remove() {} };
}

class FakeMediaQuery {
  constructor(win, media) {
    this.win = win;
    this.media = media;
    this.listeners = new Set();
  }
  get matches() {
    return this.win.mediaMatches(this.media);
  }
  addEventListener(_type, fn) {
    this.listeners.add(fn);
  }
  removeEventListener(_type, fn) {
    this.listeners.delete(fn);
  }
}

export function fakeWindow({ openedAt = clock.wall, dpr = 1, reducedMotion = false } = {}) {
  const win = {
    devicePixelRatio: dpr,
    reducedMotion,
    performance: { timeOrigin: openedAt, now: () => clock.wall - openedAt },
    frames: new Map(),
    nextFrame: 1,
    queries: [],
    setInterval: () => 0,
    requestAnimationFrame(cb) {
      const id = win.nextFrame++;
      win.frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      win.frames.delete(id);
    },
    matchMedia(media) {
      const q = new FakeMediaQuery(win, media);
      win.queries.push(q);
      return q;
    },
    mediaMatches(media) {
      if (media.includes("prefers-reduced-motion")) return win.reducedMotion;
      const res = /resolution:\s*([\d.]+)dppx/.exec(media);
      if (res) return Number(res[1]) === win.devicePixelRatio;
      return false;
    },
    /** Runs one animation frame with this window's own rAF timestamp. */
    flush() {
      const callbacks = [...win.frames.values()];
      win.frames.clear();
      const ts = win.performance.now();
      for (const cb of callbacks) cb(ts);
    },
    /** Changes a media feature and notifies the queries whose result flipped, like a real window. */
    setMedia(change) {
      const before = win.queries.map((q) => q.matches);
      Object.assign(win, change);
      win.queries.forEach((q, i) => {
        if (q.matches === before[i]) return;
        for (const fn of [...q.listeners]) fn({ matches: q.matches, media: q.media });
      });
    },
  };
  win.document = { defaultView: win };
  return win;
}

/** Installs `win` as the plugin's own (main) window. */
export function installMainWindow(win) {
  globalThis.window = win;
  globalThis.document = {
    defaultView: win,
    body: {},
    createElement: () => fakeCanvas(globalThis.document),
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "performance", { value: win.performance, configurable: true, writable: true });
}

/** Element with the Obsidian DOM helpers that main.ts and the settings tab call. */
export class FakeElement {
  constructor(ownerDocument, tag = "div") {
    this.ownerDocument = ownerDocument;
    this.tag = tag;
    this.children = [];
    this.text = "";
    this.classes = new Set();
    this.listeners = new Map();
    this.isConnected = true;
  }
  addClass(c) {
    this.classes.add(c);
  }
  removeClass(c) {
    this.classes.delete(c);
  }
  setAttr() {}
  empty() {
    this.children = [];
  }
  prepend() {}
  remove() {
    this.isConnected = false;
  }
  createEl(tag, o = {}) {
    const el = new FakeElement(this.ownerDocument, tag);
    if (tag === "canvas") asCanvas(el, this);
    el.text = o.text ?? "";
    this.children.push(el);
    return el;
  }
  createDiv(o) {
    return this.createEl("div", typeof o === "string" ? {} : o);
  }
  createSpan(o) {
    return this.createEl("span", o);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

// The canvas always lives in its host's document, so moving the host moves it too.
function asCanvas(el, host) {
  el.width = 0;
  el.height = 0;
  el.getContext = () => fakeContext();
  Object.defineProperty(el, "ownerDocument", { get: () => host.ownerDocument, configurable: true });
}
