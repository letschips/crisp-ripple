import type { FieldColors } from "./field";
import { AsciiRenderer, type RGB } from "./vendor/ascii-sharks/renderer";
import { World, type SharkSpec } from "./vendor/ascii-sharks/world";

const STEP = 1 / 60;
const SHARKS: SharkSpec[] = [
  { kind: "whale", size: 1.05 },
  { kind: "greathammer", size: 0.95 },
  { kind: "whale", size: 0.88 },
  { kind: "thresher", size: 0.85 },
  { kind: "hammerhead", size: 0.85 },
  { kind: "tiger", size: 0.78 },
  { kind: "hammerhead", size: 0.76 },
];

export class SharkScene {
  private readonly renderer: AsciiRenderer;
  private world: World | undefined;
  private worldKey = "";
  private canvasKey = "";
  private stepRemainder = 0;
  private drawElapsed = 0;
  private reducedMotion = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new AsciiRenderer(canvas.ownerDocument.createElement("canvas"), true);
  }

  resize(width: number, height: number, dpr: number, density: number, reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (width < 1 || height < 1 || density <= 0) {
      this.world = undefined;
      this.worldKey = "";
      return;
    }
    const canvasKey = `${width}|${height}|${dpr}`;
    if (canvasKey !== this.canvasKey) {
      this.renderer.resize(width, height, dpr);
      this.canvasKey = canvasKey;
    }
    const shortSide = Math.min(width, height);
    const count = Math.min(SHARKS.length, Math.max(2, Math.round(SHARKS.length * Math.min(1, shortSide / 700) * density)));
    const fish = Math.max(1, Math.round(Math.min(340, Math.max(85, width * height / 4400)) * density));
    const worldKey = `${width}|${height}|${count}|${fish}`;
    if (worldKey === this.worldKey) return;

    const scale = Math.min(1, shortSide / 420);
    const specs = SHARKS.slice(0, count).map(({ kind, size }) => ({ kind, size: size * scale }));
    this.world = new World(specs, fish, true, true);
    this.world.resize(width, height, this.renderer.cellWidth, this.renderer.cellHeight);
    this.worldKey = worldKey;
    this.stepRemainder = 0;
    this.drawElapsed = 0;
    if (reducedMotion) {
      for (let frame = 0; frame < 240; frame++) this.world.step(STEP);
      // Kills during the warm-up would all land on the one frozen frame as a burst of colour.
      this.world.events.length = 0;
    }
  }

  setColors(colors: FieldColors, font: string): void {
    const paper = colors.paper ?? { r: 250, g: 250, b: 250 };
    const theme = paper.r * 0.213 + paper.g * 0.715 + paper.b * 0.072 < 128 ? "dark" : "light";
    const rgb = ({ r, g, b }: FieldColors["base"]): RGB => [r, g, b];
    this.renderer.setFontFamily(font.replace(/^\d+(?:\.\d+)?px\s+/, ""));
    this.renderer.setTheme(theme, { paper: rgb(paper), ink: rgb(colors.base), accent: rgb(colors.accent) });
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced && this.world) {
      this.world.pointer.active = false;
      this.world.events.length = 0;
      this.stepRemainder = 0;
      this.drawElapsed = 0;
    }
  }

  step(dt: number, speed: number, pointer: { x: number; y: number } | null): void {
    if (!this.world || this.reducedMotion) return;
    this.world.pointer.active = pointer !== null;
    if (pointer) {
      this.world.pointer.x = pointer.x;
      this.world.pointer.y = pointer.y;
    }
    const elapsed = dt * speed;
    this.stepRemainder += elapsed;
    this.drawElapsed += elapsed;
    while (this.stepRemainder >= STEP) {
      this.world.step(STEP);
      this.stepRemainder -= STEP;
    }
  }

  get hasWorld(): boolean {
    return this.world !== undefined;
  }

  splash(x: number, y: number): void {
    if (!this.reducedMotion) this.world?.splash(x, y);
  }

  draw(ctx: CanvasRenderingContext2D, strength: number): boolean {
    if (!this.world) return false;
    this.renderer.render(this.world, this.drawElapsed);
    this.drawElapsed = 0;
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.4 + strength * 0.6);
    this.renderer.compositeOn(ctx);
    ctx.restore();
    return true;
  }
}
