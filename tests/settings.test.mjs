// Activation gate and data.json normalisation. Runs the real src/settings.ts in Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-settings-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/settings.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "settings.mjs"),
  logLevel: "error",
});
const { normalizeSettings, effectiveVisuals, soundEnabled, DEFAULT_VISUALS, DEFAULT_SETTINGS } = await import(
  pathToFileURL(path.join(outDir, "settings.mjs")).href
);

const customised = normalizeSettings({
  sound: true, colorMode: "custom", customColor: "#e0457b", speed: 60, strength: 150, density: 0,
});

test("unlicensed users always see the default appearance, whatever is saved", () => {
  assert.deepEqual(effectiveVisuals(customised, false), DEFAULT_VISUALS);
});

test("licensed users see their saved appearance", () => {
  const v = effectiveVisuals(customised, true);
  assert.equal(v.colorMode, "custom");
  assert.equal(v.customColor, "#e0457b");
  assert.equal(v.density, 0, "0% background must survive, it is a valid choice");
});

test("sound needs both the licence and the toggle", () => {
  assert.equal(soundEnabled({ sound: true }, false), false);
  assert.equal(soundEnabled({ sound: false }, true), false);
  assert.equal(soundEnabled({ sound: true }, true), true);
});

test("missing or unreadable data.json falls back to defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("garbage"), DEFAULT_SETTINGS);
});

test("settings saved by the pre-licence prototype keep their values", () => {
  const s = normalizeSettings({ sound: false, volume: 40 });
  assert.equal(s.sound, false);
  assert.equal(s.volume, 40);
  assert.equal(s.licenseCode, "");
  assert.equal(s.colorMode, "blue");
});

test("out-of-range and malformed values are clamped or reset", () => {
  const s = normalizeSettings({
    volume: 900, speed: -5, strength: "120", density: Number.NaN,
    colorMode: "rainbow", customColor: "red", licenseCode: "  abc.def  ",
  });
  assert.equal(s.volume, 100);
  assert.equal(s.speed, 50);
  assert.equal(s.strength, 100, "strings are not numbers");
  assert.equal(s.density, 100);
  assert.equal(s.colorMode, "blue");
  assert.equal(s.customColor, "#5b7cfa");
  assert.equal(s.licenseCode, "abc.def");
});

test("shape and push are licensed appearance settings with safe fallbacks", () => {
  const s = normalizeSettings({ shape: "dot", push: 0 });
  assert.equal(s.shape, "dot");
  assert.equal(s.push, 0, "0% push turns displacement off and must survive");
  assert.deepEqual(effectiveVisuals(s, false), DEFAULT_VISUALS);
  assert.equal(effectiveVisuals(s, true).shape, "dot");
  const bad = normalizeSettings({ shape: "star", push: 500 });
  assert.equal(bad.shape, "glyph");
  assert.equal(bad.push, 200);
});

test("the background switch is on by default and stays off once saved, licence or not", () => {
  assert.equal(DEFAULT_SETTINGS.background, true);
  assert.equal(normalizeSettings({}).background, true);
  assert.equal(normalizeSettings({ background: "no" }).background, true);
  assert.equal(normalizeSettings({ background: false }).background, false);
});
