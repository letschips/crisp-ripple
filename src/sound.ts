// Synthesised water-drop sound: no audio files, everything is built with
// Web Audio nodes. A drop is a sine "bubble" whose pitch rises quickly
// (that upward chirp is what makes it read as water), a smaller secondary
// droplet just after, and a soft diffuse tail for the spreading ripple.

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
}

/** Schedules one drop on any context; shared by live playback and offline checks. */
export function scheduleDrop(
  ctx: BaseAudioContext,
  destination: AudioNode,
  tail: AudioBuffer,
  at: number,
  { pan, seed, volume }: DropOptions,
): void {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN * Math.max(0, Math.min(1, volume));
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const reverb = ctx.createConvolver();
  reverb.buffer = tail;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;

  dry.connect(panner);
  dry.connect(reverb).connect(wet).connect(panner);
  panner.connect(master).connect(destination);

  const base = 420 + seed * 220;
  bubble(ctx, dry, at, base, 0.9, 0.11);
  bubble(ctx, dry, at + 0.09 + seed * 0.05, base * 1.7, 0.3, 0.07);
}

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
    scheduleDrop(ctx, ctx.destination, this.tail as AudioBuffer, ctx.currentTime + 0.005, options);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.tail = null;
  }
}

export { buildTailImpulse };
