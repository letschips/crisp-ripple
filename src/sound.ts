// Synthesised water-drop sound: no audio files, everything is built with
// Web Audio nodes. A drop is a sine "bubble" whose pitch rises quickly
// (that upward chirp is what makes it read as water), a smaller secondary
// droplet just after, and a soft diffuse tail for the spreading ripple.
// The contour scene uses a "stone" instead: a low thump whose pitch falls, with a
// short muffled grit, like a pebble set down on soft ground.

const MASTER_GAIN = 0.14;
const TAIL_SECONDS = 1.4;

function bubble(
  ctx: BaseAudioContext,
  out: AudioNode,
  at: number,
  freq: number,
  level: number,
  decay: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 2.6, at + decay * 0.9);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.02);
}

/** A sine whose pitch falls: the falling pitch is what reads as weight rather than water. */
function thump(ctx: BaseAudioContext, out: AudioNode, at: number, freq: number, level: number, decay: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.55, at + decay);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.02);
}

/** A few tens of ms of low-passed noise: the grit of the stone touching down. */
function grit(ctx: BaseAudioContext, out: AudioNode, at: number, level: number, seed: number): void {
  const seconds = 0.07;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp((-i / data.length) * 5);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 700 + seed * 400;
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(filter).connect(gain).connect(out);
  src.start(at);
  src.stop(at + seconds);
}

function buildTailImpulse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * TAIL_SECONDS);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate;
      // One-pole low-pass keeps the tail watery rather than hissy.
      smooth += 0.18 * (Math.random() * 2 - 1 - smooth);
      data[i] = smooth * Math.exp(-t * 4.2);
    }
  }
  return buffer;
}

export interface DropOptions {
  /** -1 (left) … 1 (right) */
  pan: number;
  /** 0 … 1, varies pitch so repeated clicks do not sound identical */
  seed: number;
  /** 0 … 1 multiplier on the default level */
  volume: number;
  /** water drop for the ripple scenes, stone for the contour scene */
  kind?: "drop" | "stone";
}

/** Schedules one drop on any context; shared by live playback and offline checks. */
export function scheduleDrop(
  ctx: BaseAudioContext,
  destination: AudioNode,
  tail: AudioBuffer,
  at: number,
  { pan, seed, volume, kind = "drop" }: DropOptions,
): AudioNode {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN * Math.max(0, Math.min(1, volume));
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const reverb = ctx.createConvolver();
  reverb.buffer = tail;
  const wet = ctx.createGain();
  wet.gain.value = kind === "stone" ? 0.18 : 0.35;

  dry.connect(panner);
  dry.connect(reverb).connect(wet).connect(panner);
  panner.connect(master).connect(destination);

  if (kind === "stone") {
    // Starts near 200 Hz so laptop speakers still carry it; low notes sound quieter, so it runs a little hotter than the drop.
    const base = 190 + seed * 50;
    thump(ctx, dry, at, base, 1.05, 0.2);
    grit(ctx, dry, at, 0.35, seed);
    return master;
  }
  const base = 420 + seed * 220;
  bubble(ctx, dry, at, base, 0.9, 0.11);
  bubble(ctx, dry, at + 0.09 + seed * 0.05, base * 1.7, 0.3, 0.07);
  return master;
}

/** The second bubble starts by 0.14 s and lasts 0.09 s; the reverb tail rings on after it. */
const DROP_SECONDS = 0.25 + TAIL_SECONDS;

export class DropSound {
  private ctx: AudioContext | null = null;
  private tail: AudioBuffer | null = null;

  play(options: DropOptions): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.tail = buildTailImpulse(this.ctx);
    }
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const master = scheduleDrop(ctx, ctx.destination, this.tail as AudioBuffer, ctx.currentTime + 0.005, options);
    // Detach each drop's chain once it has rung out, so repeated clicks do not leave convolvers on the graph.
    window.setTimeout(() => master.disconnect(), DROP_SECONDS * 1000 + 100);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.tail = null;
  }
}

export { buildTailImpulse };
