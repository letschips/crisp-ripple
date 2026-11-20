// Firefly scene: swarm behaviour and how the field drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-firefly-"));
for (const name of ["firefly", "field"]) {
  await esbuild.build({
    entryPoints: [path.join(root, `src/${name}.ts`)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(outDir, `${name}.mjs`),
    logLevel: "error",
  });
}
const { Swarm, fireflyCount, MAX_FIREFLIES } = await import(pathToFileURL(path.join(outDir, "firefly.mjs")).href);
const { AsciiField } = await import(pathToFileURL(path.join(outDir, "field.mjs")).href);

/** Deterministic random so behaviour tests do not flake. */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tuning = { speed: 1, push: 1 };

function fly(swarm, seconds, pointer = null, t = tuning) {
  let busy = false;
  for (let s = 0; s < seconds; s += 1 / 30) busy = swarm.step(1 / 30, pointer, t);
  return busy;
}

/** Kuramoto order parameter: 1 when every firefly blinks in step, near 0 when scattered. */
function order(swarm) {
  let c = 0;
  let s = 0;
  for (let i = 0; i < swarm.count; i++) {
    c += Math.cos(swarm.phase[i] * Math.PI * 2);
    s += Math.sin(swarm.phase[i] * Math.PI * 2);
  }
  return Math.hypot(c, s) / swarm.count;
}

test("the count follows area and density, with a ceiling", () => {
  assert.equal(fireflyCount(1440, 900, 0), 0);
  assert.equal(fireflyCount(1440, 900, 1), 144);
  assert.equal(fireflyCount(1440, 900, 2), 288);
  assert.equal(fireflyCount(3840, 2160, 2), MAX_FIREFLIES);
});

test("the swarm stays on screen and never goes NaN", () => {
  const swarm = new Swarm(seeded(3));
  swarm.resize(800, 600, 60);
  fly(swarm, 40);
  for (let i = 0; i < swarm.count; i++) {
    assert.ok(Number.isFinite(swarm.x[i]) && Number.isFinite(swarm.y[i]));
    assert.ok(swarm.x[i] >= -30 && swarm.x[i] <= 830 && swarm.y[i] >= -30 && swarm.y[i] <= 630);
  }
});

test("neighbours fall into blinking together", () => {
  // A small window keeps everyone within sight of each other.
  const swarm = new Swarm(seeded(7));
  swarm.resize(140, 140, 20);
  const before = order(swarm);
  fly(swarm, 30);
  assert.ok(before < 0.5, `start should be unsynchronised, got ${before.toFixed(2)}`);
  assert.ok(order(swarm) > 0.85, `after 30 s the group should flash together, got ${order(swarm).toFixed(2)}`);
});

test("a click lights up and scatters nearby fireflies, which settle back to cruising", () => {
  const swarm = new Swarm(seeded(5));
  swarm.resize(800, 600, 80);
  fly(swarm, 2);
  swarm.scatter(400, 300, 1);
  const near = [];
  for (let i = 0; i < swarm.count; i++) if (Math.hypot(swarm.x[i] - 400, swarm.y[i] - 300) < 120) near.push(i);
  assert.ok(near.length > 0);
  for (const i of near) {
    assert.ok(swarm.brightness(i) > 0.5, "fireflies near the click must flash");
    assert.ok(Math.hypot(swarm.vx[i], swarm.vy[i]) > 60, "and dart away");
  }
  assert.equal(fly(swarm, 0.2), true, "a scatter keeps frames at full rate");
  assert.equal(fly(swarm, 4), false, "after a few seconds the swarm is calm again");
  for (let i = 0; i < swarm.count; i++) assert.ok(Math.hypot(swarm.vx[i], swarm.vy[i]) <= 34 * 1.5 + 1);
});

test("push 0: a click still flashes but moves nobody", () => {
  const swarm = new Swarm(seeded(9));
  swarm.resize(800, 600, 80);
  const vx = Float32Array.from(swarm.vx);
  swarm.scatter(400, 300, 0);
  assert.deepEqual(Float32Array.from(swarm.vx), vx);
  assert.ok(swarm.flash.some((f) => f > 0.5));
});

test("fireflies keep clear of a resting pointer", () => {
  const swarm = new Swarm(seeded(11));
  swarm.resize(600, 600, 160);
  const p = { x: 300, y: 300 };
  const inside = () => {
    let n = 0;
    for (let i = 0; i < swarm.count; i++) if (Math.hypot(swarm.x[i] - p.x, swarm.y[i] - p.y) < 50) n++;
    return n;
  };
  fly(swarm, 6, p);
  let total = 0;
  for (let k = 0; k < 30; k++) {
    fly(swarm, 0.2, p);
    total += inside();
  }
  // 160 fireflies over 600² px put ~3.5 inside a 50 px circle on average; the pointer keeps it nearly empty.
  assert.ok(total / 30 < 1, `average ${(total / 30).toFixed(2)} fireflies stayed under the pointer`);
});

const colors = { base: { r: 120, g: 120, b: 120 }, accent: { r: 80, g: 110, b: 230 } };

function setup({ reducedMotion = false } = {}) {
  const host = fakeWindow();
  installMainWindow(host);
  const canvas = fakeCanvas(host.document);
  const field = new AsciiField(canvas, colors, "12px monospace", reducedMotion);
  field.resize(800, 600);
  field.setShape("firefly");
  return { host, field };
}

function run(host, seconds) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    clock.wall += 1000 / 60;
    host.flush();
  }
}

test("firefly mode fills the field and a density change re-counts the swarm", () => {
  const { field } = setup();
  assert.equal(field.swarm.count, fireflyCount(800, 600, 1));
  assert.equal(field.blank, false);
  field.setTuning({ speed: 1, strength: 1, density: 2, push: 1 });
  assert.equal(field.swarm.count, fireflyCount(800, 600, 2));
});

test("a click in the field scatters the swarm once, not on every frame", () => {
  const { host, field } = setup();
  field.start();
  run(host, 0.1);
  field.addRipple(400, 300);
  run(host, 0.05);
  const flashed = Array.from(field.swarm.flash).filter((f) => f > 0.3).length;
  assert.ok(flashed > 0);
  run(host, 1.5);
  assert.ok(Array.from(field.swarm.flash).every((f) => f < 0.3), "the flash must fade, not be re-triggered");
});

test("reduced motion: the swarm holds still and clicks do nothing", () => {
  const { host, field } = setup({ reducedMotion: true });
  const x = Float32Array.from(field.swarm.x);
  field.addRipple(400, 300);
  field.setPointer(400, 300);
  run(host, 1);
  assert.deepEqual(Float32Array.from(field.swarm.x), x);
  assert.equal(field.blank, false);
});

test("density 0 empties the swarm and releases the frame loop", () => {
  const { host, field } = setup();
  field.start();
  field.setTuning({ speed: 1, strength: 1, density: 0, push: 1 });
  run(host, 0.2);
  assert.equal(field.swarm.count, 0);
  assert.equal(field.running, false);
});
