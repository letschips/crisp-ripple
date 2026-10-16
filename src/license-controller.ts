// Licence state machine, kept free of Obsidian imports so its ordering rules can be tested in Node.
// Every user action and every background check takes a sequence number; a result that comes back
// after a newer action (or after unload) is dropped instead of overwriting it.

export interface LicensePayloadLike {
  userName?: string;
  expiresAt?: string;
}

export interface LicenseResult {
  valid: boolean;
  payload?: LicensePayloadLike;
  reason?: string;
}

export interface LicenseDeps {
  /** online=false: embedded-key signature only. online=true: also asks the licence service. */
  verify(code: string, online: boolean): Promise<LicenseResult>;
  /** Codes already activated by sibling Crisp plugins that pass the local check, in scan order. */
  discover(): Promise<string[]>;
  getCode(): string;
  /** Writes the code to data.json; false when the write could not be confirmed. */
  persistCode(code: string): Promise<boolean>;
  onChange(): void;
  now?(): number;
}

export interface ActivationOutcome {
  result: LicenseResult;
  /** false when a newer action superseded this one before it finished */
  applied: boolean;
  /** false when the code could not be written to data.json (works until restart) */
  saved: boolean;
}

function expiryTime(payload?: LicensePayloadLike): number | null {
  if (!payload?.expiresAt) return null;
  const t = new Date(payload.expiresAt).getTime();
  return Number.isFinite(t) ? t : null;
}

export class LicenseController {
  state: LicenseResult = { valid: false };
  private sequence = 0;
  private disposed = false;

  constructor(private readonly deps: LicenseDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Valid and not past its expiry right now. */
  get licensed(): boolean {
    if (!this.state.valid) return false;
    const expires = expiryTime(this.state.payload);
    return expires === null || this.now() <= expires;
  }

  /** Startup: local signature only, so loading never waits on the network. */
  async loadLocal(): Promise<void> {
    const sequence = ++this.sequence;
    const code = this.deps.getCode();
    if (!code) return;
    const result = await this.deps.verify(code, false);
    if (this.stale(sequence)) return;
    this.set(result);
  }

  /**
   * After layout: online check of the stored code. When there is none, or it no longer works
   * (expired, revoked, device limit), try the codes of sibling Crisp plugins one by one and keep
   * the first that passes online, so a dead code never hides a renewed one.
   */
  async refreshInBackground(): Promise<void> {
    const sequence = ++this.sequence;
    const code = this.deps.getCode();
    if (code) {
      const result = await this.deps.verify(code, true);
      if (this.stale(sequence)) return;
      this.set(result);
      if (result.valid) return;
    }
    const candidates = (await this.deps.discover()).filter((candidate) => candidate !== code);
    for (const candidate of candidates) {
      if (this.stale(sequence)) return;
      const result = await this.deps.verify(candidate, true);
      if (this.stale(sequence)) return;
      if (!result.valid) continue;
      await this.deps.persistCode(candidate);
      if (this.stale(sequence)) return;
      this.set(result);
      return;
    }
  }

  async activate(code: string): Promise<ActivationOutcome> {
    const sequence = ++this.sequence;
    const trimmed = code.trim();
    const result = await this.deps.verify(trimmed, true);
    if (this.stale(sequence)) return { result, applied: false, saved: false };
    if (!result.valid) return { result, applied: true, saved: false };
    const saved = await this.deps.persistCode(trimmed);
    if (this.stale(sequence)) return { result, applied: false, saved };
    this.set(result);
    return { result, applied: true, saved };
  }

  async clear(): Promise<boolean> {
    ++this.sequence;
    this.set({ valid: false });
    return this.deps.persistCode("");
  }

  /** Called periodically: turns a licence that expired while running into an explicit "expired" state. */
  checkExpiry(): void {
    if (!this.state.valid || this.licensed) return;
    const date = String(this.state.payload?.expiresAt ?? "").split("T")[0];
    this.set({ valid: false, payload: this.state.payload, reason: `授权已于 ${date} 到期` });
  }

  /** Plugin unload: every in-flight check is dropped and nothing is written afterwards. */
  dispose(): void {
    this.disposed = true;
    ++this.sequence;
  }

  private stale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  private set(result: LicenseResult): void {
    this.state = { valid: result.valid, payload: result.payload, reason: result.reason };
    this.deps.onChange();
  }
}
