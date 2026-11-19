// Contour scene: a drifting height field drawn as topographic lines with marching squares.
// Segments are chained into continuous lines and drawn as quadratic curves through the
// crossing points, so a coarse lattice still gives smooth lines.
// Kept free of DOM types so the tracing can be tested in Node.

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
}

export interface ContourSinks {
  /** ordinary lines */
  minor: PathSink;
  /** every MAJOR_EVERY-th level, drawn a little stronger like an index contour */
  major: PathSink;
}

export const MAJOR_EVERY = 4;

// Reused between frames: segment endpoints, their edge keys, and the endpoint each one joins.
let ptX = new Float32Array(0);
let ptY = new Float32Array(0);
let segLevel = new Int32Array(0);
let mate = new Int32Array(0);
let seen = new Uint8Array(0);
const open = new Map<number, number>();

function grow(segments: number): void {
  if (segLevel.length >= segments) return;
  const n = Math.max(segments, segLevel.length * 2, 1024);
  const copy = <T extends Float32Array | Int32Array>(a: T, size: number, make: (s: number) => T): T => {
    const b = make(size);
    b.set(a);
    return b;
  };
  ptX = copy(ptX, n * 2, (s) => new Float32Array(s));
  ptY = copy(ptY, n * 2, (s) => new Float32Array(s));
  segLevel = copy(segLevel, n, (s) => new Int32Array(s));
}

/**
 * Traces every iso-level `offset + k·gap` through a lattice of heights.
 * `h` holds lx × ly samples `step` CSS px apart. Returns the number of segments found.
 */
export function traceContours(
  h: Float32Array,
  lx: number,
  ly: number,
  step: number,
  offset: number,
  gap: number,
  sinks: ContourSinks,
): number {
  const edges = lx * ly * 2;
  let count = 0;
  open.clear();
  const link = (endpoint: number, key: number): void => {
    const other = open.get(key);
    if (other === undefined) {
      open.set(key, endpoint);
    } else {
      mate[endpoint] = other;
      mate[other] = endpoint;
      open.delete(key);
    }
  };
  // Edge ids: horizontal edge from lattice point p to p+1 is 2p, vertical edge from p to p+lx is 2p+1.
  const push = (level: number, ax: number, ay: number, ea: number, bx: number, by: number, eb: number): void => {
    grow(count + 1);
    if (mate.length < (count + 1) * 2) {
      const m = new Int32Array(segLevel.length * 2);
      m.set(mate);
      mate = m;
    }
    const a = count * 2;
    ptX[a] = ax;
    ptY[a] = ay;
    ptX[a + 1] = bx;
    ptY[a + 1] = by;
    mate[a] = -1;
    mate[a + 1] = -1;
    segLevel[count] = level;
    const base = level * edges;
    link(a, base + ea);
    link(a + 1, base + eb);
    count++;
  };

  for (let j = 0; j < ly - 1; j++) {
    const y0 = j * step;
    const y1 = y0 + step;
    for (let i = 0; i < lx - 1; i++) {
      const k = j * lx + i;
      const tl = h[k];
      const tr = h[k + 1];
      const bl = h[k + lx];
      const br = h[k + lx + 1];
      const lo = Math.min(tl, tr, bl, br);
      const hi = Math.max(tl, tr, bl, br);
      // Most cells cross no level at all; only walk the levels this cell actually spans.
      const kmin = Math.ceil((lo - offset) / gap);
      const kmax = Math.floor((hi - offset) / gap);
      if (kmax < kmin) continue;
      const x0 = i * step;
      const x1 = x0 + step;
      const eTop = 2 * k;
      const eBottom = 2 * (k + lx);
      const eLeft = 2 * k + 1;
      const eRight = 2 * (k + 1) + 1;
      for (let level = kmin; level <= kmax; level++) {
        const v = offset + level * gap;
        const code = (tl >= v ? 8 : 0) | (tr >= v ? 4 : 0) | (br >= v ? 2 : 0) | (bl >= v ? 1 : 0);
        if (code === 0 || code === 15) continue;
        // Edge crossings, linearly interpolated. Neighbouring cells compute the same point for a shared edge.
        const topX = x0 + (step * (v - tl)) / (tr - tl);
        const bottomX = x0 + (step * (v - bl)) / (br - bl);
        const leftY = y0 + (step * (v - tl)) / (bl - tl);
        const rightY = y0 + (step * (v - tr)) / (br - tr);
        switch (code) {
          case 1:
          case 14:
            push(level, x0, leftY, eLeft, bottomX, y1, eBottom);
            break;
          case 2:
          case 13:
            push(level, bottomX, y1, eBottom, x1, rightY, eRight);
            break;
          case 3:
          case 12:
            push(level, x0, leftY, eLeft, x1, rightY, eRight);
            break;
          case 4:
          case 11:
            push(level, topX, y0, eTop, x1, rightY, eRight);
            break;
          case 6:
          case 9:
            push(level, topX, y0, eTop, bottomX, y1, eBottom);
            break;
          case 7:
          case 8:
            push(level, topX, y0, eTop, x0, leftY, eLeft);
            break;
          case 5: // saddle: tr and bl high
            push(level, topX, y0, eTop, x1, rightY, eRight);
            push(level, x0, leftY, eLeft, bottomX, y1, eBottom);
            break;
          case 10: // saddle: tl and br high
            push(level, topX, y0, eTop, x0, leftY, eLeft);
            push(level, bottomX, y1, eBottom, x1, rightY, eRight);
            break;
        }
      }
    }
  }

  if (seen.length < count) seen = new Uint8Array(segLevel.length);
  seen.fill(0, 0, count);
  for (let s = 0; s < count; s++) {
    if (seen[s]) continue;
    // Walk back to the open end of this chain, or find that it is a closed loop.
    let start = s * 2;
    let closed = false;
    for (;;) {
      const m = mate[start];
      if (m < 0) break;
      if (m >> 1 === s) {
        closed = true;
        break;
      }
      start = m ^ 1;
      if (start >> 1 === s) {
        closed = true;
        break;
      }
    }
    if (closed && loopLength(start) < MIN_LOOP) continue; // a speck where the terrain just grazes a level
    emitChain(start, closed, segLevel[s] % MAJOR_EVERY === 0 ? sinks.major : sinks.minor);
  }
  return count;
}

/** Closed loops with fewer segments than this are specks a few px across; they flicker in and out, so skip them. */
const MIN_LOOP = 5;

/** Counts a closed loop's segments and marks them seen. */
function loopLength(start: number): number {
  let n = 0;
  let e = start;
  for (;;) {
    seen[e >> 1] = 1;
    n++;
    const m = mate[e ^ 1];
    if (m < 0 || seen[m >> 1]) return n;
    e = m;
  }
}

/** Draws one chain: quadratic curves through each crossing point, joined at the midpoints between them. */
function emitChain(start: number, closed: boolean, sink: PathSink): void {
  // Collect the chain's points: the start point, then the far end of every segment in turn.
  let e = start;
  let px = ptX[e];
  let py = ptY[e];
  let first = true;
  // For a closed loop the curve starts and ends at the midpoint of the first segment.
  let fmx = 0;
  let fmy = 0;
  for (;;) {
    seen[e >> 1] = 1;
    const far = e ^ 1;
    const qx = ptX[far];
    const qy = ptY[far];
    const mx = (px + qx) / 2;
    const my = (py + qy) / 2;
    if (first) {
      if (closed) {
        fmx = mx;
        fmy = my;
        sink.moveTo(mx, my);
      } else {
        sink.moveTo(px, py);
        sink.lineTo(mx, my);
      }
      first = false;
    } else {
      sink.quadraticCurveTo(px, py, mx, my);
    }
    px = qx;
    py = qy;
    const m = mate[far];
    // loopLength already marked a long loop seen, so a closed chain stops when it is back at the start.
    if (m < 0 || m === start || (!closed && seen[m >> 1])) break;
    e = m;
  }
  if (closed) sink.quadraticCurveTo(px, py, fmx, fmy);
  else sink.lineTo(px, py);
}
