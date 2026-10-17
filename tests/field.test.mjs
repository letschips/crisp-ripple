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

// Particle displacement (0.2.0): cells move away from the pointer and the shockwave, then spring home.
function maxOffset(field) {
  let max = 0;
  for (let i = 0; i < field.offX.length; i++) max = Math.max(max, Math.hypot(field.offX[i], field.offY[i]));
  return max;
}

function run(host, seconds) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    clock.wall += 1000 / 60;
    host.flush();
  }
}

test("the pointer pushes nearby cells away and they spring home after it leaves", () => {
  const { host, field } = setup();
  field.setPointer(400, 300);
  run(host, 0.5);
  assert.ok(maxOffset(field) > 6, "cells under the pointer must visibly move");
  const far = Math.floor(580 / 16) * field.cols + 2; // a cell far from the pointer
  assert.equal(field.offX[far], 0);
  field.clearPointer();
  run(host, 3);
  assert.ok(maxOffset(field) < 0.5, "cells must return to their home position");
});

test("a click sends a shockwave that displaces cells along the ring", () => {
  const { host, field } = setup();
  field.addRipple(400, 300);
  run(host, 0.3);
  assert.ok(maxOffset(field) > 4);
  run(host, 4);
  assert.ok(maxOffset(field) < 0.5);
});

test("reduced motion and zero push keep every cell in place", () => {
  const reduced = setup({ reducedMotion: true });
  reduced.field.setPointer(400, 300);
  reduced.field.addRipple(400, 300);
  run(reduced.host, 0.5);
  assert.equal(maxOffset(reduced.field), 0);

  const off = setup();
  off.field.setTuning({ speed: 1, strength: 1, density: 1, push: 0 });
  off.field.setPointer(400, 300);
  off.field.addRipple(400, 300);
  run(off.host, 0.5);
  assert.equal(maxOffset(off.field), 0);
});

test("switching to dots rebuilds the grid with square cells", () => {
  const { field } = setup();
  const glyphCells = field.cols * field.rows;
  field.setShape("dot");
  assert.equal(field.cellW, field.cellH);
  assert.notEqual(field.cols * field.rows, glyphCells);
  assert.equal(field.offX.length, field.cols * field.rows);
});

// 0.2.0 audit: settings changes and disabled push must not break the spring state or the idle cadence.
function allFinite(field) {
  for (let i = 0; i < field.offX.length; i++) {
    if (!Number.isFinite(field.offX[i]) || !Number.isFinite(field.offY[i])) return false;
    if (!Number.isFinite(field.velX[i]) || !Number.isFinite(field.velY[i])) return false;
  }
  return true;
}

test("speeding up mid-ripple never leaves cells with invalid positions", () => {
  const { host, field } = setup();
  field.setTuning({ speed: 0.5, strength: 1, density: 1, push: 1 });
  field.addRipple(400, 300);
  run(host, 1.5);
  clock.wall += 10; // settings changes land between frames
  field.setTuning({ speed: 2, strength: 1, density: 1, push: 1 }); // the ripple is now past its lifetime
  assert.ok(allFinite(field), "the redraw on a settings change must not compute an expired ripple");
  run(host, 4);
  assert.ok(allFinite(field));
  assert.ok(maxOffset(field) < 0.5, "cells must still spring home");
});

test("with push off, a pointer pass does not keep frames at full rate", () => {
  const { host, field } = setup();
  field.setTuning({ speed: 1, strength: 1, density: 1, push: 0 });
  field.setPointer(400, 300);
  field.clearPointer();
  let draws = 0;
  const draw = field.draw.bind(field);
  field.draw = (now) => {
    draws++;
    draw(now);
  };
  run(host, 2);
  assert.ok(draws <= 45, `idle frames should run at ~20 fps, got ${draws} draws in 2 s`);
});
