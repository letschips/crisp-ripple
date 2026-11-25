// License check regressions. Runs the real src/license.ts in Node with a locally
// generated Ed25519 key swapped in for the production public key, so real signatures are
// verified without any production secret and without touching the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const testPem = publicKey.export({ type: "spki", format: "pem" }).trim();

const outDir = mkdtempSync(path.join(tmpdir(), "ripple-license-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const requestUrl = undefined;\n");
await esbuild.build({
  entryPoints: [path.join(root, "src/license.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "license.mjs"),
  logLevel: "error",
  alias: { obsidian: stub },
  plugins: [{
    name: "test-public-key",
    setup(build) {
      build.onLoad({ filter: /license\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        // Only the backtick-delimited constant, never the header strings used by the parser.
        const swapped = source.replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/, `\`${testPem}\``);
        assert.notEqual(swapped, source, "the embedded public key must be replaced");
        return { contents: swapped, loader: "ts" };
      });
    },
  }],
});
const { verifyLicenseCode, discoverVaultCrispLicenses, normalizeLicenseCode } = await import(pathToFileURL(path.join(outDir, "license.mjs")).href);

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function makeCode(fields = {}) {
  const payload = b64url(JSON.stringify({
    product: "Crisp Suite", licenseId: "TEST-1", userName: "Tester",
    expiresAt: "2999-01-01T00:00:00.000Z", features: ["all"], ...fields,
  }));
  return `${payload}.${b64url(sign(null, Buffer.from(payload), privateKey))}`;
}
const CODE = makeCode();
// Node has no window/app, so the device id is supplied like the plugin would.
const env = (extra) => ({ getDeviceId: () => "test-device", ...extra });

/** Mimics Obsidian's requestUrl with throw:false: resolves for every status. */
function respond(status, body) {
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    return {
      status,
      get json() {
        if (typeof body === "string") throw new SyntaxError("Unexpected token in JSON");
        return body;
      },
    };
  };
  return { request, calls };
}

test("200 valid:true is accepted online", async () => {
  const { request, calls } = respond(200, { valid: true, message: "ok" });
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "online");
  assert.equal(calls.length, 1);
});

test("the request asks requestUrl not to throw on 4xx", async () => {
  const { request, calls } = respond(200, { valid: true });
  await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
  assert.equal(calls[0].throw, false, "without throw:false a 403 becomes an exception and fails open");
});

for (const [status, reason] of [
  [200, "该卡密激活设备数已达上限 (2/2)"],
  [400, "授权码格式无效"],
  [401, "签名无效"],
  [403, "该授权已被吊销，如有疑问请联系卖家"],
  [403, "该卡密累计激活次数已达上限 (5/5)"],
  [403, "该授权码未包含此插件权限"],
]) {
  test(`${status} valid:false is a denial (${reason})`, async () => {
    const { request } = respond(status, { valid: false, reason });
    const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
    assert.equal(res.valid, false);
    assert.equal(res.reason, reason);
  });
}

test("503 stays fail-open: the service being down is not a denial", async () => {
  const { request } = respond(503, { valid: false, errorType: "server_error", reason: "授权服务暂不可用" });
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
  assert.equal(res.valid, true);
});

test("a 403 without a JSON verdict is not treated as a denial", async () => {
  const { request } = respond(403, "<html>blocked by proxy</html>");
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
  assert.equal(res.valid, true);
});

test("a network error falls back to the local signature", async () => {
  const request = async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); };
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "offline");
});

test("a hanging request times out and falls back instead of waiting forever", async () => {
  const request = () => new Promise(() => {});
  const started = Date.now();
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request, timeoutMs: 150 }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "offline");
  assert.ok(Date.now() - started < 2000, "must not wait for the hung request");
});

test("offline mode never calls the service", async () => {
  const { request, calls } = respond(403, { valid: false, reason: "revoked" });
  const res = await verifyLicenseCode(CODE, "crisp-ripple", env({ request, online: false }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "local");
  assert.equal(calls.length, 0);
});

test("local checks reject before any request", async () => {
  const { request, calls } = respond(200, { valid: true });
  const tampered = CODE.slice(0, -4) + (CODE.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.equal((await verifyLicenseCode(tampered, "crisp-ripple", env({ request }))).valid, false);
  const expired = makeCode({ expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await verifyLicenseCode(expired, "crisp-ripple", env({ request }))).valid, false);
  const otherPlugin = makeCode({ features: ["crisp-mind"] });
  assert.equal((await verifyLicenseCode(otherPlugin, "crisp-ripple", env({ request }))).valid, false);
  assert.equal(calls.length, 0);
});

// 0.1.4 audit: every locally valid sibling code is offered, in scan order, so a revoked first one cannot hide the rest.
test("inheritance scan returns every locally valid sibling code in order", async () => {
  const B = makeCode({ licenseId: "TEST-B" });
  const files = {
    ".obsidian/plugins/crisp-mind/data.json": JSON.stringify({ licenseCode: CODE }),
    ".obsidian/plugins/crisp-focus/data.json": JSON.stringify({ licenseKey: B }),
    ".obsidian/plugins/crisp-pulse/data.json": JSON.stringify({ licenseCode: "garbage.sig" }),
    ".obsidian/plugins/crisp-tempo/data.json": JSON.stringify({ licenseCode: CODE }),
    ".obsidian/plugins/crisp-ripple/data.json": JSON.stringify({ licenseCode: makeCode({ licenseId: "SELF" }) }),
  };
  const app = {
    plugins: { plugins: {} },
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (p) => p === ".obsidian/plugins" || p in files,
        list: async () => ({ folders: ["crisp-mind", "crisp-focus", "crisp-pulse", "crisp-tempo", "crisp-ripple"].map((f) => `.obsidian/plugins/${f}`), files: [] }),
        read: async (p) => files[p],
      },
    },
  };
  const found = await discoverVaultCrispLicenses(app, "crisp-ripple");
  assert.deepEqual(found, [CODE, B], "duplicates, invalid codes and the plugin's own data are skipped");
});

// ---- 0.x paste normalisation: chat apps mangle codes on copy ----
const sendBody = (calls) => JSON.parse(calls[0].body);

test("line breaks, spaces, full-width spaces and zero-width characters inside a pasted code are removed", async () => {
  const mid = Math.floor(CODE.length / 2);
  for (const junk of ["\n", "\r\n", " ", "\u3000", "\u200b", "\u00a0", "\ufeff", " \n\u200b\u3000"]) {
    const messy = ` ${CODE.slice(0, mid)}${junk}${CODE.slice(mid)}\n`;
    const { request, calls } = respond(200, { valid: true });
    const res = await verifyLicenseCode(messy, "crisp-ripple", env({ request }));
    assert.equal(res.valid, true, JSON.stringify(junk));
    assert.equal(sendBody(calls).licenseCode, CODE, "the service gets the clean code");
  }
});

test("surrounding text such as a label or a trailing note is dropped", async () => {
  for (const wrapped of [`卡密：${CODE}。`, `${CODE}\n复制卡密发送给买家`, `激活码: ${CODE}\n谢谢`]) {
    const { request, calls } = respond(200, { valid: true });
    const res = await verifyLicenseCode(wrapped, "crisp-ripple", env({ request }));
    assert.equal(res.valid, true, wrapped);
    assert.equal(sendBody(calls).licenseCode, CODE);
  }
});

test("garbage and empty input stay invalid with the same reasons", async () => {
  const { request, calls } = respond(200, { valid: true });
  assert.deepEqual(await verifyLicenseCode("", "crisp-ripple", env({ request })), { valid: false, reason: "授权码为空" });
  assert.deepEqual(await verifyLicenseCode(" \n\u3000", "crisp-ripple", env({ request })), { valid: false, reason: "授权码为空" });
  assert.deepEqual(await verifyLicenseCode("not a license", "crisp-ripple", env({ request })), { valid: false, reason: "授权码格式无效（必须包含 payload 与签名）" });
  assert.equal((await verifyLicenseCode("aaa.bbb", "crisp-ripple", env({ request }))).valid, false);
  assert.equal(calls.length, 0);
});

test("a clean code is left exactly as it is", async () => {
  assert.equal(normalizeLicenseCode(CODE), CODE);
  assert.equal(normalizeLicenseCode(""), "");
  assert.equal(normalizeLicenseCode(undefined), "");
  const { request, calls } = respond(200, { valid: true });
  assert.equal((await verifyLicenseCode(CODE, "crisp-ripple", env({ request }))).valid, true);
  assert.equal(sendBody(calls).licenseCode, CODE);
});

test("inheritance scan offers the clean form of a mangled sibling code", async () => {
  const files = { ".obsidian/plugins/crisp-mind/data.json": JSON.stringify({ licenseCode: `卡密：${CODE.slice(0, 30)}\n${CODE.slice(30)}。` }) };
  const app = {
    plugins: { plugins: {} },
    vault: { configDir: ".obsidian", adapter: {
      exists: async (p) => p === ".obsidian/plugins" || p in files,
      list: async () => ({ folders: [".obsidian/plugins/crisp-mind"], files: [] }),
      read: async (p) => files[p],
    } },
  };
  assert.deepEqual(await discoverVaultCrispLicenses(app, "crisp-ripple"), [CODE]);
});

// ---- WebCrypto tampering (hardening) ----
// The verifier must be taken once at load and checked against an all-zero signature, so a
// console patch of crypto.subtle cannot make a forged code pass.

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const realSubtle = globalThis.crypto.subtle;
let copy = 0;
/** Loads a fresh copy of the verifier while `crypto` is the given object. */
async function loadWithCrypto(cryptoObject) {
  Object.defineProperty(globalThis, "crypto", { value: cryptoObject, configurable: true, writable: true });
  try {
    return await import(`${pathToFileURL(path.join(outDir, "license.mjs")).href}?copy=${++copy}`);
  } finally {
    Object.defineProperty(globalThis, "crypto", realCrypto);
  }
}
const forged = () => {
  const payload = b64url(JSON.stringify({ product: "Crisp Suite", licenseId: "F", userName: "x", expiresAt: "2999-01-01T00:00:00.000Z", features: ["all"] }));
  return `${payload}.${b64url(new Uint8Array(64))}`;
};

test("replacing crypto.subtle.verify after load cannot pass a forged code", async () => {
  const subtle = { importKey: realSubtle.importKey.bind(realSubtle), verify: realSubtle.verify.bind(realSubtle) };
  const lib = await loadWithCrypto({ subtle });
  assert.equal((await lib.verifyLicenseCode(CODE, "crisp-ripple", env({ online: false }))).valid, true);
  subtle.verify = async () => true;
  Object.defineProperty(globalThis, "crypto", { value: { subtle }, configurable: true, writable: true });
  try {
    assert.equal((await lib.verifyLicenseCode(forged(), "crisp-ripple", env({ online: false }))).valid, false);
  } finally {
    Object.defineProperty(globalThis, "crypto", realCrypto);
  }
});

test("a verifier that accepts everything at load is not trusted, so no code passes", async () => {
  const subtle = { importKey: realSubtle.importKey.bind(realSubtle), verify: async () => true };
  const lib = await loadWithCrypto({ subtle });
  assert.equal((await lib.verifyLicenseCode(forged(), "crisp-ripple", env({ online: false }))).valid, false);
  assert.equal((await lib.verifyLicenseCode(CODE, "crisp-ripple", env({ online: false }))).valid, false);
});
