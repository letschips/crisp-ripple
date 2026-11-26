import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { clock, fakeCanvas, fakeWindow, installMainWindow } from "./fakes/dom.mjs";

const outfile = path.join(mkdtempSync(path.join(tmpdir(), "ripple-shark-")), "field.mjs");
await esbuild.build({ entryPoints: ["src/field.ts"], outfile, bundle: true, format: "esm", platform: "node" });
const { AsciiField } = await import(pathToFileURL(outfile));
const colors = { base: { r: 39, g: 42, b: 49 }, paper: { r: 247, g: 246, b: 243 }, accent: { r: 45, g: 110, b: 215 } };
const tuning = { speed: 1, strength: 1, density: 1, push: 1 };

function setup({ reducedMotion = false, width = 1100, height = 730 } = {}) {
  const host = fakeWindow({ reducedMotion });
  installMainWindow(host);
  host.document.createElement = () => fakeCanvas(host.document);
  const field = new AsciiField(fakeCanvas(host.document), colors, "12px monospace", reducedMotion);
  field.setShape("shark");
  field.resize(width, height);
  field.start();
  return { host, field, scene: field.sharkScene };
}

function advance(host, frames = 8) {
  for (let frame = 0; frame < frames; frame++) {
    clock.wall += 1000 / 60;
    host.flush();
  }
}

test("the original shark roster and fish school animate through the field loop", () => {
  const { host, field, scene } = setup();
  assert.deepEqual(scene.world.sharks.map(shark => shark.kind).sort(),
    ["greathammer", "hammerhead", "hammerhead", "thresher", "tiger", "whale", "whale"]);
  assert.ok(scene.world.fish.length > 100);
  const before = Array.from(scene.world.sharks[0].nodes);
  advance(host);
  assert.notDeepEqual(Array.from(scene.world.sharks[0].nodes), before);
  assert.ok(host.frames.size > 0);
  field.destroy();
});

test("clicks reach the original simulation once and push zero disables disturbance", () => {
  const { host, field, scene } = setup();
  let splashes = 0;
  const splash = scene.world.splash.bind(scene.world);
  scene.world.splash = (x, y) => {
    splashes++;
    splash(x, y);
  };
  const fish = scene.world.fish[0];
  field.addRipple(fish.x + 5, fish.y);
  field.setPointer(fish.x + 20, fish.y);
  advance(host);
  assert.equal(splashes, 1);
  assert.ok(fish.alarm > 0);
  assert.equal(scene.world.pointer.active, true);
  field.setTuning({ ...tuning, push: 0 });
  field.addRipple(fish.x + 5, fish.y);
  advance(host);
  assert.equal(splashes, 1);
  assert.equal(scene.world.pointer.active, false);
  field.destroy();
});

test("reduced motion freezes the scene and disables the click", () => {
  const { host, field, scene } = setup({ reducedMotion: true });
  const time = scene.world.time;
  field.addRipple(200, 150);
  advance(host);
  assert.equal(host.frames.size, 0);
  assert.equal(field.ripples.length, 0);
  assert.equal(scene.world.time, time);
  field.destroy();
});

test("density zero releases the frame loop and narrow panes fit the scene", () => {
  const { host, field, scene } = setup();
  field.resize(340, 490);
  assert.ok(scene.world.sharks.length < 7);
  assert.ok(scene.world.sharks.every(shark => shark.length < 160));
  field.setTuning({ ...tuning, density: 0 });
  advance(host);
  assert.equal(scene.world, undefined);
  assert.equal(host.frames.size, 0);
  field.destroy();
});

test("fish keep out of the middle, where the empty tab's buttons sit", () => {
  const { host, field, scene } = setup({ width: 1280, height: 800 });
  const world = scene.world;
  const inside = () => world.fish.filter(f => f.alive && Math.abs(f.x - 640) < 130 && Math.abs(f.y - 400) < 80).length;
  // Start a school right on top of the buttons and let it swim.
  for (const f of world.fish.slice(0, 30)) { f.x = 640 + (Math.random() - 0.5) * 200; f.y = 400 + (Math.random() - 0.5) * 120; }
  advance(host, 60 * 3);
  let total = 0;
  for (let k = 0; k < 20; k++) {
    advance(host, 15);
    total += inside();
  }
  assert.ok(total / 20 < 1, `average ${(total / 20).toFixed(2)} fish over the buttons`);
  field.destroy();
});

test("a resting pointer does not push the scene past 60 fps on a fast display", () => {
  const { host, field, scene } = setup();
  let draws = 0;
  const draw = scene.draw.bind(scene);
  scene.draw = (...args) => { draws++; return draw(...args); };
  field.setPointer(300, 300);
  for (let frame = 0; frame < 160; frame++) {
    clock.wall += 1000 / 160;
    host.flush();
  }
  assert.ok(draws <= 62, `${draws} draws in one second`);
  // 160 Hz frames are 6.25 ms apart, so the cap lands on every third one: ~53 fps.
  assert.ok(draws >= 45, `${draws} draws in one second`);
  field.destroy();
});
