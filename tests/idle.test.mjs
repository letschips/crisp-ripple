// 0.6.1 audit (2026-11-27): frame loops that never idle, and state that leaks between scenes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-idle-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/field.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "field.mjs"),
  logLevel: "error",
});
const { AsciiField } = await import(pathToFileURL(path.join(outDir, "field.mjs")).href);

const colors = { base: { r: 39, g: 42, b: 49 }, paper: { r: 247, g: 246, b: 243 }, accent: { r: 45, g: 110, b: 215 } };
const tuning = { speed: 1, strength: 1, density: 1, push: 1 };

function setup(shape, { reducedMotion = false, density = 1 } = {}) {
  const host = fakeWindow({ reducedMotion });
  installMainWindow(host);
  host.document.createElement = () => fakeCanvas(host.document);
  const field = new AsciiField(fakeCanvas(host.document), colors, "12px monospace", reducedMotion);
  field.setShape(shape);
  field.resize(1100, 730);
  clock.wall += 20;
  field.setTuning({ ...tuning, density });
  field.start();
  return { host, field };
}

/** Runs a 160 Hz display for `seconds` and counts draws. */
function run(host, field, seconds) {
  let draws = 0;
  const draw = field.draw.bind(field);
  field.draw = (...args) => { draws++; return draw(...args); };
  for (let frame = 0; frame < seconds * 160; frame++) {
    clock.wall += 1000 / 160;
    host.flush();
  }
  field.draw = draw;
  return draws;
}

test("fireflies under a resting pointer keep their idle cadence instead of following a 160 Hz display", () => {
  const { host, field } = setup("firefly");
  field.setPointer(300, 300);
  run(host, field, 2); // let the swarm clear the pointer
  const draws = run(host, field, 1);
  assert.ok(draws <= 45, `${draws} draws in one second`);
  field.destroy();
});

for (const shape of ["firefly", "shark", "contour"]) {
  test(`${shape}: background hidden, a resting pointer still releases the frame loop`, () => {
    const { host, field } = setup(shape, { density: 0 });
    field.setPointer(300, 300);
    run(host, field, 2);
    assert.equal(host.frames.size, 0, "no animation frame may stay queued while nothing can show");
    field.destroy();
  });
}

for (const shape of ["firefly", "contour", "zen"]) {
  test(`${shape}: background hidden, a click starts no frame loop`, () => {
    const { host, field } = setup(shape, { density: 0 });
    run(host, field, 1);
    field.addRipple(300, 300);
    run(host, field, 0.2);
    assert.equal(host.frames.size, 0);
    field.destroy();
  });
}

test("zen: a click on a hidden garden sets no stone that would appear later", () => {
  const { host, field } = setup("zen", { density: 0 });
  field.addRipple(300, 300);
  run(host, field, 0.5);
  assert.equal(field.garden.stones.length, 0);
  field.destroy();
});

test("switching scenes drops the old scene's clicks", () => {
  const { host, field } = setup("glyph");
  field.addRipple(300, 300);
  run(host, field, 0.2);
  field.setShape("zen");
  run(host, field, 0.5);
  assert.equal(field.garden.stones.length, 0, "a glyph ripple must not land as a stone");
  field.destroy();
});

test("ASCII sharks, reduced motion: the frozen frame carries no warm-up kills, and redraws add no wake", () => {
  const { field } = setup("shark", { reducedMotion: true });
  const renderer = field.sharkScene.renderer;
  const heat = Math.max(0, ...renderer.heat);
  assert.ok(heat <= 0.01, `warm-up kills left heat ${heat.toFixed(2)}`);
  const bright = () => Array.from(renderer.energy).filter(e => e > 0.45).length;
  const before = bright();
  for (let step = 0; step < 40; step++) field.setTuning({ ...tuning, strength: 0.5 + step / 80 });
  assert.equal(bright(), before);
  field.destroy();
});
