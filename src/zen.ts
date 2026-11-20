// Sand garden scene: raked parallel lines, stones the user places with a click, rings raked
// around each stone (and merging around groups of stones), and furrows the pointer leaves in
// the sand that slowly fill back in. Kept free of DOM types so it can be tested in Node.

export const RAKE_GAP = 9; // px between rake lines at density 100%
export const RINGS = 5; // rings raked around each stone
export const MAX_STONES = 7;
export const ERASE_CELL = 8; // px per cell of the furrow grid
const GROW_TIME = 1.1; // s for the rings to spread out from a new stone (or fold back into a removed one)
const ERASE_TAU = 60; // s: furrows fade over a couple of minutes
const ERASE_SIGMA = 9; // px: furrow core is 0.8× and its feathered edge 1.6× this, at push 100%
const STAMP_EVERY = 3; // px along the pointer path
const HIT_SLOP = 6; // px around a stone that still counts as clicking it

export interface Stone {
  x: number;
  y: number;
  /** radius, CSS px */
  r: number;
  /** 0…1: how far the rings have spread */
  grow: number;
  /** 1 while placing, -1 while being lifted out */
  dir: 1 | -1;
  /** shape of the stone's outline */
  seed: number;
}

export function rakeGap(density: number): number {
  return Math.min(30, Math.max(4.5, RAKE_GAP / Math.max(density, 0.01)));
}

export class Garden {
  stones: Stone[] = [];
  width = 0;
  height = 0;
  /** furrow depth per cell, 0…1 */
  erase = new Float32Array(0);
  ex = 0;
  ey = 0;
  /** some furrow is still visible */
  eraseActive = false;
  /** the raked lines must be re-drawn (stones or size changed) */
  dirty = true;
  private last: { x: number; y: number } | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.ex = Math.ceil(width / ERASE_CELL) + 1;
    this.ey = Math.ceil(height / ERASE_CELL) + 1;
    this.erase = new Float32Array(this.ex * this.ey);
    this.eraseActive = false;
    this.dirty = true;
  }

  /** Index of the settled-or-settling stone under (x, y), or -1. */
  hit(x: number, y: number): number {
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const s = this.stones[i];
      if (s.dir === 1 && Math.hypot(x - s.x, y - s.y) <= s.r + HIT_SLOP) return i;
    }
    return -1;
  }

  /** A click lifts out the stone under it, or sets a new stone down there. */
  click(x: number, y: number): "placed" | "removed" {
    const at = this.hit(x, y);
    this.dirty = true;
    if (at >= 0) {
      this.stones[at].dir = -1;
      return "removed";
    }
    const rnd = this.random;
    this.stones.push({ x, y, r: 15 + rnd() * 14, grow: 0, dir: 1, seed: (rnd() * 1e9) | 0 });
    // Past the limit the oldest stone still in place is lifted out.
    const placed = this.stones.filter((s) => s.dir === 1);
    if (placed.length > MAX_STONES) placed[0].dir = -1;
    return "placed";
  }

  /**
   * Advances rings and furrows. `pointer` is null when the pointer is away or the push is off.
   * Returns whether something moved at animation speed (rings spreading, a furrow being drawn).
   */
  step(dt: number, pointer: { x: number; y: number } | null, push: number, speed: number): boolean {
    let busy = false;
    if (dt > 0) {
      for (const s of this.stones) {
        const before = s.grow;
        s.grow = Math.min(1, Math.max(0, s.grow + (s.dir * dt * speed) / GROW_TIME));
        if (s.grow !== before) {
          busy = true;
          this.dirty = true;
        }
      }
      const kept = this.stones.filter((s) => !(s.dir === -1 && s.grow === 0));
      if (kept.length !== this.stones.length) {
        this.stones = kept;
        this.dirty = true;
      }
      if (this.eraseActive) {
        const fade = Math.exp((-dt * speed) / ERASE_TAU);
        let any = false;
        const e = this.erase;
        for (let i = 0; i < e.length; i++) {
          if (e[i] === 0) continue;
          e[i] *= fade;
          if (e[i] < 0.01) e[i] = 0;
          else any = true;
        }
        this.eraseActive = any;
      }
    }
    if (pointer && push > 0) {
      const from = this.last ?? pointer;
      const dx = pointer.x - from.x;
      const dy = pointer.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.5 || !this.last) {
        const n = Math.max(1, Math.ceil(len / STAMP_EVERY));
        for (let k = 1; k <= n; k++) this.stamp(from.x + (dx * k) / n, from.y + (dy * k) / n, ERASE_SIGMA * Math.sqrt(push));
        busy = true;
      }
      this.last = { x: pointer.x, y: pointer.y };
    } else {
      this.last = null;
    }
    return busy;
  }

  /** A furrow is fully smoothed across its core and feathers out at the edge, like sand pushed aside. */
  private stamp(x: number, y: number, sigma: number): void {
    const core = sigma * 0.8;
    const reach = sigma * 1.6;
    const c0 = Math.max(0, Math.floor((x - reach) / ERASE_CELL));
    const c1 = Math.min(this.ex - 1, Math.ceil((x + reach) / ERASE_CELL));
    const r0 = Math.max(0, Math.floor((y - reach) / ERASE_CELL));
    const r1 = Math.min(this.ey - 1, Math.ceil((y + reach) / ERASE_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * ERASE_CELL - x, r * ERASE_CELL - y);
        if (d >= reach) continue;
        const t = d <= core ? 0 : (d - core) / (reach - core);
        const v = 1 - t * t * (3 - 2 * t);
        const k = r * this.ex + c;
        if (v > this.erase[k]) this.erase[k] = v;
      }
    }
    this.eraseActive = true;
  }

  /** Radius around a stone inside which the parallel lines give way to its rings. */
  zone(s: Stone, gap: number): number {
    return s.r + RINGS * gap * s.grow;
  }

  /**
   * The rings' field on a lattice covering [x0, x0 + (lx-1)·step] × [y0, …]: distance to the nearest
   * stone's edge, stretched by how far its rings have spread, clamped to the ring band.
   * Rings are its iso-lines at (k + 0.6)·gap for k < RINGS; nearby stones' rings merge.
   */
  ringField(x0: number, y0: number, lx: number, ly: number, step: number, gap: number, out: Float32Array): void {
    const top = RINGS * gap;
    const live = this.stones.filter((s) => s.grow > 0);
    for (let j = 0; j < ly; j++) {
      const y = y0 + j * step;
      for (let i = 0; i < lx; i++) {
        const x = x0 + i * step;
        let d = top;
        for (const s of live) {
          const v = (Math.hypot(x - s.x, y - s.y) - s.r) / s.grow;
          if (v < d) d = v;
        }
        out[j * lx + i] = d < 0 ? 0 : d;
      }
    }
  }
}
