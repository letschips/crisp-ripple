// ASCII field renderer: a fixed character grid whose per-cell opacity is
// driven by a slowly drifting noise field plus expanding click ripples.
// Characters never move; the "push" is purely a brightness wave.

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALPHA_LEVELS = 12;
const TINT_LEVELS = 4;
const BUCKETS = ALPHA_LEVELS * TINT_LEVELS;

const RIPPLE_LIFE = 2.2; // seconds
const RIPPLE_TAU = 0.55; // radius easing time constant
const MAX_RIPPLES = 6;
const IDLE_FRAME_MS = 50; // drift-only frames run at ~20 fps

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface FieldColors {
  base: Rgb;
  accent: Rgb;
}

/** User-adjustable multipliers; 1 = the tuned defaults. */
export interface FieldTuning {
  /** wave expansion and fade speed */
  speed: number;
  /** brightness of the ripple ring */
  strength: number;
  /** density of the idle background characters; 0 hides them */
  density: number;
}

interface Ripple {
  x: number;
  y: number;
  start: number;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function randomGlyph(): number {
  return (Math.random() * GLYPHS.length) | 0;
}

export class AsciiField {
  private ctx: CanvasRenderingContext2D;
  // Pre-rendered glyphs: one column per character, one row per colour/alpha
  // bucket. drawImage from it is several times cheaper than fillText.
  private readonly atlas = document.createElement("canvas");
  private dpr = 1;
  private cols = 0;
  private rows = 0;
  private cellW = 7;
  private cellH = 16;
  private spriteW = 14;
  private spriteH = 32;
  private width = 0;
  private height = 0;
  private glyphs = new Uint8Array(0);
  private ripples: Ripple[] = [];
  private frame = 0;
  private frameWindow: Window = window;
  private lastDraw = 0;
  private running = false;
  private readonly epoch: number;
  private dprQuery: MediaQueryList | null = null;
  private tuning: FieldTuning = { speed: 1, strength: 1, density: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private colors: FieldColors,
    private font: string,
    private reducedMotion: boolean,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.epoch = this.now();
  }

  /** Follows the system setting live: stops motion at once, or resumes it. */
  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return;
    this.reducedMotion = reduced;
    if (reduced) {
      this.ripples = [];
      this.stop();
      if (this.width > 0) this.draw(this.now());
    }
  }

  /** The canvas may live in a pop-out window on a screen with a different scale. */
  private hostWindow(): Window {
    return this.canvas.ownerDocument.defaultView ?? window;
  }

  private windowDpr(): number {
    return this.hostWindow().devicePixelRatio || 1;
  }

  /**
   * Each window's performance.now() counts from its own timeOrigin, and a pop-out opens later
   * than the main window. Absolute milliseconds stay comparable wherever the canvas moves.
   */
  private now(): number {
    const { performance } = this.hostWindow();
    return performance.timeOrigin + performance.now();
  }

  // A DPR change without a size change fires no ResizeObserver, and tick() stops under reduced motion.
  private watchDpr(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = this.hostWindow().matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprQuery.addEventListener("change", this.onDprChange);
  }

  private onDprChange = (): void => {
    if (this.width > 0) this.resize(this.width, this.height);
  };

  setTuning(tuning: FieldTuning): void {
    this.tuning = { ...tuning };
    if (this.width > 0) this.draw(this.now());
  }

  setColors(colors: FieldColors, font: string): void {
    this.colors = colors;
    this.font = font;
    this.resize(this.width, this.height, true);
  }

  resize(width: number, height: number, force = false): void {
    const dpr = this.windowDpr();
    if (!force && width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    if (dpr !== this.dpr || !this.dprQuery) {
      this.dpr = dpr;
      this.watchDpr();
    }
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.font = this.font;
    this.cellW = Math.max(4, this.ctx.measureText("M").width);
    this.cellH = Math.round(this.cellW * 2.1);
    this.buildAtlas();
    const cols = Math.ceil(width / this.cellW);
    const rows = Math.ceil(height / this.cellH);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.glyphs = Uint8Array.from({ length: cols * rows }, randomGlyph);
    }
    this.draw(this.now());
  }

  addRipple(x: number, y: number): void {
    if (this.reducedMotion) return;
    this.ripples.push({ x, y, start: this.now() });
    if (this.ripples.length > MAX_RIPPLES) this.ripples.shift();
    this.start();
  }

  start(): void {
    if (this.running || this.reducedMotion) return;
    this.running = true;
    this.frameWindow = this.hostWindow();
    this.frame = this.frameWindow.requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    this.frameWindow.cancelAnimationFrame(this.frame);
  }

  destroy(): void {
    this.stop();
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = null;
  }

  // The rAF timestamp is in the frame window's own time base, so read the shared clock instead.
  private tick = (): void => {
    if (!this.running) return;
    const now = this.now();
    this.frame = this.frameWindow.requestAnimationFrame(this.tick);
    // Moving a window to a screen with another scale changes DPR without resizing the canvas.
    if (this.windowDpr() !== this.dpr) this.resize(this.width, this.height);
    const life = RIPPLE_LIFE / this.tuning.speed;
    this.ripples = this.ripples.filter((r) => (now - r.start) / 1000 < life);
    if (this.ripples.length === 0 && now - this.lastDraw < IDLE_FRAME_MS) return;
    this.draw(now);
  };

  private buildAtlas(): void {
    const { base, accent } = this.colors;
    this.spriteW = Math.ceil(this.cellW * this.dpr);
    this.spriteH = Math.ceil(this.cellH * this.dpr);
    this.atlas.width = this.spriteW * GLYPHS.length;
    this.atlas.height = this.spriteH * BUCKETS;
    const ctx = this.atlas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.atlas.width, this.atlas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = this.font;
    ctx.textBaseline = "middle";
    for (let tint = 0; tint < TINT_LEVELS; tint++) {
      const k = tint / (TINT_LEVELS - 1);
      const r = Math.round(base.r + (accent.r - base.r) * k);
      const g = Math.round(base.g + (accent.g - base.g) * k);
      const b = Math.round(base.b + (accent.b - base.b) * k);
      for (let a = 0; a < ALPHA_LEVELS; a++) {
        const alpha = ((a + 1) / ALPHA_LEVELS) * 0.75;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        const y = ((tint * ALPHA_LEVELS + a) * this.spriteH) / this.dpr + this.cellH / 2;
        for (let i = 0; i < GLYPHS.length; i++) {
          ctx.fillText(GLYPHS[i], (i * this.spriteW) / this.dpr, y);
        }
      }
    }
  }

  private rippleAt(px: number, py: number, warp: number, now: number): number {
    let sum = 0;
    const { speed } = this.tuning;
    for (const rp of this.ripples) {
      const age = ((now - rp.start) / 1000) * speed;
      const reach = 220 + 0.16 * Math.max(this.width, this.height);
      const radius = reach * (1 - Math.exp(-age / RIPPLE_TAU));
      const fade = Math.pow(1 - age / RIPPLE_LIFE, 1.6);
      const d = Math.hypot(px - rp.x, py - rp.y) + warp * (20 + radius * 0.18);
      const u = radius - d; // distance behind the wavefront
      let v: number;
      if (u < 0) {
        v = Math.exp(-(u * u) / 120);
      } else {
        const front = Math.exp(-(u * u) / 500);
        const inner = Math.max(0, Math.cos(u / 10)) * Math.exp(-u / 80) * 0.6;
        v = Math.max(front, inner);
      }
      sum += v * fade;
    }
    return Math.min(1, sum);
  }

  private draw(now: number): void {
    this.lastDraw = now;
    const { ctx, cols, rows, cellW, cellH, spriteW, spriteH, dpr, atlas } = this;
    const t = (now - this.epoch) / 1000;
    const drift = this.reducedMotion ? 0 : t;
    const hasRipples = this.ripples.length > 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let row = 0; row < rows; row++) {
      const py = row * cellH;
      const dy = Math.round(py * dpr);
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const px = col * cellW;
        const nx = px * 0.0045;
        const ny = py * 0.0045;
        // Domain-warped noise gives the slow marbled drift of the idle state.
        const wx = noise(nx * 0.7 + drift * 0.03, ny * 0.7) - 0.5;
        const wy = noise(nx * 0.7 + 17.3, ny * 0.7 - drift * 0.025) - 0.5;
        const n = noise(nx + wx * 2.4 + drift * 0.04, ny + wy * 2.4 - drift * 0.02);
        let alpha = (0.02 + 0.075 * smoothstep(0.55, 0.9, n)) * this.tuning.density;
        let tint = 0;
        if (hasRipples) {
          const r = this.rippleAt(px, py, wx + wy, now);
          if (r > 0.02) {
            alpha += r * 0.6 * this.tuning.strength;
            tint = Math.min(1, r * 1.8);
            if (r > 0.35 && Math.random() < 0.06) this.glyphs[i] = randomGlyph();
          }
        }
        if (alpha < 0.03) continue;
        const a = Math.min(ALPHA_LEVELS - 1, Math.floor((alpha / 0.75) * ALPHA_LEVELS));
        const k = Math.min(TINT_LEVELS - 1, Math.floor(tint * TINT_LEVELS));
        ctx.drawImage(
          atlas,
          this.glyphs[i] * spriteW,
          (k * ALPHA_LEVELS + a) * spriteH,
          spriteW,
          spriteH,
          Math.round(px * dpr),
          dy,
          spriteW,
          spriteH,
        );
      }
    }

    if (!this.reducedMotion && Math.random() < 0.5) {
      this.glyphs[(Math.random() * this.glyphs.length) | 0] = randomGlyph();
    }
  }
}
