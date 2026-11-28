import type { Env } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const ALLOWED_PLATFORMS = new Set(["android", "windows", "linux"]);

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(code: string, message: string, status: number, headers: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
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

interface TrialRegistrationRow {
  id: string;
  device_id: string;
  key_fingerprint: string;
  trial_started_at: string;
  trial_ends_at: string;
  first_seen_at: string;
}

export async function registerTrial(
  request: Request,
  env: Env,
  headers: HeadersInit,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("INVALID_JSON", "جسم طلب تسجيل التجربة غير صالح أو يتجاوز الحجم المسموح.", 400, headers);

  const productKey = body.product_key;
  const deviceId = body.device_id;
  const platform = body.platform_key;
  const architecture = body.architecture_key;
  const publicKeyText = body.public_key;
  const fingerprintText = body.key_fingerprint;
  const trialStartedText = body.trial_started_at;
  const signatureText = body.signature;

  if (productKey !== "homi-grocery" ||
      typeof deviceId !== "string" || !UUID_RE.test(deviceId) ||
      typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform) ||
      typeof architecture !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
      typeof publicKeyText !== "string" ||
      typeof fingerprintText !== "string" || !FINGERPRINT_RE.test(fingerprintText) ||
      typeof trialStartedText !== "string" ||
      typeof signatureText !== "string") {
    return fail("INVALID_TRIAL_REGISTRATION", "بيانات تسجيل الفترة التجريبية غير مكتملة أو غير صالحة.", 422, headers);
  }

  const trialStartedMs = Date.parse(trialStartedText);
  const nowMs = Date.now();
  if (!Number.isFinite(trialStartedMs) || trialStartedMs > nowMs + 5 * 60 * 1000) {
    return fail("INVALID_TRIAL_START", "تاريخ بدء الفترة التجريبية غير صالح.", 422, headers);
  }
  const publicKey = decodeBase64Url(publicKeyText);
  const signature = decodeBase64Url(signatureText);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) {
    return fail("INVALID_TRIAL_PROOF", "مفتاح الجهاز أو توقيع تسجيل التجربة غير صالح.", 422, headers);
  }

  const fingerprint = hex(await sha256(publicKey));
  if (fingerprint !== fingerprintText) {
    return fail("DEVICE_FINGERPRINT_MISMATCH", "بصمة الجهاز لا تطابق المفتاح العام المرسل.", 422, headers);
  }

  const normalizedStart = new Date(trialStartedMs).toISOString();
  const proofMessage = [
    "HOMI_TRIAL_REGISTRATION_V1",
    deviceId.toLowerCase(),
    productKey,
    platform,
    architecture,
    fingerprint,
    normalizedStart,
  ].join("\n");

  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(proofMessage),
    );
    if (!valid) return fail("DEVICE_PROOF_INVALID", "تعذر إثبات امتلاك مفتاح الجهاز.", 403, headers);
  } catch {
    return fail("DEVICE_PROOF_INVALID", "تعذر التحقق من توقيع الجهاز.", 403, headers);
  }

  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE product_key = ? AND is_active = 1",
  ).bind(productKey).first<{ id: string }>();
  if (!product) return fail("PRODUCT_UNAVAILABLE", "التطبيق غير متاح لتسجيل التجربة حاليًا.", 404, headers);

  const now = new Date(nowMs).toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, device_id, key_fingerprint, trial_started_at, trial_ends_at, first_seen_at
     FROM trial_registrations
     WHERE product_id = ? AND (key_fingerprint = ? OR device_id = ?)
     ORDER BY first_seen_at ASC LIMIT 1`,
  ).bind(product.id, fingerprint, deviceId).first<TrialRegistrationRow>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE trial_registrations SET last_seen_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, existing.id).run();
    return json({
      registration_status: "already_registered",
      identity_match: existing.key_fingerprint === fingerprint ? "key_fingerprint" : "device_id",
      trial_started_at: existing.trial_started_at,
      trial_ends_at: existing.trial_ends_at,
      first_seen_at: existing.first_seen_at,
      server_seen_at: now,
    }, 200, headers);
  }

  const id = crypto.randomUUID();
  const trialEndsAt = new Date(trialStartedMs + TRIAL_DURATION_MS).toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO trial_registrations
     (id, product_id, device_id, platform_key, architecture_key, public_key_raw_b64url,
      key_fingerprint, trial_started_at, trial_ends_at, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, product.id, deviceId, platform, architecture, publicKeyText,
    fingerprint, normalizedStart, trialEndsAt, now, now, now, now,
  ).run();

  const registered = await env.DB.prepare(
    `SELECT id, device_id, key_fingerprint, trial_started_at, trial_ends_at, first_seen_at
     FROM trial_registrations
     WHERE product_id = ? AND (key_fingerprint = ? OR device_id = ?)
     ORDER BY first_seen_at ASC LIMIT 1`,
  ).bind(product.id, fingerprint, deviceId).first<TrialRegistrationRow>();

  if (!registered) return fail("TRIAL_REGISTRATION_FAILED", "تعذر حفظ تسجيل الفترة التجريبية.", 503, headers);
  if (registered.id !== id) {
    await env.DB.prepare(
      "UPDATE trial_registrations SET last_seen_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, registered.id).run();
  }

  return json({
    registration_status: registered.id === id ? "registered" : "already_registered",
    identity_match: registered.key_fingerprint === fingerprint ? "key_fingerprint" : "device_id",
    trial_started_at: registered.trial_started_at,
    trial_ends_at: registered.trial_ends_at,
    first_seen_at: registered.first_seen_at,
    server_seen_at: now,
  }, registered.id === id ? 201 : 200, headers);
}
