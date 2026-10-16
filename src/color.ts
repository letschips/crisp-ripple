import type { Rgb } from "./field";

type ColorContext = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "getImageData"> & {
  canvas: { width: number; height: number };
};

function defaultContext(): ColorContext | null {
  return document.createElement("canvas").getContext("2d");
}

/** Resolves any CSS colour the browser accepts to RGB; anything else yields `fallback`. */
export function parseColor(value: string, fallback: Rgb, context: () => ColorContext | null = defaultContext): Rgb {
  const probe = context();
  if (!probe || !value.trim()) return fallback;
  // A canvas ignores an invalid fillStyle and keeps the previous one. Assigning after two different
  // sentinels tells "the value is black" apart from "the value was rejected".
  probe.fillStyle = "#000000";
  probe.fillStyle = value.trim();
  const normalized = String(probe.fillStyle);
  probe.fillStyle = "#ffffff";
  probe.fillStyle = value.trim();
  if (String(probe.fillStyle) !== normalized) return fallback;
  const hex = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(normalized);
  if (rgb) return rgb[4] !== undefined && +rgb[4] === 0 ? fallback : { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  // color(), oklch() and color-mix() keep their own serialisation; paint one pixel to resolve them.
  probe.canvas.width = probe.canvas.height = 1;
  probe.fillStyle = normalized;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return a > 0 ? { r, g, b } : fallback;
}
