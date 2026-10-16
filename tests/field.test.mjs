// AsciiField across windows: clock domains and DPR changes. Each case mirrors a failure seen in the 0.1.1 audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-field-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/field.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "field.mjs"),
  logLevel: "error",
});
const { AsciiField } = await import(pathToFileURL(path.join(outDir, "field.mjs")).href);

const colors = { base: { r: 120, g: 120, b: 120 }, accent: { r: 80, g: 110, b: 230 } };

function setup({ popout = false, reducedMotion = false } = {}) {
  const main = fakeWindow();
  installMainWindow(main);
  clock.wall += 2500; // the pop-out opens later, so its performance.now() runs 2.5 s behind
  const host = popout ? fakeWindow() : main;
  const canvas = fakeCanvas(host.document);
  const field = new AsciiField(canvas, colors, "12px monospace", reducedMotion);
  field.resize(800, 600);
  return { main, host, canvas, field };
}

test("a ripple in a pop-out window shows at once and fades on time", () => {
  const { host, field } = setup({ popout: true });
  field.addRipple(200, 200);
  clock.wall += 500;
  host.flush();
  assert.ok(field.rippleAt(200, 200, 0, field.lastDraw) > 0, "the ring must be visible 0.5 s after the click");
  clock.wall += 2300; // 2.8 s in, past the 2.2 s lifetime
  host.flush();
  assert.equal(field.ripples.length, 0);
});

test("with reduced motion on, a DPR change still rebuilds the canvas", () => {
  const { host, canvas, field } = setup({ reducedMotion: true });
  assert.equal(canvas.width, 800);
  host.setMedia({ devicePixelRatio: 2 });
  assert.equal(canvas.width, 1600);
  host.setMedia({ devicePixelRatio: 1 });
  assert.equal(canvas.width, 800, "the watch must follow the new ratio, not just the first one");
  field.destroy();
  host.setMedia({ devicePixelRatio: 2 });
  assert.equal(canvas.width, 800, "a destroyed field must stop listening");
});
