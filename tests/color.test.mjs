// Theme colour resolution. The fake context mimics Chromium: an invalid fillStyle assignment is ignored
// and keeps the previous value; color()/oklch() keep their own serialisation and are resolved by painting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-color-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/color.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "color.mjs"),
  logLevel: "error",
});
const { parseColor } = await import(pathToFileURL(path.join(outDir, "color.mjs")).href);

// What Chromium serialises each accepted input to, and the pixel it paints.
const ACCEPTED = {
  "#000": { serial: "#000000", pixel: [0, 0, 0, 255] },
  "#000000": { serial: "#000000", pixel: [0, 0, 0, 255] },
  "#fff": { serial: "#ffffff", pixel: [255, 255, 255, 255] },
  "#ffffff": { serial: "#ffffff", pixel: [255, 255, 255, 255] },
  "#62afef": { serial: "#62afef", pixel: [98, 175, 239, 255] },
  "black": { serial: "#000000", pixel: [0, 0, 0, 255] },
  "rgb(10, 20, 30)": { serial: "#0a141e", pixel: [10, 20, 30, 255] },
  "rgba(10, 20, 30, 0.5)": { serial: "rgba(10, 20, 30, 0.5)", pixel: [10, 20, 30, 128] },
  "oklch(62.8% 0.2577 29.23)": { serial: "oklch(0.628 0.2577 29.23)", pixel: [255, 0, 0, 255] },
  "oklch(0.628 0.2577 29.23)": { serial: "oklch(0.628 0.2577 29.23)", pixel: [255, 0, 0, 255] },
  "transparent": { serial: "rgba(0, 0, 0, 0)", pixel: [0, 0, 0, 0] },
};

function chromiumLikeContext() {
  let style = "#000000";
  let painted = [0, 0, 0, 0];
  return {
    canvas: { width: 300, height: 150 },
    get fillStyle() {
      return style;
    },
    set fillStyle(value) {
      const hit = ACCEPTED[String(value)] ?? Object.values(ACCEPTED).find((c) => c.serial === value);
      if (hit) style = hit.serial; // invalid values are ignored, like a real canvas
    },
    fillRect() {
      painted = Object.values(ACCEPTED).find((c) => c.serial === style).pixel;
    },
    getImageData: () => ({ data: painted }),
  };
}

const FALLBACK = { r: 80, g: 110, b: 230 };
const parse = (value) => parseColor(value, FALLBACK, chromiumLikeContext);

test("an invalid theme value falls back instead of turning black", () => {
  assert.deepEqual(parse("not-a-color"), FALLBACK);
  assert.deepEqual(parse("var(--missing)"), FALLBACK);
});

test("real black is still black", () => {
  assert.deepEqual(parse("#000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parse("black"), { r: 0, g: 0, b: 0 });
});

test("hex, rgb and modern colour syntax resolve to RGB", () => {
  assert.deepEqual(parse("#62afef"), { r: 98, g: 175, b: 239 });
  assert.deepEqual(parse("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parse("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parse("oklch(62.8% 0.2577 29.23)"), { r: 255, g: 0, b: 0 });
});

test("empty and fully transparent values fall back", () => {
  assert.deepEqual(parse(""), FALLBACK);
  assert.deepEqual(parse("   "), FALLBACK);
  assert.deepEqual(parse("transparent"), FALLBACK);
});
