// Contour scene: iso-line tracing and how the field drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-contour-"));
for (const name of ["contour", "field"]) {
  await esbuild.build({
    entryPoints: [path.join(root, `src/${name}.ts`)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(outDir, `${name}.mjs`),
    logLevel: "error",
  });
}
const { traceContours } = await import(pathToFileURL(path.join(outDir, "contour.mjs")).href);
const { AsciiField } = await import(pathToFileURL(path.join(outDir, "field.mjs")).href);

/** Records segments as [x0, y0, x1, y1]. */
function recorder() {
  const segs = [];
  let at = null;
  return {
    segs,
    moveTo(x, y) {
      at = [x, y];
    },
    lineTo(x, y) {
      segs.push([...at, x, y]);
      at = [x, y];
    },
    quadraticCurveTo(cx, cy, x, y) {
      // Control points sit on the level; curve ends are midpoints of chords, a fraction of a px inside.
      segs.push([...at, cx, cy], [cx, cy, x, y]);
      at = [x, y];
    },
  };
}

function cone(lx, ly, step, cx, cy) {
  const h = new Float32Array(lx * ly);
  for (let j = 0; j < ly; j++) for (let i = 0; i < lx; i++) h[j * lx + i] = 1 - Math.hypot(i * step - cx, j * step - cy) / 100;
  return h;
}

test("a cone traces into rings whose points sit at the level's radius", () => {
  const step = 10;
  const h = cone(41, 41, step, 200, 200);
  const minor = recorder();
  const major = recorder();
  const n = traceContours(h, 41, 41, step, 0, 0.25, { minor, major });
  assert.ok(n > 60);
  // Level v sits at radius 100·(1 − v): every multiple of 25 px.
  for (const [x0, y0, x1, y1] of [...minor.segs, ...major.segs]) {
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      const r = Math.hypot(x - 200, y - 200);
      const nearest = Math.abs(r - Math.round(r / 25) * 25);
      assert.ok(nearest < 1.5, `point at radius ${r.toFixed(2)} is off every level`);
    }
  }
  // Levels whose index is a multiple of 4 (radius 100, 200) are index contours.
  assert.ok(minor.segs.length > 30 && major.segs.length > 30);
});

test("a ring inside the lattice comes out as one closed chain", () => {
  const step = 10;
  const h = cone(21, 21, step, 100, 100);
  let moves = 0;
  let last = null;
  let firstMove = null;
  const sink = {
    moveTo(x, y) {
      moves++;
      firstMove = [x, y];
    },
    lineTo() {},
    quadraticCurveTo(_cx, _cy, x, y) {
      last = [x, y];
    },
  };
  // Only level 0.5 (radius 50) fits inside the 200 px lattice without touching its edge.
  traceContours(h, 21, 21, step, 0.5, 10, { minor: sink, major: sink });
  assert.equal(moves, 1, "the ring must be a single chain, not loose segments");
  assert.ok(Math.hypot(last[0] - firstMove[0], last[1] - firstMove[1]) < 1e-3, "the chain must close on itself");
});

test("a speck a few px across is skipped", () => {
  const sink = { n: 0, moveTo() { this.n++; }, lineTo() {}, quadraticCurveTo() {} };
  // A single raised lattice point: level 0.5 makes a 4-segment diamond around it.
  const h = new Float32Array(25);
  h[12] = 1;
  traceContours(h, 5, 5, 10, 0.5, 10, { minor: sink, major: sink });
  assert.equal(sink.n, 0);
});

test("a flat lattice between levels traces nothing", () => {
  const h = new Float32Array(25).fill(0.33);
  const sink = recorder();
  assert.equal(traceContours(h, 5, 5, 10, 0, 0.25, { minor: sink, major: sink }), 0);
});

const colors = { base: { r: 120, g: 120, b: 120 }, accent: { r: 80, g: 110, b: 230 } };

// A Path2D that only counts, so the field's draw path runs in Node.
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
};

function setup({ reducedMotion = false } = {}) {
  const host = fakeWindow();
  installMainWindow(host);
  const canvas = fakeCanvas(host.document);
  const field = new AsciiField(canvas, colors, "12px monospace", reducedMotion);
  field.resize(800, 600);
  field.setShape("contour");
  return { host, field };
}

function run(host, seconds) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    clock.wall += 1000 / 60;
    host.flush();
  }
}

test("contour mode draws lines at default density", () => {
  const { field } = setup();
  assert.equal(field.blank, false);
  assert.ok(field.heights.length >= Math.ceil(800 / 14) * Math.ceil(600 / 14));
});

test("a click raises a hill that settles back within its lifetime", () => {
  const { host, field } = setup();
  const k = Math.round(300 / 14) * (Math.ceil(800 / 14) + 1) + Math.round(400 / 14);
  field.start();
  run(host, 0.05);
  const before = field.heights[k];
  field.addRipple(400, 300);
  run(host, 0.6);
  assert.ok(field.heights[k] - before > 0.15, "the terrain under the click must rise");
  run(host, 3.2);
  assert.equal(field.ripples.length, 0, "the hill must be gone after 3.4 s");
});

test("the pointer dip eases in, then out after the pointer leaves", () => {
  const { host, field } = setup();
  field.setPointer(400, 300);
  run(host, 1);
  assert.ok(field.dipAmt > 0.95);
  field.clearPointer();
  run(host, 1.5);
  assert.equal(field.dipAmt, 0);
  assert.equal(field.moving, false, "once settled, frames drop back to the idle rate");
});

test("reduced motion: no hills, no dip, still a static frame", () => {
  const { host, field } = setup({ reducedMotion: true });
  field.addRipple(400, 300);
  field.setPointer(400, 300);
  run(host, 0.5);
  assert.equal(field.ripples.length, 0);
  assert.equal(field.dipAmt, 0);
  assert.equal(field.blank, false);
});

test("density 0 hides the contours and releases the frame loop", () => {
  const { host, field } = setup();
  field.start();
  clock.wall += 100;
  field.setTuning({ speed: 1, strength: 1, density: 0, push: 1 });
  run(host, 0.2);
  assert.equal(field.blank, true);
  assert.equal(field.running, false);
});
