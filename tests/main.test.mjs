// Plugin wiring that the field alone cannot cover: tabs moving between windows and the settings tab.
// Each case mirrors a failure seen in the 0.1.1 audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { FakeElement, fakeWindow, installMainWindow } from "./fakes/dom.mjs";
import { buttons, notices } from "./fakes/obsidian.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(root, "tests/fakes/obsidian.mjs");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-main-"));
// Test-only entry: the production bundle never exposes the gate.
await esbuild.build({
  stdin: {
    contents: [
      `export { default } from ${JSON.stringify(path.join(root, "src/main.ts"))};`,
      `export { applyEntitlement } from ${JSON.stringify(path.join(root, "src/entitlement.ts"))};`,
    ].join("\n"),
    resolveDir: root, loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "main.mjs"),
  logLevel: "error",
  // Shared with this file at runtime, so notices and buttons are the same arrays.
  plugins: [{ name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: pathToFileURL(stub).href, external: true })) }],
});
const { default: CrispRipplePlugin, applyEntitlement } = await import(pathToFileURL(path.join(outDir, "main.mjs")).href);

async function setup() {
  const main = fakeWindow();
  installMainWindow(main);
  const host = new FakeElement(main.document);
  const view = { contentEl: host };
  const app = {
    raw: {},
    vault: { adapter: { exists: async () => true, read: async () => "{}", write: async () => {} } },
    workspace: { onLayoutReady() {}, on() {}, getLeavesOfType: () => [{ view }] },
  };
  const plugin = new CrispRipplePlugin(app, { dir: ".obsidian/plugins/crisp-ripple", version: "test" });
  await plugin.onload();
  return { main, host, plugin };
}

test("an empty tab moved into a pop-out follows that window's reduced-motion setting", async () => {
  const { host, plugin } = await setup();
  plugin.sync();
  const popout = fakeWindow();
  host.ownerDocument = popout.document; // Obsidian moves the existing leaf and view, it does not recreate them
  plugin.sync();
  const [ripple] = plugin.ripples.values();
  assert.equal(ripple.field.frameWindow, popout, "animation frames must come from the pop-out");
  popout.setMedia({ reducedMotion: true });
  assert.equal(ripple.field.reducedMotion, true);
  assert.equal(ripple.field.running, false);
});

test("an empty tab in a pop-out takes that window's theme variables", async () => {
  const { host, plugin } = await setup();
  plugin.sync();
  const popout = fakeWindow();
  popout.styles["--font-monospace"] = "PopoutMono";
  host.ownerDocument = popout.document;
  plugin.sync();
  const [ripple] = plugin.ripples.values();
  assert.equal(ripple.field.font, "12px PopoutMono");
});

test("clearing the licence says so when data.json could not be written", async () => {
  const { plugin } = await setup();
  applyEntitlement(plugin, plugin.licenseController, { valid: true });
  plugin.clearLicense = async () => false;
  notices.length = 0;
  buttons.length = 0;
  plugin.settingTab.display();
  const clear = buttons.find((b) => b.text === "清除授权");
  await clear.click();
  assert.ok(!notices.includes("已清除授权信息"), `got: ${notices.join(" | ")}`);
  assert.ok(notices.some((n) => n.includes("重启")), "must warn that the licence comes back after a restart");
});

test("an own licensed property on the plugin does not unlock the appearance settings", async () => {
  const { plugin } = await setup();
  Object.defineProperty(plugin, "licensed", { get: () => true });
  buttons.length = 0;
  plugin.settingTab.display();
  assert.equal(buttons.find((b) => b.text === "清除授权"), undefined);
});

test("a layout-ready callback that runs after unload creates no canvas", async () => {
  const main = fakeWindow();
  installMainWindow(main);
  const host = new FakeElement(main.document);
  const view = { contentEl: host };
  const ready = [];
  const app = {
    raw: {},
    vault: { adapter: { exists: async () => true, read: async () => "{}", write: async () => {} } },
    workspace: { onLayoutReady: (cb) => ready.push(cb), on() {}, getLeavesOfType: () => [{ view }] },
  };
  const plugin = new CrispRipplePlugin(app, { dir: ".obsidian/plugins/crisp-ripple", version: "test" });
  await plugin.onload();
  plugin.onunload();
  for (const cb of ready) cb();
  assert.equal(plugin.ripples.size, 0);
  assert.equal(host.children.filter((c) => c.tag === "canvas").length, 0);
});

test("rapid setting changes coalesce into few writes and the last value is saved", async () => {
  const { plugin } = await setup();
  let stored = "{}";
  let writes = 0;
  plugin.saveData = async (data) => {
    writes++;
    stored = JSON.stringify(data);
  };
  plugin.app.vault.adapter.read = async () => stored;
  const results = [];
  for (let i = 0; i < 20; i++) {
    plugin.options.speed = 50 + i * 5; // a slider being dragged
    results.push(plugin.saveSettings());
  }
  assert.deepEqual(await Promise.all(results), Array(20).fill(true));
  assert.ok(writes <= 2, `expected the pending saves to merge, got ${writes} writes`);
  assert.equal(JSON.parse(stored).speed, 145);
});

test("a click on one of the empty tab's own buttons sends no ripple", async () => {
  const { host, plugin } = await setup();
  plugin.sync();
  const ripple = [...plugin.ripples.values()][0];
  const down = host.listeners.get("pointerdown");
  const action = { closest: (selector) => (selector.includes(".empty-state-action") ? {} : null) };
  down({ button: 0, clientX: 400, clientY: 300, target: action });
  assert.equal(ripple.field.ripples.length, 0, "the button opens something else; the ring would never be seen");
  down({ button: 0, clientX: 400, clientY: 300, target: { closest: () => null } });
  assert.equal(ripple.field.ripples.length, 1, "a click on the background still ripples");
});

test("an empty tab whose canvas has no 2D context leaves no trace and does not block the others", async () => {
  const main = fakeWindow();
  installMainWindow(main);
  const broken = new FakeElement(main.document);
  const createEl = broken.createEl.bind(broken);
  broken.createEl = (tag, o) => {
    const el = createEl(tag, o);
    if (tag === "canvas") el.getContext = () => null;
    return el;
  };
  const healthy = new FakeElement(main.document);
  const views = [{ contentEl: broken }, { contentEl: healthy }];
  const app = {
    raw: {},
    vault: { adapter: { exists: async () => true, read: async () => "{}", write: async () => {} } },
    workspace: { onLayoutReady() {}, on() {}, getLeavesOfType: () => views.map((view) => ({ view })) },
  };
  const plugin = new CrispRipplePlugin(app, { dir: ".obsidian/plugins/crisp-ripple", version: "test" });
  await plugin.onload();
  plugin.sync();
  assert.equal(plugin.ripples.size, 1, "the healthy tab still gets its canvas");
  assert.equal(broken.classes.size, 0, "the broken tab keeps Obsidian's own classes only");
  assert.ok(broken.children.every((c) => c.tag !== "canvas" || !c.isConnected), "its canvas is removed again");
  assert.equal(broken.listeners.size, 0);
});

test("turning the background off removes every canvas, and turning it on brings them back", async () => {
  const { host, plugin } = await setup();
  plugin.sync();
  assert.equal(plugin.ripples.size, 1);
  plugin.options.background = false;
  plugin.sync();
  assert.equal(plugin.ripples.size, 0, "an unlicensed user can still switch the canvas off");
  assert.ok(host.children.every((c) => c.tag !== "canvas" || !c.isConnected));
  assert.equal(host.classes.size, 0);
  plugin.options.background = true;
  plugin.sync();
  assert.equal(plugin.ripples.size, 1);
});

// 0.6.2 audit: the licence box and background redraws.
test("an empty licence box asks for a code instead of resending the saved one", async () => {
  const { plugin } = await setup();
  plugin.options.licenseCode = "old.revoked";
  let sent = null;
  plugin.activate = async (code) => { sent = code; return { result: { valid: false }, applied: true, saved: true }; };
  notices.length = 0;
  buttons.length = 0;
  plugin.settingTab.display();
  await buttons.find((b) => b.text === "激活").click();
  assert.equal(sent, null);
  assert.ok(notices.includes("请先输入授权码"), `got: ${notices.join(" | ")}`);
});

test("a background change leaves a closed settings tab alone and waits for the user to leave a focused field", async () => {
  const { plugin } = await setup();
  const tab = plugin.settingTab;
  let builds = 0;
  const display = tab.display.bind(tab);
  tab.display = () => { builds++; display(); };
  tab.containerEl.isConnected = false;
  tab.refreshIfOpen();
  assert.equal(builds, 0, "a closed tab is rebuilt when it opens");

  let onBlur = null;
  const input = { matches: () => true, addEventListener: (type, fn) => { if (type === "focusout") onBlur = fn; } };
  tab.containerEl.isConnected = true;
  tab.containerEl.contains = (el) => el === input;
  tab.containerEl.ownerDocument = { activeElement: input };
  tab.refreshIfOpen();
  tab.refreshIfOpen();
  assert.equal(builds, 0, "rebuilding now would throw away the focused input");
  tab.containerEl.ownerDocument = { activeElement: null };
  onBlur();
  assert.equal(builds, 1);
});
