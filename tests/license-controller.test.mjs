// Ordering, inheritance, persistence and expiry rules of the licence state machine.
// Each case mirrors a failure seen in the 0.1.0 audit; deferred promises control completion order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ripple-controller-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/license-controller.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "controller.mjs"),
  logLevel: "error",
});
const { LicenseController } = await import(pathToFileURL(path.join(outDir, "controller.mjs")).href);

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const OK = (user = "A", expiresAt = "2999-01-01T00:00:00.000Z") => ({ valid: true, payload: { userName: user, expiresAt } });

/** Fake host: data.json is `stored`, verify answers come from `answers` (code -> online -> result or deferred). */
function host({ stored = "", answers = {}, discover = async () => null, persistOk = true, now } = {}) {
  const h = {
    stored,
    calls: [],
    persists: 0,
    changes: 0,
  };
  h.controller = new LicenseController({
    verify: async (code, online) => {
      h.calls.push({ code, online });
      const answer = answers[code]?.[online ? "online" : "local"] ?? { valid: false, reason: "unknown" };
      return answer.promise ? answer.promise : answer;
    },
    discover,
    getCode: () => h.stored,
    persistCode: async (code) => {
      h.persists++;
      if (persistOk) h.stored = code;
      return persistOk;
    },
    onChange: () => h.changes++,
    now,
  });
  return h;
}

test("an inherited code is checked online before it is saved", async () => {
  const h = host({
    answers: { A: { local: OK(), online: { valid: false, reason: "该授权已被吊销" } } },
    discover: async () => "A",
  });
  await h.controller.refreshInBackground();
  assert.ok(h.calls.some((c) => c.code === "A" && c.online), "inheritance must reach the licence service");
  assert.equal(h.controller.licensed, false);
  assert.equal(h.stored, "", "a revoked sibling code must not be inherited");
});

test("an inherited code that passes online is saved and unlocks", async () => {
  const h = host({ answers: { A: { online: OK() } }, discover: async () => "A" });
  await h.controller.refreshInBackground();
  assert.equal(h.controller.licensed, true);
  assert.equal(h.stored, "A");
});

test("clearing the licence wins over a startup check that answers later", async () => {
  const pending = deferred();
  const h = host({ stored: "A", answers: { A: { local: OK(), online: pending } } });
  await h.controller.loadLocal();
  const background = h.controller.refreshInBackground();
  await h.controller.clear();
  pending.resolve(OK());
  await background;
  assert.equal(h.controller.licensed, false);
  assert.equal(h.stored, "");
});

test("a manual activation wins over an inheritance scan that finishes later", async () => {
  const scan = deferred();
  const h = host({
    answers: { A: { online: OK("A") }, B: { online: OK("B") } },
    discover: () => scan.promise,
  });
  const background = h.controller.refreshInBackground();
  const outcome = await h.controller.activate("B");
  assert.equal(outcome.applied, true);
  scan.resolve("A");
  await background;
  assert.equal(h.stored, "B");
  assert.equal(h.controller.state.payload.userName, "B");
});

test("nothing is written or changed after unload", async () => {
  const scan = deferred();
  const h = host({ answers: { A: { online: OK() } }, discover: () => scan.promise });
  const background = h.controller.refreshInBackground();
  h.controller.dispose();
  scan.resolve("A");
  await background;
  assert.equal(h.persists, 0);
  assert.equal(h.controller.licensed, false);
});

test("a failed save is reported instead of claiming the code was stored", async () => {
  const h = host({ answers: { B: { online: OK("B") } }, persistOk: false });
  const outcome = await h.controller.activate("B");
  assert.equal(outcome.result.valid, true);
  assert.equal(outcome.saved, false, "the UI must be able to tell the user the code was not saved");
  assert.equal(h.controller.licensed, true, "the verified code still works for this session");
});

test("a licence that expires while running stops unlocking features", async () => {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const expiresAt = "2030-01-01T00:00:01.000Z";
  const h = host({ answers: { A: { online: OK("A", expiresAt) } }, now: () => now });
  await h.controller.activate("A");
  assert.equal(h.controller.licensed, true);
  now += 2000;
  assert.equal(h.controller.licensed, false, "expiry is checked on every use, not only at activation");
  const before = h.changes;
  h.controller.checkExpiry();
  assert.equal(h.controller.state.valid, false);
  assert.match(h.controller.state.reason, /到期/);
  assert.ok(h.changes > before, "the UI is told so it can redraw");
});

test("an online denial of the stored code locks features", async () => {
  const h = host({ stored: "A", answers: { A: { local: OK(), online: { valid: false, reason: "设备数已达上限" } } } });
  await h.controller.loadLocal();
  assert.equal(h.controller.licensed, true);
  await h.controller.refreshInBackground();
  assert.equal(h.controller.licensed, false);
  assert.equal(h.controller.state.reason, "设备数已达上限");
});
