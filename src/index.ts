import type { Env, ActivationRequestRow } from "./types";

const API_PREFIX = "/api/v1";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_PLATFORMS = new Set(["android", "windows", "linux"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = origin && origin === env.PUBLIC_SITE_ORIGIN ? origin : "";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, idempotency-key",
    "vary": "Origin",
  };
}

function error(code: string, message: string, status: number, headers: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return b64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function rateLimit(request: Request, env: Env, bucket: string, max: number): Promise<boolean> {
  const source = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = hex(await sha256(new TextEncoder().encode(source + ":" + bucket)));
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO api_rate_limits (bucket_key, window_start, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(bucket_key, window_start) DO UPDATE SET request_count = request_count + 1
     WHERE request_count < ?
     RETURNING request_count`
  ).bind(key, window, max).first<{ request_count: number }>();
  return row !== null;
}

async function createActivation(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  if (!(await rateLimit(request, env, "activation-create", 8))) {
    return error("RATE_LIMITED", "تم تجاوز عدد الطلبات المسموح به مؤقتًا.", 429, headers);
  }
  const body = await readJson(request);
  if (!body) return error("INVALID_JSON", "جسم الطلب غير صالح أو يتجاوز الحجم المسموح.", 400, headers);

  const productKey = body.product_key;
  const platform = body.platform_key;
  const architecture = body.architecture_key;
  const label = body.device_label;
  const publicKeyText = body.public_key;
  if (productKey !== "homi-grocery" ||
      typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform) ||
      typeof architecture !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
      typeof label !== "string" || label.length < 2 || label.length > 80 ||
      typeof publicKeyText !== "string") {
    return error("INVALID_ACTIVATION_REQUEST", "بيانات طلب التفعيل غير مكتملة أو غير صالحة.", 422, headers);
  }

  const publicKey = base64UrlDecode(publicKeyText);
  if (!publicKey || publicKey.length !== 32) {
    return error("INVALID_DEVICE_KEY", "مفتاح الجهاز العام غير صالح.", 422, headers);
  }

  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE product_key = ? AND is_active = 1"
  ).bind(productKey).first<{ id: string }>();
  if (!product) return error("PRODUCT_UNAVAILABLE", "التطبيق غير متاح لطلبات التفعيل حاليًا.", 404, headers);

  const fingerprint = hex(await sha256(publicKey));
  const existing = await env.DB.prepare(
    `SELECT id, status, challenge, challenge_expires_at
     FROM activation_requests
     WHERE product_id = ? AND key_fingerprint = ?
       AND status IN ('pending_proof', 'proof_verified', 'under_review')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(product.id, fingerprint).first<{ id: string; status: string; challenge: string; challenge_expires_at: string }>();

  if (existing && Date.parse(existing.challenge_expires_at) > Date.now()) {
    return json({
      activation_request_id: existing.id,
      challenge: existing.challenge,
      challenge_expires_at: existing.challenge_expires_at,
      key_fingerprint: fingerprint,
      status: existing.status,
      support_whatsapp: env.SUPPORT_PHONE.replace(/^\+/, ""),
    }, 200, headers);
  }

  const id = crypto.randomUUID();
  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = b64url(challengeBytes);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices
       (id, product_id, platform_key, architecture_key, device_label, public_key_raw_b64url,
        key_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(product_id, key_fingerprint) DO UPDATE SET
         platform_key = excluded.platform_key,
         architecture_key = excluded.architecture_key,
         device_label = excluded.device_label,
         updated_at = excluded.updated_at`
    ).bind(id, product.id, platform, architecture, label, publicKeyText, fingerprint, now, now),
    env.DB.prepare(
      `INSERT INTO activation_requests
       (id, product_id, platform_key, architecture_key, device_label, public_key_raw_b64url,
        key_fingerprint, challenge, challenge_expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_proof', ?, ?)`
    ).bind(id, product.id, platform, architecture, label, publicKeyText, fingerprint, challenge, expires, now, now),
  ]);

  return json({
    activation_request_id: id,
    challenge,
    challenge_expires_at: expires,
    key_fingerprint: fingerprint,
    status: "pending_proof",
    support_whatsapp: env.SUPPORT_PHONE.replace(/^\+/, ""),
  }, 201, headers);
}

async function verifyActivationProof(request: Request, env: Env, requestId: string, headers: HeadersInit): Promise<Response> {
  if (!UUID_RE.test(requestId)) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
  if (!(await rateLimit(request, env, "activation-proof", 12))) {
    return error("RATE_LIMITED", "تم تجاوز عدد محاولات إثبات الجهاز.", 429, headers);
  }
  const body = await readJson(request);
  if (!body || typeof body.challenge !== "string" || typeof body.signature !== "string") {
    return error("INVALID_PROOF", "بيانات إثبات ملكية الجهاز غير صالحة.", 422, headers);
  }

  const row = await env.DB.prepare(
    "SELECT * FROM activation_requests WHERE id = ?"
  ).bind(requestId).first<ActivationRequestRow>();
  if (!row) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
  if (row.status === "proof_verified" || row.status === "under_review" || row.status === "approved") {
    return json({ activation_request_id: requestId, proof_verified: true, status: row.status }, 200, headers);
  }
  if (row.status !== "pending_proof" || row.challenge !== body.challenge ||
      Date.parse(row.challenge_expires_at) <= Date.now()) {
    return error("CHALLENGE_INVALID_OR_EXPIRED", "انتهت صلاحية تحدي إثبات الجهاز أو لم يعد صالحًا.", 410, headers);
  }

  const publicKey = base64UrlDecode(row.public_key_raw_b64url);
  const signature = base64UrlDecode(body.signature);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) {
    return error("INVALID_PROOF", "توقيع إثبات الجهاز غير صالح.", 422, headers);
  }

  const proofMessage = [
    "HOMI_DEVICE_PROOF_V1",
    requestId.toLowerCase(),
    "homi-grocery",
    row.platform_key,
    row.architecture_key,
    row.challenge,
  ].join("\n");
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(proofMessage));
    if (!valid) return error("DEVICE_PROOF_INVALID", "تعذر إثبات ملكية هذا الجهاز.", 403, headers);
  } catch {
    return error("DEVICE_PROOF_INVALID", "تعذر التحقق من توقيع الجهاز.", 403, headers);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE activation_requests SET status = 'proof_verified', proof_verified_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending_proof'`
  ).bind(now, now, requestId).run();

  return json({ activation_request_id: requestId, proof_verified: true, status: "proof_verified" }, 200, headers);
}

async function activationStatus(env: Env, requestId: string, headers: HeadersInit): Promise<Response> {
  if (!UUID_RE.test(requestId)) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
  const row = await env.DB.prepare(
    `SELECT ar.status, l.id AS license_id, l.device_id, l.key_id, l.status AS license_status,
            l.payload_b64, l.signature_b64
     FROM activation_requests ar
     LEFT JOIN devices d ON d.product_id = ar.product_id AND d.key_fingerprint = ar.key_fingerprint
     LEFT JOIN licenses l ON l.device_id = d.id AND l.status = 'active'
     WHERE ar.id = ? ORDER BY l.issued_at DESC LIMIT 1`
  ).bind(requestId).first<{
    status: string; license_id: string | null; device_id: string | null; key_id: string | null;
    license_status: string | null; payload_b64: string | null; signature_b64: string | null;
  }>();
  if (!row) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
  if (row.license_id && row.device_id && row.key_id && row.payload_b64 && row.signature_b64) {
    return json({
      status: "approved",
      license: {
        id: row.license_id,
        device_id: row.device_id,
        key_id: row.key_id,
        status: row.license_status,
        payload: row.payload_b64,
        signature: row.signature_b64,
      },
    }, 200, headers);
  }
  return json({ status: row.status }, 200, headers);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "homi-platform-api", environment: env.APP_ENV }, 200, headers);
    }
    if (!url.pathname.startsWith(API_PREFIX)) return error("NOT_FOUND", "المسار غير موجود.", 404, headers);

    const path = url.pathname.slice(API_PREFIX.length);
    if (request.method === "POST" && path === "/public/activation-requests") {
      return createActivation(request, env, headers);
    }
    const proofMatch = path.match(/^\/public\/activation-requests\/([^/]+)\/proof$/);
    if (request.method === "POST" && proofMatch) {
      return verifyActivationProof(request, env, proofMatch[1], headers);
    }
    const statusMatch = path.match(/^\/public\/activation-requests\/([^/]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      return activationStatus(env, statusMatch[1], headers);
    }
    return error("NOT_FOUND", "المسار غير موجود.", 404, headers);
  },
};
