// Firefly scene: a slow swarm (boids) whose members blink and, like real fireflies, gradually
// fall into step with the neighbours they can see. The pointer startles them aside, a click
// scatters them in a flash. Kept free of DOM types so it can be tested in Node.

const NEIGHBOUR = 70; // px: who a firefly flocks with and syncs to
const SEPARATE = 24; // px: personal space
const COHESION = 0.35; // 1/s², pull toward the local centre
const ALIGNMENT = 0.9; // 1/s, match neighbours' velocity
const SEPARATION = 160; // px/s² at zero distance
const WANDER = 22; // px/s², each firefly's own drifting urge
const CRUISE_MIN = 8; // px/s
const CRUISE_MAX = 34; // px/s at speed 100%
const DRAG = 2.5; // 1/s, how fast a scattered firefly slows back to cruising speed
const POINTER_REACH = 120; // px
const POINTER_FORCE = 520; // px/s² at the pointer, push 100%
const SCATTER_REACH = 260; // px
const SCATTER_KICK = 240; // px/s at the click, push 100%
const FLASH_DECAY = 0.7; // s
const SYNC = 1.2; // phase coupling, 1/s: neighbours drift into flashing together within ~30 s
const EDGE = 24; // px beyond the edge before a firefly wraps to the other side
/** One firefly per this many CSS px² at density 100%. */
export const AREA_PER_FIREFLY = 9000;
export const MAX_FIREFLIES = 420;

export function fireflyCount(width: number, height: number, density: number): number {
  if (density <= 0 || width <= 0 || height <= 0) return 0;
  return Math.min(MAX_FIREFLIES, Math.max(12, Math.round(((width * height) / AREA_PER_FIREFLY) * density)));
}

export interface SwarmTuning {
  speed: number;
  push: number;
}

export class Swarm {
  x = new Float32Array(0);
  y = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);
  /** blink phase, 0…1 */
  phase = new Float32Array(0);
  /** blinks per second */
  rate = new Float32Array(0);
  wander = new Float32Array(0);
  /** brightness added by a nearby click, decays to 0 */
  flash = new Float32Array(0);
  count = 0;
  width = 0;
  height = 0;
  private time = 0;
  // Spatial grid for neighbour lookups: head of each cell's list, and the next firefly in it.
  private head = new Int32Array(0);
  private next = new Int32Array(0);
  private gx = 0;
  private gy = 0;
  // Per-step scratch, reused between frames.
  private ax = new Float32Array(0);
  private ay = new Float32Array(0);
  private dphase = new Float32Array(0);

  constructor(private readonly random: () => number = Math.random) {}

  /** Keeps existing fireflies where they are; adds or drops some to reach `count`. */
  resize(width: number, height: number, count: number): void {
    const old = this.count;
    const keep = Math.min(old, count);
    const grow = <T extends Float32Array>(a: T): T => {
      const b = new Float32Array(count) as T;
      b.set(a.subarray(0, keep));
      return b;
    };
    if (count !== old) {
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.vx = grow(this.vx);
      this.vy = grow(this.vy);
      this.phase = grow(this.phase);
      this.rate = grow(this.rate);
      this.wander = grow(this.wander);
      this.flash = grow(this.flash);
      this.next = new Int32Array(count);
      this.ax = new Float32Array(count);
      this.ay = new Float32Array(count);
      this.dphase = new Float32Array(count);
    }
    const rnd = this.random;
    for (let i = 0; i < count; i++) {
      // A window that shrank would strand fireflies outside; bring them back in.
      if (i < keep && width > 0 && height > 0) {
        if (this.x[i] > width + EDGE) this.x[i] = rnd() * width;
        if (this.y[i] > height + EDGE) this.y[i] = rnd() * height;
        continue;
      }
      this.x[i] = rnd() * width;
      this.y[i] = rnd() * height;
      const a = rnd() * Math.PI * 2;
      const s = CRUISE_MIN + rnd() * (CRUISE_MAX - CRUISE_MIN);
      this.vx[i] = Math.cos(a) * s;
      this.vy[i] = Math.sin(a) * s;
      this.phase[i] = rnd();
      this.rate[i] = 0.25 + rnd() * 0.1;
      this.wander[i] = rnd() * Math.PI * 2;
      this.flash[i] = 0;
    }
    this.count = count;
    this.width = width;
    this.height = height;
  }

  /** Brightness 0…1 of firefly i: a short glow once per blink, plus any click flash. */
  brightness(i: number): number {
    const s = Math.sin(this.phase[i] * Math.PI * 2);
    const blink = s > 0 ? s * s * s : 0;
    return Math.min(1, 0.18 + 0.82 * blink + this.flash[i]);
  }

  /** A click: fireflies near it dart away and light up. */
  scatter(cx: number, cy: number, push: number): void {
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - cx;
      const dy = this.y[i] - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= SCATTER_REACH) continue;
      const near = 1 - d / SCATTER_REACH;
      this.flash[i] = Math.max(this.flash[i], near);
      if (push <= 0) continue;
      const kick = (SCATTER_KICK * push * near) / Math.max(d, 1);
      const ux = d < 1 ? Math.cos(this.wander[i]) : dx;
      const uy = d < 1 ? Math.sin(this.wander[i]) : dy;
      this.vx[i] += ux * kick;
      this.vy[i] += uy * kick;
    }
  }

  private buildGrid(): void {
    this.gx = Math.max(1, Math.ceil(this.width / NEIGHBOUR));
    this.gy = Math.max(1, Math.ceil(this.height / NEIGHBOUR));
    if (this.head.length < this.gx * this.gy) this.head = new Int32Array(this.gx * this.gy);
    this.head.fill(-1, 0, this.gx * this.gy);
    for (let i = 0; i < this.count; i++) {
      const c = this.cellOf(this.x[i], this.y[i]);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.gx - 1, Math.max(0, Math.floor(x / NEIGHBOUR)));
    const cy = Math.min(this.gy - 1, Math.max(0, Math.floor(y / NEIGHBOUR)));
    return cy * this.gx + cx;
  }

  /** Advances the swarm by dt seconds. Returns whether some firefly is still flashing or racing. */
  step(dt: number, pointer: { x: number; y: number } | null, { speed, push }: SwarmTuning): boolean {
    if (dt <= 0 || this.count === 0) return false;
    this.time += dt;
    this.buildGrid();
    const { x, y, vx, vy, phase, rate, wander, flash, count } = this;
    const rnd = this.random;
    const cruise = CRUISE_MAX * speed;
    const reach2 = NEIGHBOUR * NEIGHBOUR;
    const pointerForce = POINTER_FORCE * push;
    const flashFade = Math.exp(-dt / FLASH_DECAY);
    let busy = false;
    const { ax, ay, dphase } = this;
    dphase.fill(0);

    for (let i = 0; i < count; i++) {
      let n = 0;
      let cx = 0;
      let cy = 0;
      let avx = 0;
      let avy = 0;
      let sx = 0;
      let sy = 0;
      let sync = 0;
      const ci = Math.min(this.gx - 1, Math.max(0, Math.floor(x[i] / NEIGHBOUR)));
      const cj = Math.min(this.gy - 1, Math.max(0, Math.floor(y[i] / NEIGHBOUR)));
      for (let gj = Math.max(0, cj - 1); gj <= Math.min(this.gy - 1, cj + 1); gj++) {
        for (let gi = Math.max(0, ci - 1); gi <= Math.min(this.gx - 1, ci + 1); gi++) {
          for (let j = this.head[gj * this.gx + gi]; j >= 0; j = this.next[j]) {
            if (j === i) continue;
            const dx = x[j] - x[i];
            const dy = y[j] - y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 > reach2) continue;
            n++;
            cx += dx;
            cy += dy;
            avx += vx[j];
            avy += vy[j];
            // Kuramoto coupling: each blink nudges its neighbours' phase toward its own.
            sync += Math.sin((phase[j] - phase[i]) * Math.PI * 2);
            if (d2 < SEPARATE * SEPARATE) {
              const d = Math.sqrt(d2) || 1;
              const f = (SEPARATION * (1 - d / SEPARATE)) / d;
              sx -= dx * f;
              sy -= dy * f;
            }
          }
        }
      }
      let fx = sx;
      let fy = sy;
      if (n > 0) {
        fx += (cx / n) * COHESION + (avx / n - vx[i]) * ALIGNMENT;
        fy += (cy / n) * COHESION + (avy / n - vy[i]) * ALIGNMENT;
        dphase[i] = (SYNC * sync) / n / (Math.PI * 2);
      }
      wander[i] += (rnd() - 0.5) * 3 * dt;
      fx += Math.cos(wander[i]) * WANDER;
      fy += Math.sin(wander[i]) * WANDER;
      if (pointer && pointerForce > 0) {
        const dx = x[i] - pointer.x;
        const dy = y[i] - pointer.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < POINTER_REACH && d > 0.5) {
          const f = (pointerForce * (1 - d / POINTER_REACH)) / d;
          fx += dx * f;
          fy += dy * f;
        }
      }
      ax[i] = fx;
      ay[i] = fy;
    }

    for (let i = 0; i < count; i++) {
      let nvx = vx[i] + ax[i] * dt;
      let nvy = vy[i] + ay[i] * dt;
      const s = Math.sqrt(nvx * nvx + nvy * nvy);
      if (s > cruise) {
        // Faster than cruising (a scatter or a startle): ease back down instead of clamping.
        const target = Math.max(cruise, s * Math.exp(-dt * DRAG));
        nvx *= target / s;
        nvy *= target / s;
        if (s > cruise * 1.5) busy = true;
      } else if (s < CRUISE_MIN * speed && s > 0) {
        nvx *= (CRUISE_MIN * speed) / s;
        nvy *= (CRUISE_MIN * speed) / s;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      x[i] += nvx * dt;
      y[i] += nvy * dt;
      if (x[i] < -EDGE) x[i] += this.width + 2 * EDGE;
      else if (x[i] > this.width + EDGE) x[i] -= this.width + 2 * EDGE;
      if (y[i] < -EDGE) y[i] += this.height + 2 * EDGE;
      else if (y[i] > this.height + EDGE) y[i] -= this.height + 2 * EDGE;
      const p = phase[i] + (rate[i] * speed + dphase[i]) * dt;
      phase[i] = p - Math.floor(p);
      if (flash[i] > 0) {
        flash[i] = flash[i] * flashFade;
        if (flash[i] < 0.01) flash[i] = 0;
        else busy = true;
      }
    }
    return busy;
  }
}
