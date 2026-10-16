// Minimal "obsidian" module for bundling src/main.ts into Node tests.
import { FakeElement } from "./dom.mjs";

export const notices = [];
export const buttons = [];

export class Notice {
  constructor(message) {
    notices.push(message);
  }
}

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return this.app.raw;
  }
  async saveData() {}
  registerInterval() {}
  registerEvent() {}
  addSettingTab() {}
  addCommand() {}
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new FakeElement(globalThis.document);
  }
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
  }
  control(extra = {}) {
    const c = new Proxy(extra, { get: (t, k) => (k in t ? t[k] : () => c) });
    return c;
  }
  addButton(cb) {
    const button = { text: "", click: null };
    buttons.push(button);
    const c = this.control({
      setButtonText: (t) => ((button.text = t), c),
      onClick: (fn) => ((button.click = fn), c),
    });
    cb(c);
    return this;
  }
  addText(cb) {
    cb(this.control({ inputEl: {} }));
    return this;
  }
  addToggle(cb) {
    cb(this.control());
    return this;
  }
  addSlider(cb) {
    cb(this.control());
    return this;
  }
  addDropdown(cb) {
    cb(this.control());
    return this;
  }
  addColorPicker(cb) {
    cb(this.control());
    return this;
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  setDisabled() {
    return this;
  }
}

export class App {}
export class ItemView {}
export class View {}

export async function requestUrl() {
  throw new Error("network is not available in tests");
}
