// Sand garden scene: stones, rings and furrows, and how the field drives them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-zen-"));
for (const name of ["zen", "field"]) {
  await esbuild.build({
    entryPoints: [path.join(root, `src/${name}.ts`)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(outDir, `${name}.mjs`),
    logLevel: "error",
  });
}
const { Garden, MAX_STONES, RINGS, rakeGap } = await import(pathToFileURL(path.join(outDir, "zen.mjs")).href);
const { AsciiField } = await import(pathToFileURL(path.join(outDir, "field.mjs")).href);

const half = () => 0.5;

function settle(garden, seconds, pointer = null) {
  let busy = false;
  for (let t = 0; t < seconds; t += 1 / 30) busy = garden.step(1 / 30, pointer, 1, 1);
  return busy;
}

test("a click sets a stone down; its rings spread, then the garden goes still", () => {
  const g = new Garden(half);
  g.resize(800, 600);
  assert.equal(g.click(400, 300), "placed");
  assert.equal(g.stones.length, 1);
  assert.equal(settle(g, 0.3), true, "rings are still spreading");
  settle(g, 1.5);
  assert.equal(g.stones[0].grow, 1);
  assert.equal(g.step(1 / 30, null, 1, 1), false, "a settled garden has nothing to animate");
});

test("clicking a stone lifts it out", () => {
  const g = new Garden(half);
  g.resize(800, 600);
  g.click(400, 300);
  settle(g, 2);
  assert.equal(g.click(405, 302), "removed");
  settle(g, 2);
  assert.equal(g.stones.length, 0);
});

test("past the limit the oldest stone is lifted out", () => {
  const g = new Garden(half);
  g.resize(2000, 600);
  for (let i = 0; i <= MAX_STONES; i++) g.click(100 + i * 200, 300);
  settle(g, 2);
  assert.equal(g.stones.length, MAX_STONES);
  assert.equal(g.stones[0].x, 300, "the first stone went first");
});

test("the ring field is the distance to the nearest stone edge, clamped to the ring band", () => {
  const g = new Garden(half); // radius 15 + 0.5·14 = 22
  g.resize(800, 600);
  g.click(100, 100);
  settle(g, 2);
  const gap = rakeGap(1);
  const out = new Float32Array(3);
  g.ringField(100, 100, 3, 1, 50, gap, out); // x = 100, 150, 200
  assert.equal(out[0], 0, "inside the stone");
  assert.ok(Math.abs(out[1] - (50 - 22)) < 1e-4);
  assert.equal(out[2], RINGS * gap, "beyond the band the field is flat, so no rings");
});

test("rings of two nearby stones merge instead of crossing", () => {
  const g = new Garden(half);
  g.resize(800, 600);
  g.click(300, 300);
  g.click(360, 300);
  settle(g, 2);
  const out = new Float32Array(1);
  // Halfway between the stones the field takes the nearer stone's distance, never the sum.
  g.ringField(330, 300, 1, 1, 1, rakeGap(1), out);
  assert.ok(Math.abs(out[0] - (30 - 22)) < 1e-4);
});

test("the pointer leaves a furrow that slowly fills back in", () => {
  const g = new Garden(half);
  g.resize(800, 600);
  g.step(1 / 30, { x: 100, y: 300 }, 1, 1);
  g.step(1 / 30, { x: 500, y: 300 }, 1, 1);
  const cell = (x, y) => g.erase[Math.round(y / 8) * g.ex + Math.round(x / 8)];
  assert.ok(cell(300, 300) > 0.8, "the whole path between samples is furrowed");
  assert.equal(cell(300, 400), 0, "away from the path the sand is untouched");
  settle(g, 60);
  assert.ok(cell(300, 300) < 0.45 && cell(300, 300) > 0.2, "after a minute it is about a third as deep");
  settle(g, 300);
  assert.equal(g.eraseActive, false);
});

test("push 0: the pointer leaves no furrow", () => {
  const g = new Garden(half);
  g.resize(800, 600);
  g.step(1 / 30, { x: 100, y: 300 }, 0, 1);
  g.step(1 / 30, { x: 500, y: 300 }, 0, 1);
  assert.equal(g.eraseActive, false);
});

const colors = { base: { r: 120, g: 120, b: 120 }, accent: { r: 80, g: 110, b: 230 } };
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
};

function setup({ reducedMotion = false } = {}) {
  const host = fakeWindow();
  installMainWindow(host);
  const canvas = fakeCanvas(host.document);
  const field = new AsciiField(canvas, colors, "12px monospace", reducedMotion);
  field.resize(800, 600);
  field.setShape("zen");
  return { host, field };
}

function run(host, seconds) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    clock.wall += 1000 / 60;
    host.flush();
  }
}

test("a settled garden releases the frame loop; a click starts it again and sets one stone", () => {
  const { host, field } = setup();
  field.start();
  run(host, 0.2);
  assert.equal(field.running, false, "nothing drifts, so nothing redraws");
  field.addRipple(400, 300);
  assert.equal(field.running, true);
  run(host, 3);
  assert.equal(field.garden.stones.length, 1, "one click, one stone, however many frames ran");
  assert.equal(field.running, false);
});

test("two clicks in the same millisecond set two stones", () => {
  const { host, field } = setup();
  field.addRipple(200, 300);
  field.addRipple(500, 300); // the fake clock has not moved, so both share a timestamp
  run(host, 0.1);
  assert.equal(field.garden.stones.length, 2);
});

test("reduced motion: raked lines only, clicks and the pointer leave no mark", () => {
  const { host, field } = setup({ reducedMotion: true });
  field.addRipple(400, 300);
  field.setPointer(400, 300);
  run(host, 0.5);
  assert.equal(field.garden.stones.length, 0);
  assert.equal(field.garden.eraseActive, false);
  assert.equal(field.blank, false);
});

test("density 0 hides the garden", () => {
  const { field } = setup();
  field.setTuning({ speed: 1, strength: 1, density: 0, push: 1 });
  assert.equal(field.blank, true);
});
