// ASCII field renderer: a character (or dot) grid whose per-cell opacity is
// driven by a slowly drifting noise field plus expanding click ripples.
// Each cell also sits on a damped spring: the pointer and the click shockwave
// push it off its home position, and it springs back once they pass.

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALPHA_LEVELS = 12;
const TINT_LEVELS = 4;
const BUCKETS = ALPHA_LEVELS * TINT_LEVELS;

const RIPPLE_LIFE = 2.2; // seconds
const RIPPLE_TAU = 0.55; // radius easing time constant
const MAX_RIPPLES = 6;
const IDLE_FRAME_MS = 50; // drift-only frames run at ~20 fps

const DOT_CELL = 10; // CSS px between dots
const DOT_RADIUS = 1.3;
const DOT_FLOOR = 0.06; // alpha of a resting dot, drawn for the whole grid with one pattern fill
const SPRING_K = 140; // stiffness, 1/s²
const SPRING_C = 9; // damping, 1/s: a little overshoot before settling
const POINTER_REACH = 90; // px
const POINTER_FORCE = 16000; // px/s² at the pointer; holds a clear hole open around it
const SHOCK_FORCE = 7000; // px/s² on the wavefront
const SHOCK_WIDTH = 18; // px, sigma of the wavefront band
const MAX_OFFSET = 90;
const MAX_STEP = 1 / 120; // integration step, s

export type FieldShape = "glyph" | "dot";

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
  /** strength of the pointer push and click shockwave; 0 keeps every cell in place */
  push: number;
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
  // One resting dot at full alpha; tiled across the canvas in a single fill.
  private readonly dotTile = document.createElement("canvas");
  private dotPattern: CanvasPattern | null = null;
  // Dots that differ from the resting grid this frame: home position, drawn position, atlas row.
  private drawList = new Int32Array(0);
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
  private tuning: FieldTuning = { speed: 1, strength: 1, density: 1, push: 1 };
  private shape: FieldShape = "glyph";
  // Spring state per cell, CSS px and px/s.
  private offX = new Float32Array(0);
  private offY = new Float32Array(0);
  private velX = new Float32Array(0);
  private velY = new Float32Array(0);
  private pointer: { x: number; y: number } | null = null;
  private lastSim = 0;
  /** Some cell is off home. */
  private displaced = false;
  /** Some cell is still visibly moving, so frames run at full rate. */
  private moving = false;
  /** The last frame put nothing on the canvas. */
  private blank = false;

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
    this.lastSim = this.epoch;
  }

  /** Follows the system setting live: stops motion at once, or resumes it. */
  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return;
    this.reducedMotion = reduced;
    if (reduced) {
      this.ripples = [];
      this.resetSprings();
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

  setShape(shape: FieldShape): void {
    if (shape === this.shape) return;
    this.shape = shape;
    this.cols = 0; // force a fresh grid
    this.resize(this.width, this.height, true);
  }

  /** Pointer position in canvas CSS px. */
  // The pointer only changes pixels through the push, so without it a move needs no frame.
  private get pushActive(): boolean {
    return !this.reducedMotion && this.tuning.push > 0;
  }

  setPointer(x: number, y: number): void {
    this.pointer = { x, y };
    if (!this.pushActive) return;
    this.moving = true;
    this.start();
  }

  clearPointer(): void {
    if (!this.pointer) return;
    this.pointer = null;
    if (this.pushActive) this.moving = true;
  }

  setColors(colors: FieldColors, font: string): void {
    const same = (a: Rgb, b: Rgb): boolean => a.r === b.r && a.g === b.g && a.b === b.b;
    // Tuning-only refreshes keep the glyph atlas; rebuilding it on every slider step is wasted work.
    if (font === this.font && same(colors.base, this.colors.base) && same(colors.accent, this.colors.accent)) return;
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
    if (this.shape === "dot") {
      // A whole number of device pixels per cell keeps the pattern fill on the same grid as the sprites.
      this.cellW = Math.max(1, Math.round(DOT_CELL * dpr)) / dpr;
      this.cellH = this.cellW;
    } else {
      this.cellW = Math.max(4, this.ctx.measureText("M").width);
      this.cellH = Math.round(this.cellW * 2.1);
    }
    this.buildAtlas();
    const cols = Math.ceil(width / this.cellW);
    const rows = Math.ceil(height / this.cellH);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.glyphs = Uint8Array.from({ length: cols * rows }, randomGlyph);
      this.offX = new Float32Array(cols * rows);
      this.offY = new Float32Array(cols * rows);
      this.velX = new Float32Array(cols * rows);
      this.velY = new Float32Array(cols * rows);
      this.drawList = new Int32Array(cols * rows * 5);
      this.displaced = false;
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
    this.pruneRipples(now);
    const still = this.ripples.length === 0 && !this.moving;
    if (still && now - this.lastDraw < IDLE_FRAME_MS) return;
    // Hidden background, no ripple, nothing displaced: the canvas stays empty until a click or a setting changes.
    if (still && this.blank && this.tuning.density <= 0 && !this.displaced) return;
    this.draw(now);
  };

  /** Drops ripples past their lifetime at the current speed; every draw goes through here. */
  private pruneRipples(now: number): void {
    const life = RIPPLE_LIFE / this.tuning.speed;
    this.ripples = this.ripples.filter((r) => (now - r.start) / 1000 < life);
  }

  private buildAtlas(): void {
    const { base, accent } = this.colors;
    this.spriteW = Math.ceil(this.cellW * this.dpr);
    this.spriteH = Math.ceil(this.cellH * this.dpr);
    const dot = this.shape === "dot";
    this.buildDotTile(dot);
    this.atlas.width = this.spriteW * (dot ? 1 : GLYPHS.length);
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
        if (dot) {
          ctx.beginPath();
          ctx.arc(this.cellW / 2, y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        for (let i = 0; i < GLYPHS.length; i++) {
          ctx.fillText(GLYPHS[i], (i * this.spriteW) / this.dpr, y);
        }
      }
    }
  }

  private buildDotTile(dot: boolean): void {
    this.dotPattern = null;
    if (!dot) return;
    const { base } = this.colors;
    this.dotTile.width = this.spriteW;
    this.dotTile.height = this.spriteH;
    const tile = this.dotTile.getContext("2d");
    if (!tile) return;
    tile.clearRect(0, 0, this.spriteW, this.spriteH);
    tile.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    tile.fillStyle = `rgb(${base.r},${base.g},${base.b})`;
    tile.beginPath();
    tile.arc(this.cellW / 2, this.cellH / 2, DOT_RADIUS, 0, Math.PI * 2);
    tile.fill();
    this.dotPattern = this.ctx.createPattern(this.dotTile, "repeat") ?? null;
  }

  private rippleAt(px: number, py: number, warp: number, now: number): number {
    let sum = 0;
    const { speed } = this.tuning;
    for (const rp of this.ripples) {
      const age = ((now - rp.start) / 1000) * speed;
      const reach = 220 + 0.16 * Math.max(this.width, this.height);
      const radius = reach * (1 - Math.exp(-age / RIPPLE_TAU));
      const fade = Math.pow(Math.max(0, 1 - age / RIPPLE_LIFE), 1.6);
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

  private resetSprings(): void {
    this.offX.fill(0);
    this.offY.fill(0);
    this.velX.fill(0);
    this.velY.fill(0);
    this.displaced = false;
    this.moving = false;
  }

  /** Advances every cell's spring from the last simulated moment to `now`. */
  private simulate(now: number): void {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastSim) / 1000));
    this.lastSim = now;
    const push = this.tuning.push;
    if (this.reducedMotion || push <= 0) {
      if (this.displaced) this.resetSprings();
      this.moving = false;
      return;
    }
    const { pointer, cols, rows, cellW, cellH, offX, offY, velX, velY } = this;
    if (dt === 0 || (!pointer && this.ripples.length === 0 && !this.displaced)) {
      this.moving = false;
      return;
    }
    const steps = Math.ceil(dt / MAX_STEP);
    const h = dt / steps;
    const { speed } = this.tuning;
    const reach = 220 + 0.16 * Math.max(this.width, this.height);
    const waves = this.ripples.map((rp) => {
      const age = ((now - rp.start) / 1000) * speed;
      return {
        x: rp.x,
        y: rp.y,
        radius: reach * (1 - Math.exp(-age / RIPPLE_TAU)),
        force: SHOCK_FORCE * push * Math.pow(Math.max(0, 1 - age / RIPPLE_LIFE), 1.6),
      };
    });
    const pointerForce = POINTER_FORCE * push;
    const near2 = (POINTER_REACH + MAX_OFFSET) ** 2;
    const band = SHOCK_WIDTH * 3;
    let displaced = false;
    let moving = false;

    for (let row = 0; row < rows; row++) {
      const hy = row * cellH + cellH / 2;
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const hx = col * cellW + cellW / 2;
        let ox = offX[i];
        let oy = offY[i];
        let vx = velX[i];
        let vy = velY[i];
        // The shockwave is evaluated at the home position once per frame.
        let sx = 0;
        let sy = 0;
        for (const w of waves) {
          const dx = hx - w.x;
          const dy = hy - w.y;
          const d = Math.hypot(dx, dy);
          const u = d - w.radius;
          if (d < 0.5 || u > band || u < -band) continue;
          const f = (w.force * Math.exp(-(u * u) / (2 * SHOCK_WIDTH * SHOCK_WIDTH))) / d;
          sx += dx * f;
          sy += dy * f;
        }
        const near = pointer !== null && (hx - pointer.x) ** 2 + (hy - pointer.y) ** 2 < near2;
        if (!near && sx === 0 && sy === 0 && ox === 0 && oy === 0 && vx === 0 && vy === 0) continue;

        for (let s = 0; s < steps; s++) {
          let ax = sx - SPRING_K * ox - SPRING_C * vx;
          let ay = sy - SPRING_K * oy - SPRING_C * vy;
          if (near && pointer) {
            // The pointer pushes on where the cell is now, so pushed cells pile up at the rim.
            let dx = hx + ox - pointer.x;
            let dy = hy + oy - pointer.y;
            let d = Math.hypot(dx, dy);
            if (d < POINTER_REACH) {
              if (d < 0.5) {
                const angle = hash(col, row) * Math.PI * 2;
                dx = Math.cos(angle);
                dy = Math.sin(angle);
                d = 1;
              }
              const f = (pointerForce * (1 - d / POINTER_REACH)) / d;
              ax += dx * f;
              ay += dy * f;
            }
          }
          vx += ax * h;
          vy += ay * h;
          ox += vx * h;
          oy += vy * h;
        }
        const m = Math.hypot(ox, oy);
        if (m > MAX_OFFSET) {
          ox *= MAX_OFFSET / m;
          oy *= MAX_OFFSET / m;
        }
        if (!near && sx === 0 && sy === 0 && m < 0.05 && Math.abs(vx) + Math.abs(vy) < 0.5) {
          ox = oy = vx = vy = 0;
        } else {
          displaced = true;
          if (Math.abs(vx) + Math.abs(vy) > 2) moving = true;
        }
        offX[i] = ox;
        offY[i] = oy;
        velX[i] = vx;
        velY[i] = vy;
      }
    }
    this.displaced = displaced;
    this.moving = moving;
  }

  private draw(now: number): void {
    this.lastDraw = now;
    this.pruneRipples(now);
    this.simulate(now);
    const { ctx, cols, rows, cellW, cellH, spriteW, spriteH, dpr, atlas, offX, offY } = this;
    const dot = this.shape === "dot";
    const displaced = this.displaced;
    const t = (now - this.epoch) / 1000;
    const drift = this.reducedMotion ? 0 : t;
    const hasRipples = this.ripples.length > 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Dot mode: the resting grid is one pattern fill; only dots that differ from it are drawn one by one.
    const floor = dot && this.dotPattern ? DOT_FLOOR * this.tuning.density : 0;
    if (floor > 0 && this.dotPattern) {
      ctx.globalAlpha = Math.min(1, floor);
      ctx.fillStyle = this.dotPattern;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
    const list = this.drawList;
    let listed = 0;
    let drawn = 0;
    for (let row = 0; row < rows; row++) {
      const py = row * cellH;
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const px = col * cellW;
        const nx = px * 0.0045;
        const ny = py * 0.0045;
        // Domain-warped noise gives the slow marbled drift of the idle state.
        const wx = noise(nx * 0.7 + drift * 0.03, ny * 0.7) - 0.5;
        const wy = noise(nx * 0.7 + 17.3, ny * 0.7 - drift * 0.025) - 0.5;
        const n = noise(nx + wx * 2.4 + drift * 0.04, ny + wy * 2.4 - drift * 0.02);
        let alpha = (dot ? 0.06 + 0.12 * smoothstep(0.4, 0.9, n) : 0.02 + 0.075 * smoothstep(0.55, 0.9, n)) *
          this.tuning.density;
        let tint = 0;
        if (hasRipples) {
          const r = this.rippleAt(px, py, wx + wy, now);
          if (r > 0.02) {
            alpha += r * 0.6 * this.tuning.strength;
            tint = Math.min(1, r * 1.8);
            if (r > 0.35 && Math.random() < 0.06) this.glyphs[i] = randomGlyph();
          }
        }
        let ox = 0;
        let oy = 0;
        if (displaced) {
          ox = offX[i];
          oy = offY[i];
          // Moved cells light up, so the push shows even where the background is faint.
          const lift = Math.min(1, Math.hypot(ox, oy) / 16);
          if (lift > 0.02) {
            alpha += lift * 0.45 * this.tuning.strength;
            tint = Math.max(tint, Math.min(1, lift * 1.6));
          }
        }
        if (alpha < 0.03) continue;
        const a = Math.min(ALPHA_LEVELS - 1, Math.floor((alpha / 0.75) * ALPHA_LEVELS));
        const k = Math.min(TINT_LEVELS - 1, Math.floor(tint * TINT_LEVELS));
        if (dot) {
          if (floor > 0 && ox === 0 && oy === 0 && tint === 0 && alpha - floor < 0.03) continue;
          const at = listed * 5;
          list[at] = col;
          list[at + 1] = row;
          list[at + 2] = Math.round((px + ox) * dpr);
          list[at + 3] = Math.round((py + oy) * dpr);
          list[at + 4] = k * ALPHA_LEVELS + a;
          listed++;
          continue;
        }
        drawn++;
        ctx.drawImage(
          atlas,
          this.glyphs[i] * spriteW,
          (k * ALPHA_LEVELS + a) * spriteH,
          spriteW,
          spriteH,
          Math.round((px + ox) * dpr),
          Math.round((py + oy) * dpr),
          spriteW,
          spriteH,
        );
      }
    }

    this.blank = drawn === 0 && listed === 0 && floor === 0;
    if (listed > 0) {
      // Lift these dots out of the pattern at home, then draw them where they are now.
      if (floor > 0) {
        for (let j = 0; j < listed * 5; j += 5) ctx.clearRect(list[j] * spriteW, list[j + 1] * spriteH, spriteW, spriteH);
      }
      for (let j = 0; j < listed * 5; j += 5) {
        ctx.drawImage(atlas, 0, list[j + 4] * spriteH, spriteW, spriteH, list[j + 2], list[j + 3], spriteW, spriteH);
      }
    }

    if (!this.reducedMotion && Math.random() < 0.5) {
      this.glyphs[(Math.random() * this.glyphs.length) | 0] = randomGlyph();
    }
  }
}
