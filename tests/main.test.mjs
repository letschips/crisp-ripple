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
await esbuild.build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "main.mjs"),
  logLevel: "error",
  // Shared with this file at runtime, so notices and buttons are the same arrays.
  plugins: [{ name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: pathToFileURL(stub).href, external: true })) }],
});
const { default: CrispRipplePlugin } = await import(pathToFileURL(path.join(outDir, "main.mjs")).href);

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

test("clearing the licence says so when data.json could not be written", async () => {
  const { plugin } = await setup();
  Object.defineProperty(plugin, "licensed", { get: () => true });
  plugin.clearLicense = async () => false;
  notices.length = 0;
  buttons.length = 0;
  plugin.settingTab.display();
  const clear = buttons.find((b) => b.text === "清除授权");
  await clear.click();
  assert.ok(!notices.includes("已清除授权信息"), `got: ${notices.join(" | ")}`);
  assert.ok(notices.some((n) => n.includes("重启")), "must warn that the licence comes back after a restart");
});
