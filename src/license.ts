import { requestUrl } from "obsidian";

export interface LicensePayload {
  product: string;
  licenseId: string;
  userName: string;
  expiresAt: string;
  maxDevices?: number;
  features: string[];
  issuedAt?: string;
}

export interface LicenseVerifyResult {
  valid: boolean;
  reason?: string;
  payload?: LicensePayload;
  message?: string;
  source?: "online" | "offline" | "local";
}

export interface LicenseRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Obsidian's requestUrl throws on 4xx by default; a denial must arrive as a response. */
  throw: false;
}

export interface LicenseCheckEnvironment {
  /** Online device-count check; defaults to Obsidian requestUrl. Tests can inject a mock. */
  request?(input: LicenseRequestInput): Promise<{ status: number; json?: unknown }>;
  now?(): number;
  getDeviceId?(): string;
  online?: boolean;
  /** Upper bound for the online check before falling back to the local signature. */
  timeoutMs?: number;
}

interface CloudVerdict {
  valid?: boolean;
  reason?: string;
  message?: string;
}

const WORKER_VERIFY_URL = "https://license.letschips.xyz/api/verify-device";
const ONLINE_CHECK_TIMEOUT_MS = 2500;

/** Rejects after `ms` so a hung request cannot keep the activation button spinning. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Crisp license check timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Crisp 系列全家桶通用 Ed25519 嵌入公钥（仅公开验证材料，无任何私钥）
export const CRISP_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiz41HIDpD59SH3DjKnovUO+EEhTJXjvmiug/ev9t4ZQ=
-----END PUBLIC KEY-----`;

export const CRISP_FAMILY_PRODUCTS = [
  "Crisp Suite",
  "Crisp Tempo",
  "Crisp Mind",
  "Crisp Pulse",
  "Crisp Organize",
  "Crisp ASR",
  "Crisp Annotations",
  "Crisp File Explorer",
  "Crisp Focus",
  "Crisp Reading Rail",
  "Crisp Base",
  "Crisp Visual",
  "Crisp Ripple",
] as const;

export const CRISP_SIBLING_PLUGIN_IDS = [
  "crisp-mind",
  "crisp-pulse",
  "crisp-focus",
  "crisp-file-explorer",
  "crisp-base",
  "crisp-recall",
  "crisp-annotations",
  "crisp-reading-rail",
  "crisp-asr",
  "crisp-visual",
  "crisp-organize",
  "crisp-tempo",
  "crisp-ripple",
] as const;

export function base64UrlToUint8Array(base64url: string): Uint8Array {
  const base64 = (base64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  const decodeFn =
    typeof atob === "function"
      ? atob
      : (b64: string) =>
          typeof Buffer !== "undefined"
            ? Buffer.from(b64, "base64").toString("binary")
            : "";
  const raw = decodeFn(padded);
  const buffer = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    buffer[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function subtleCrypto(): SubtleCrypto | undefined {
  const globalCrypto = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (globalCrypto?.subtle) return globalCrypto.subtle;
  if (typeof window !== "undefined" && window.crypto?.subtle) return window.crypto.subtle;
  return undefined;
}

export async function importEd25519PublicKey(pem: string): Promise<CryptoKey> {
  const subtle = subtleCrypto();
  if (!subtle) throw new Error("WebCrypto 在当前运行环境不可用");
  const pemContents = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const der = base64UrlToUint8Array(pemContents);
  const derArrayBuffer = der.buffer.slice(
    der.byteOffset,
    der.byteOffset + der.byteLength,
  ) as ArrayBuffer;
  return await subtle.importKey(
    "spki",
    derArrayBuffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

function defaultDeviceId(): string {
  const app = (window as unknown as { app?: { appId?: string; vault?: { getName(): string } } }).app;
  if (app?.appId) return app.appId;
  if (app?.vault?.getName) return `vault-${encodeURIComponent(app.vault.getName())}`;
  return "device-default";
}

/**
 * 本地 Ed25519 验签 + 在线设备数限制校验（离线时降级为本地验签）。
 */
export async function verifyLicenseCode(
  licenseCode: string,
  targetPluginIdOrEnvironment: string | LicenseCheckEnvironment = "crisp-ripple",
  maybeEnvironment?: LicenseCheckEnvironment,
): Promise<LicenseVerifyResult> {
  const targetPluginId =
    typeof targetPluginIdOrEnvironment === "string"
      ? targetPluginIdOrEnvironment
      : "crisp-ripple";
  const environment =
    typeof targetPluginIdOrEnvironment === "object"
      ? targetPluginIdOrEnvironment
      : maybeEnvironment;

  const now = environment?.now?.() ?? Date.now();
  const request =
    environment?.request ??
    (typeof requestUrl === "function"
      ? (input: LicenseRequestInput) => requestUrl(input)
      : undefined);
  const getDeviceId = environment?.getDeviceId ?? defaultDeviceId;
  const isOnlineCheckAllowed = environment?.online !== false;

  const trimmed = (licenseCode || "").trim();
  if (!trimmed) {
    return { valid: false, reason: "授权码为空" };
  }

  const parts = trimmed.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "授权码格式无效（必须包含 payload 与签名）" };
  }

  const [payloadBase64, signatureBase64] = parts;

  try {
    let payloadJson: string;
    try {
      payloadJson = new TextDecoder().decode(base64UrlToUint8Array(payloadBase64));
    } catch {
      return { valid: false, reason: "无法解码授权载荷数据" };
    }

    const payload = JSON.parse(payloadJson) as LicensePayload;
    if (!payload || typeof payload !== "object") {
      return { valid: false, reason: "授权载荷格式不正确" };
    }

    if (!CRISP_FAMILY_PRODUCTS.includes(payload.product as (typeof CRISP_FAMILY_PRODUCTS)[number])) {
      return { valid: false, reason: "授权码不属于 Crisp 系列插件" };
    }

    const features = Array.isArray(payload.features) ? payload.features : [];
    const hasFeaturePermission =
      features.includes("all") || features.includes(targetPluginId);
    if (!hasFeaturePermission) {
      return { valid: false, reason: `该授权码未包含 ${targetPluginId} 权限` };
    }

    if (payload.expiresAt) {
      const expireTime = new Date(payload.expiresAt).getTime();
      if (Number.isFinite(expireTime) && now > expireTime) {
        const formattedDate = String(payload.expiresAt).split("T")[0];
        return { valid: false, reason: `授权已于 ${formattedDate} 到期` };
      }
    }

    const signature = base64UrlToUint8Array(signatureBase64);
    const signatureArrayBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer;
    const dataBytes = new TextEncoder().encode(payloadBase64);
    const dataArrayBuffer = dataBytes.buffer.slice(
      dataBytes.byteOffset,
      dataBytes.byteOffset + dataBytes.byteLength,
    ) as ArrayBuffer;

    const publicKey = await importEd25519PublicKey(CRISP_PUBLIC_KEY_PEM);
    const subtle = subtleCrypto();
    if (!subtle) {
      return { valid: false, reason: "WebCrypto 在当前运行环境不可用" };
    }

    const isSignatureValid = await subtle.verify(
      "Ed25519",
      publicKey,
      signatureArrayBuffer,
      dataArrayBuffer,
    );

    if (!isSignatureValid) {
      return { valid: false, reason: "授权签名无效或已被篡改" };
    }

    // 本地校验已完全通过，如不要求在线核验则直接返回
    if (!isOnlineCheckAllowed) {
      return { valid: true, payload, source: "local", message: "本地签名校验通过" };
    }

    // 在线核验吊销与设备数。只有服务端才知道这两件事，所以它明确给出的拒绝必须生效：
    // 200/400/401/403 且 valid:false 判为拒绝（与其他 Crisp 插件一致）。
    // 5xx、无法解析的响应、网络错误和超时仍降级为本地验签，服务不可用时不影响使用。
    if (request) {
      try {
        const res = await withTimeout(
          request({
            url: WORKER_VERIFY_URL,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              licenseCode: trimmed,
              deviceId: getDeviceId(),
              action: "activate",
              pluginId: targetPluginId,
            }),
            throw: false,
          }),
          environment?.timeoutMs ?? ONLINE_CHECK_TIMEOUT_MS,
        );

        let cloudResult: CloudVerdict | null = null;
        try {
          // requestUrl's json getter throws when the body is not JSON.
          const body = res.json;
          cloudResult = body && typeof body === "object" ? (body as CloudVerdict) : null;
        } catch {
          cloudResult = null;
        }

        const isAuthDenial =
          [200, 400, 401, 403].includes(res.status) && cloudResult?.valid === false;
        if (isAuthDenial) {
          return {
            valid: false,
            reason: cloudResult?.reason || "授权已被服务端拒绝或设备数已达上限",
          };
        }

        if (res.status === 200 && cloudResult?.valid === true) {
          return {
            valid: true,
            payload,
            source: "online",
            message: cloudResult.message,
          };
        }
      } catch {
        // 离线时降级为本地验签（签名已在前面通过 Ed25519 本地校验）
        console.debug("Crisp Ripple license online check offline fallback");
        return {
          valid: true,
          payload,
          source: "offline",
          message: "离线验证成功（本地密码学验签通过）",
        };
      }
    }

    return { valid: true, payload, source: "local" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `解析授权码失败: ${msg}` };
  }
}

/**
 * 自动扫描库内其他 Crisp 插件并继承有效授权
 */
export async function discoverVaultCrispLicenses(
  app: any,
  targetPluginId = "crisp-ripple",
  limit = 5,
): Promise<string[]> {
  if (!app) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (code: unknown) => {
    if (typeof code !== "string") return;
    const trimmed = code.trim();
    if (!trimmed.includes(".") || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  // 1. 已加载插件（内存配置）
  for (const pid of CRISP_SIBLING_PLUGIN_IDS) {
    if (pid === targetPluginId) continue;
    const p = app.plugins?.plugins?.[pid];
    if (p?.settings?.licenseCode) add(p.settings.licenseCode);
    if (p?.settings?.licenseKey) add(p.settings.licenseKey);
    if (p?.data?.licenseCode) add(p.data.licenseCode);
    if (p?.data?.licenseKey) add(p.data.licenseKey);
  }

  // 2. 磁盘上其他 crisp-* 插件目录下的 data.json
  try {
    const adapter = app.vault?.adapter;
    if (adapter && typeof adapter.list === "function") {
      // Vaults can rename .obsidian; plugin code must follow the configured directory.
      const pluginsDir = `${app.vault?.configDir || ".obsidian"}/plugins`;
      if (await adapter.exists(pluginsDir)) {
        const listing = await adapter.list(pluginsDir);
        for (const folder of listing.folders || []) {
          const folderName = folder.split("/").pop() || "";
          if (!folderName.startsWith("crisp-") || folderName === targetPluginId) {
            continue;
          }
          const dataPath = `${folder}/data.json`;
          if (await adapter.exists(dataPath)) {
            try {
              const text = await adapter.read(dataPath);
              const data = JSON.parse(text);
              add(data?.licenseCode || data?.licenseKey || data?.license);
            } catch {
              // 忽略损坏的单文件
            }
          }
        }
      }
    }
  } catch (err) {
    console.debug("Crisp Ripple discoverVaultCrispLicenses adapter scan error:", err);
  }

  // 本地离线校验候选码（避免批量请求 worker）。返回全部通过的码，调用方逐个在线核对：
  // 排在前面的码在线被拒（吊销、设备上限）时，后面的有效码仍有机会。
  const valid: string[] = [];
  for (const code of candidates) {
    if (valid.length >= limit) break;
    const local = await verifyLicenseCode(code, targetPluginId, {
      online: false,
    });
    if (local.valid) valid.push(code);
  }
  return valid;
}
