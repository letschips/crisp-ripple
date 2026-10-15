// Settings shape, defaults and the activation gate. Kept free of Obsidian imports so it can be
// tested in Node.

export type ColorMode = "blue" | "accent" | "custom";

export interface VisualSettings {
  colorMode: ColorMode;
  customColor: string;
  /** percentages; 100 = tuned default */
  speed: number;
  strength: number;
  density: number;
}

export interface RippleSettings extends VisualSettings {
  sound: boolean;
  /** 10–100, percentage of the default drop level */
  volume: number;
  licenseCode: string;
}

export const DEFAULT_VISUALS: VisualSettings = {
  colorMode: "blue",
  customColor: "#5b7cfa",
  speed: 100,
  strength: 100,
  density: 100,
};

export const DEFAULT_SETTINGS: RippleSettings = {
  sound: true,
  volume: 100,
  licenseCode: "",
  ...DEFAULT_VISUALS,
};

export const RANGES = {
  volume: [10, 100],
  speed: [50, 200],
  strength: [30, 150],
  density: [0, 200],
} as const;

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Turns whatever data.json held into a complete, in-range settings object. */
export function normalizeSettings(raw: unknown): RippleSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const colorMode: ColorMode =
    r.colorMode === "accent" || r.colorMode === "custom" || r.colorMode === "blue"
      ? r.colorMode
      : DEFAULT_SETTINGS.colorMode;
  const customColor =
    typeof r.customColor === "string" && /^#[0-9a-f]{6}$/i.test(r.customColor)
      ? r.customColor
      : DEFAULT_SETTINGS.customColor;
  return {
    sound: typeof r.sound === "boolean" ? r.sound : DEFAULT_SETTINGS.sound,
    volume: clampNumber(r.volume, RANGES.volume, DEFAULT_SETTINGS.volume),
    licenseCode: typeof r.licenseCode === "string" ? r.licenseCode.trim() : "",
    colorMode,
    customColor,
    speed: clampNumber(r.speed, RANGES.speed, DEFAULT_SETTINGS.speed),
    strength: clampNumber(r.strength, RANGES.strength, DEFAULT_SETTINGS.strength),
    density: clampNumber(r.density, RANGES.density, DEFAULT_SETTINGS.density),
  };
}

/** Appearance actually rendered: customisation is a licensed feature, so unlicensed users get defaults. */
export function effectiveVisuals(settings: VisualSettings, licensed: boolean): VisualSettings {
  if (!licensed) return { ...DEFAULT_VISUALS };
  return {
    colorMode: settings.colorMode,
    customColor: settings.customColor,
    speed: settings.speed,
    strength: settings.strength,
    density: settings.density,
  };
}

/** The water-drop sound is a licensed feature and also respects the user's toggle. */
export function soundEnabled(settings: Pick<RippleSettings, "sound">, licensed: boolean): boolean {
  return licensed && settings.sound;
}
