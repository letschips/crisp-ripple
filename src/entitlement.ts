import type { LicenseResult } from "./license-controller";

// Entitlement lives in module-private maps keyed by the plugin. Nothing on the plugin, its
// controller or data.json can turn it on; only a verified license result applied here can.
const STATE = new WeakMap<object, boolean>();
const EXPIRY = new WeakMap<object, number>();
const LISTENERS = new WeakMap<object, (entitled: boolean) => void>();
// Each owner trusts only the first controller registered for it. The controller class is
// reachable from the console, so a second one built with a fake verifier must not reach the gate.
const CLAIMS = new WeakMap<object, object>();

function active(owner: object): boolean {
  if (STATE.get(owner) !== true) return false;
  const expiry = EXPIRY.get(owner);
  if (expiry === undefined || Date.now() < expiry) return true;
  STATE.set(owner, false);
  const listener = LISTENERS.get(owner);
  if (listener) setTimeout(() => listener(false), 0);
  return false;
}

/** The single gate every licensed feature goes through. */
export function rippleEntitled(owner: unknown): boolean {
  if (!owner || (typeof owner !== "object" && typeof owner !== "function")) return false;
  return active(owner as object);
}

/** Registers the controller that may report for this owner; false when another one already does. */
export function claimEntitlement(owner: object, by: object, listener: (entitled: boolean) => void): boolean {
  if (CLAIMS.has(owner)) return false;
  CLAIMS.set(owner, by);
  LISTENERS.set(owner, listener);
  return true;
}

/** Records a license check for this owner and reports whether access changed. */
export function applyEntitlement(owner: object, by: object, result: Pick<LicenseResult, "valid" | "payload">): boolean {
  if (CLAIMS.get(owner) !== by) return false;
  const before = active(owner);
  const valid = result.valid === true;
  STATE.set(owner, valid);
  const expiry = valid ? new Date(result.payload?.expiresAt ?? "").getTime() : Number.NaN;
  if (Number.isFinite(expiry)) EXPIRY.set(owner, expiry);
  else EXPIRY.delete(owner);
  const after = active(owner);
  if (before !== after) LISTENERS.get(owner)?.(after);
  return before !== after;
}
