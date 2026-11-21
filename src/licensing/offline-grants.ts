import type { Env } from "../types";
import { encodePayloadBase64, signLicensePayload } from "./signer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PERPETUAL_STORAGE_EXPIRY = "9999-12-31T23:59:59.999Z";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch { return null; }
}
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 4096) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 4096) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function createDeviceChallenge(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (!UUID_RE.test(deviceId)) return fail("DEVICE_NOT_LINKED", "الجهاز غير مرتبط بترخيص صالح.", 404);
  const body = await parseBody(request);
  const licenseId = body?.license_id;
  if (typeof licenseId !== "string" || !UUID_RE.test(licenseId) || body?.purpose !== "offline_grant") {
    return fail("INVALID_CHALLENGE_REQUEST", "بيانات تحدي تصريح العمل دون اتصال غير صالحة.", 422);
  }

  const row = await env.DB.prepare(
    `SELECT l.id, l.device_id, l.status AS license_status, l.ends_at,
            s.plan_key, s.status AS subscription_status, s.ends_at AS subscription_ends_at,
            d.status AS device_status
     FROM licenses l
     JOIN subscriptions s ON s.id = l.subscription_id
     JOIN devices d ON d.id = l.device_id
     WHERE l.id = ? AND l.device_id = ? LIMIT 1`
  ).bind(licenseId, deviceId).first<{
    id: string; device_id: string; license_status: string; ends_at: string | null;
    plan_key: string; subscription_status: string; subscription_ends_at: string | null;
    device_status: string;
  }>();

  if (!row || row.license_status !== "active" || row.device_status !== "active") {
    return fail("DEVICE_NOT_LINKED", "الجهاز أو الترخيص غير نشط.", 403);
  }
  if (row.plan_key === "lifetime") {
    if (row.subscription_status !== "active") return fail("ACCOUNT_INACTIVE", "الاشتراك الدائم موقوف.", 403);
  } else {
    const end = row.subscription_ends_at ? Date.parse(row.subscription_ends_at) : Number.NaN;
    const graceEnd = end + 7 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(end) || Date.now() > graceEnd ||
        !["active", "expired"].includes(row.subscription_status)) {
      return fail("ACCOUNT_INACTIVE", "انتهت صلاحية الاشتراك ومهلة القراءة والتصدير.", 403);
    }
  }

  const challengeId = crypto.randomUUID();
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO device_challenges
     (id, device_id, license_id, purpose, nonce, expires_at, created_at)
     VALUES (?, ?, ?, 'offline_grant', ?, ?, ?)`
  ).bind(challengeId, deviceId, licenseId, nonce, expiresAt, now).run();

  return json({ challenge_id: challengeId, nonce, expires_at: expiresAt }, 201);
}

export async function issueOfflineGrant(
  request: Request,
  env: Env,
  licenseId: string,
  deviceId: string,
): Promise<Response> {
  if (!UUID_RE.test(licenseId) || !UUID_RE.test(deviceId)) {
    return fail("DEVICE_NOT_LINKED", "الجهاز أو الترخيص غير موجود.", 404);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const challengeId = body?.challenge_id;
  const nonceText = body?.nonce;
  const signatureText = body?.signature;
  if (typeof challengeId !== "string" || !UUID_RE.test(challengeId) ||
      typeof nonceText !== "string" || typeof signatureText !== "string") {
    return fail("INVALID_OFFLINE_PROOF", "بيانات إثبات تجديد التصريح غير صالحة.", 422);
  }

  const row = await env.DB.prepare(
    `SELECT dc.id AS challenge_id, dc.nonce, dc.expires_at, dc.consumed_at,
            d.public_key_raw_b64url, d.status AS device_status,
            l.status AS license_status, l.payload_b64,
            s.status AS subscription_status, s.plan_key, s.ends_at AS subscription_ends_at
     FROM device_challenges dc
     JOIN devices d ON d.id = dc.device_id
     JOIN licenses l ON l.id = dc.license_id
     JOIN subscriptions s ON s.id = l.subscription_id
     WHERE dc.id = ? AND dc.license_id = ? AND dc.device_id = ?
       AND dc.purpose = 'offline_grant'
     LIMIT 1`
  ).bind(challengeId, licenseId, deviceId).first<{
    challenge_id: string; nonce: string; expires_at: string; consumed_at: string | null;
    public_key_raw_b64url: string; device_status: string; license_status: string;
    payload_b64: string; subscription_status: string; plan_key: string; subscription_ends_at: string | null;
  }>();

  if (!row || row.consumed_at || row.nonce !== nonceText || Date.parse(row.expires_at) <= Date.now()) {
    return fail("CHALLENGE_INVALID_OR_EXPIRED", "انتهت صلاحية تحدي الجهاز أو سبق استخدامه.", 410);
  }
  if (row.device_status !== "active" || row.license_status !== "active") {
    return fail("LICENSE_REVOKED", "الجهاز أو الترخيص موقوف.", 403);
  }
  if (row.plan_key === "lifetime") {
    if (row.subscription_status !== "active") return fail("ACCOUNT_INACTIVE", "الاشتراك الدائم موقوف.", 403);
  } else {
    const end = row.subscription_ends_at ? Date.parse(row.subscription_ends_at) : Number.NaN;
    if (!Number.isFinite(end) || Date.now() > end + 7 * 24 * 60 * 60 * 1000 ||
        !["active", "expired"].includes(row.subscription_status)) {
      return fail("ACCOUNT_INACTIVE", "انتهت صلاحية الاشتراك ومهلة القراءة والتصدير.", 403);
    }
  }

  const publicKey = decodeBase64Url(row.public_key_raw_b64url);
  const nonce = decodeBase64Url(nonceText);
  const signature = decodeBase64Url(signatureText);
  if (!publicKey || publicKey.length !== 32 || !nonce || nonce.length !== 32 ||
      !signature || signature.length !== 64) {
    return fail("INVALID_OFFLINE_PROOF", "توقيع الجهاز غير صالح.", 422);
  }
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, signature, nonce);
    if (!valid) return fail("DEVICE_PROOF_INVALID", "تعذر إثبات ملكية الجهاز.", 403);
  } catch {
    return fail("DEVICE_PROOF_INVALID", "تعذر التحقق من توقيع الجهاز.", 403);
  }

  let originalClaims: Record<string, unknown>;
  try {
    originalClaims = JSON.parse(new TextDecoder().decode(decodeBase64(row.payload_b64))) as Record<string, unknown>;
  } catch {
    return fail("LICENSE_INVALID", "بيانات الترخيص المخزنة غير صالحة.", 500);
  }

  const now = new Date().toISOString();
  const grantId = crypto.randomUUID();
  const perpetual = row.plan_key === "lifetime";
  const expiresAt = perpetual
    ? PERPETUAL_STORAGE_EXPIRY
    : String(originalClaims.grace_ends_at ?? "");
  if (!perpetual && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)))) {
    return fail("LICENSE_INVALID", "بيانات مهلة الترخيص غير صالحة.", 500);
  }

  let signed: { keyId: string; signatureB64: string };
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = new TextEncoder().encode(JSON.stringify({
      ...originalClaims,
      grant_id: grantId,
      issued_at: now,
      key_id: env.LICENSE_SIGNING_KEY_ID,
      expires_at: perpetual ? null : expiresAt,
    }));
    signed = await signLicensePayload(env, payloadBytes);
    if (signed.keyId !== env.LICENSE_SIGNING_KEY_ID) {
      return fail("LICENSE_SIGNING_UNAVAILABLE", "معرف مفتاح التوقيع غير متطابق.", 503);
    }
  } catch {
    return fail("LICENSE_SIGNING_UNAVAILABLE", "خدمة توقيع التصاريح غير مهيأة.", 503);
  }

  const payloadB64 = encodePayloadBase64(payloadBytes);
  const nowIso = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE device_challenges SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
    ).bind(nowIso, challengeId, nowIso),
    env.DB.prepare(
      `INSERT INTO offline_grants
       (id, license_id, device_id, key_id, payload_b64, signature_b64, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM device_challenges
         WHERE id = ? AND consumed_at = ?
       )`
    ).bind(grantId, licenseId, deviceId, signed.keyId, payloadB64, signed.signatureB64,
      expiresAt, nowIso, challengeId, nowIso),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return fail("CHALLENGE_INVALID_OR_EXPIRED", "انتهت صلاحية التحدي أو سبق استخدامه.", 410);
  }
  return json({ key_id: signed.keyId, payload: payloadB64, signature: signed.signatureB64 }, 201);
}
