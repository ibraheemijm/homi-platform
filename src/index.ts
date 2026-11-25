import type { Env, ActivationRequestRow } from "./types";
import { getStorage } from "./storage/backblaze";
import { authenticateAdmin } from "./security/access";
import { approveActivationRequest } from "./licensing/issue";
import { createDeviceChallenge, issueOfflineGrant } from "./licensing/offline-grants";
import { importHreq } from "./activation/hreq";
import { registerTrial } from "./activation/trials";
import { submitPaymentEvidence } from "./payments/submissions";
import { handleReleaseAdmin } from "./releases/admin";
import { createSignedSigningKeyset } from "./licensing/keyset";
import { inspectSigningKeyConfiguration } from "./licensing/signer";
import { isStorageConfigured } from "./storage/backblaze";
import { handleCustomerAdmin } from "./admin/customers";
import { handleSubscriptionRenewal } from "./admin/renewals";

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

function isPagesPreviewOrigin(
  origin: string,
  projectHost: string,
  stableHost: string,
): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin ||
        url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash) return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === stableHost) return true;
    const suffix = "." + projectHost;
    if (!hostname.endsWith(suffix)) return false;
    const deploymentLabel = hostname.slice(0, -suffix.length);
    // Cloudflare Pages deploy previews use one hostname label before the project domain.
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(deploymentLabel);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowedOrigins = [env.PUBLIC_SITE_ORIGIN, env.ADMIN_SITE_ORIGIN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const isAllowedPreviewOrigin = origin !== null && (
    isPagesPreviewOrigin(
      origin,
      "homi-public-preview.pages.dev",
      "foundation-public-site-v1.homi-public-preview.pages.dev",
    ) ||
    isPagesPreviewOrigin(
      origin,
      "homi-admin-console-preview.pages.dev",
      "foundation-platform-api-v1.homi-admin-console-preview.pages.dev",
    )
  );
  const allowed = origin && (allowedOrigins.includes(origin) || isAllowedPreviewOrigin)
    ? origin
    : "";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, idempotency-key",
    "vary": "Origin",
  };
}

function error(code: string, message: string, status: number, headers: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

function withHeaders(response: Response, extra: HeadersInit): Response {
  const merged = new Headers(response.headers);
  new Headers(extra).forEach((value, key) => merged.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
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
  const requestedDeviceId = body.device_id;
  const customerName = body.customer_name === undefined || body.customer_name === null
    ? null : typeof body.customer_name === "string" ? body.customer_name.trim() : "";
  const customerPhone = body.customer_phone === undefined || body.customer_phone === null
    ? null : typeof body.customer_phone === "string" ? body.customer_phone.trim() : "";
  const requestedPlan = body.requested_plan === undefined || body.requested_plan === null
    ? null : body.requested_plan;
  const customerNotes = body.customer_notes === undefined || body.customer_notes === null
    ? null : typeof body.customer_notes === "string" ? body.customer_notes.trim() : "";
  if (productKey !== "homi-grocery" ||
      typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform) ||
      typeof architecture !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
      typeof label !== "string" || label.length < 2 || label.length > 80 ||
      typeof publicKeyText !== "string" ||
      (requestedDeviceId !== undefined && (typeof requestedDeviceId !== "string" || !UUID_RE.test(requestedDeviceId))) ||
      (customerName !== null && (customerName.length < 2 || customerName.length > 120)) ||
      (customerPhone !== null && !/^\+[1-9][0-9]{7,14}$/.test(customerPhone)) ||
      (requestedPlan !== null && (typeof requestedPlan !== "string" || !["monthly", "annual", "lifetime"].includes(requestedPlan))) ||
      (customerNotes !== null && customerNotes.length > 500)) {
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
  const deviceId = typeof requestedDeviceId === "string" ? requestedDeviceId : id;
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
    ).bind(deviceId, product.id, platform, architecture, label, publicKeyText, fingerprint, now, now),
    env.DB.prepare(
      `INSERT INTO activation_requests
       (id, product_id, platform_key, architecture_key, device_label, public_key_raw_b64url,
        key_fingerprint, challenge, challenge_expires_at, status, customer_name_snapshot,
        customer_phone_snapshot, requested_plan, customer_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_proof', ?, ?, ?, ?, ?, ?)`
    ).bind(id, product.id, platform, architecture, label, publicKeyText, fingerprint,
      challenge, expires, customerName, customerPhone, requestedPlan, customerNotes, now, now),
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
    `SELECT ar.status, ar.challenge_expires_at,
            l.id AS license_id, l.device_id, l.key_id, l.status AS license_status,
            l.payload_b64, l.signature_b64,
            (SELECT ps.id FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_submission_id,
            (SELECT ps.status FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_status,
            (SELECT ps.method FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_method,
            (SELECT ps.amount_minor FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_amount_minor,
            (SELECT ps.currency FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_currency,
            (SELECT CASE WHEN ps.proof_object_key IS NOT NULL THEN 1 ELSE 0 END FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS has_payment_proof
     FROM activation_requests ar
     LEFT JOIN devices d ON d.product_id = ar.product_id AND d.key_fingerprint = ar.key_fingerprint
     LEFT JOIN licenses l ON l.device_id = d.id AND l.status = 'active'
     WHERE ar.id = ? ORDER BY l.issued_at DESC LIMIT 1`
  ).bind(requestId).first<{
    status: string; challenge_expires_at: string;
    license_id: string | null; device_id: string | null; key_id: string | null;
    license_status: string | null; payload_b64: string | null; signature_b64: string | null;
    payment_submission_id: string | null; payment_status: string | null; payment_method: string | null;
    payment_amount_minor: number | null; payment_currency: string | null; has_payment_proof: number | null;
  }>();
  if (!row) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
  if (row.status === "pending_proof" && Date.parse(row.challenge_expires_at) <= Date.now()) {
    await env.DB.prepare(
      "UPDATE activation_requests SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_proof'"
    ).bind(new Date().toISOString(), requestId).run();
    return json({ status: "expired" }, 200, headers);
  }
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
      payment_submission: row.payment_submission_id ? {
        id: row.payment_submission_id,
        status: row.payment_status,
        method: row.payment_method,
        amount_minor: row.payment_amount_minor,
        currency: row.payment_currency,
        has_proof: Boolean(row.has_payment_proof),
      } : null,
    }, 200, headers);
  }
  return json({
    status: row.status,
    payment_submission: row.payment_submission_id ? {
      id: row.payment_submission_id,
      status: row.payment_status,
      method: row.payment_method,
      amount_minor: row.payment_amount_minor,
      currency: row.payment_currency,
      has_proof: Boolean(row.has_payment_proof),
    } : null,
  }, 200, headers);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = corsHeaders(request, env);
    const storage = getStorage(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "homi-platform-api", environment: env.APP_ENV }, 200, headers);
    }
    if (!url.pathname.startsWith(API_PREFIX)) return error("NOT_FOUND", "المسار غير موجود.", 404, headers);

    const path = url.pathname.slice(API_PREFIX.length);

    if (request.method === "GET" && path === "/signing-keyset") {
      try {
        const keyset = await createSignedSigningKeyset(env);
        return json(keyset, 200, { ...headers, "cache-control": "public, max-age=300" });
      } catch {
        return error("SIGNING_KEYSET_UNAVAILABLE", "مفاتيح التحقق الموثوقة غير مهيأة لهذه البيئة.", 503, headers);
      }
    }

    const releaseAdminResponse = await handleReleaseAdmin(request, env, path, headers);
    if (releaseAdminResponse) return withHeaders(releaseAdminResponse, headers);

    const renewalResponse = await handleSubscriptionRenewal(request, env, path);
    if (renewalResponse) return withHeaders(renewalResponse, headers);

    const customerAdminResponse = await handleCustomerAdmin(request, env, path, url);
    if (customerAdminResponse) return withHeaders(customerAdminResponse, headers);

    if (request.method === "GET" && path === "/admin/system/signing-status") {
      const auth = await authenticateAdmin(request, env, ["licenses.issue"]);
      if (auth.response) return withHeaders(auth.response, headers);
      const [license, update, root] = await Promise.all([
        inspectSigningKeyConfiguration(
          env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64,
          env.LICENSE_SIGNING_KEY_ID,
          env.LICENSE_SIGNING_PUBLIC_KEY_DER_B64,
        ),
        inspectSigningKeyConfiguration(
          env.UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64,
          env.UPDATE_SIGNING_KEY_ID,
          env.UPDATE_SIGNING_PUBLIC_KEY_DER_B64,
        ),
        inspectSigningKeyConfiguration(
          env.ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64,
          env.ROOT_SIGNING_KEY_ID,
        ),
      ]);
      return json({
        environment: env.APP_ENV,
        license_signing: license,
        update_signing: update,
        root_signing: root,
        file_storage_configuration: isStorageConfigured(env) ? "configured" : "missing",
      }, 200, headers);
    }

    if (request.method === "GET" && path === "/admin/me") {
      const auth = await authenticateAdmin(request, env);
      if (auth.response) return withHeaders(auth.response, headers);
      return json({ admin: auth.actor }, 200, headers);
    }

    if (request.method === "GET" && path === "/admin/payment-submissions") {
      const auth = await authenticateAdmin(request, env, ["payments.read"]);
      if (auth.response) return withHeaders(auth.response, headers);
      const status = url.searchParams.get("status");
      const allowed = new Set(["pending_review", "confirmed", "rejected"]);
      if (status && !allowed.has(status)) return error("INVALID_STATUS_FILTER", "حالة الدفع غير صالحة.", 400, headers);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 100);
      const rows = await env.DB.prepare(
        `SELECT ps.id, ps.activation_request_id, ps.method, ps.amount_minor, ps.currency,
                ps.reference_note, ps.proof_file_name, ps.proof_content_type, ps.proof_size_bytes,
                ps.status, ps.submitted_at, ps.reviewed_at, ps.review_note,
                ar.customer_name_snapshot, ar.customer_phone_snapshot, ar.device_label
         FROM payment_submissions ps
         JOIN activation_requests ar ON ar.id = ps.activation_request_id
         WHERE (? IS NULL OR ps.status = ?)
         ORDER BY ps.submitted_at DESC LIMIT ?`
      ).bind(status, status, limit).all();
      return json({ items: rows.results ?? [] }, 200, headers);
    }

    const paymentProofMatch = path.match(/^\/admin\/payment-submissions\/([^/]+)\/proof$/);
    if (request.method === "GET" && paymentProofMatch) {
      const auth = await authenticateAdmin(request, env, ["payments.read"]);
      if (auth.response) return withHeaders(auth.response, headers);
      if (!UUID_RE.test(paymentProofMatch[1]) || !storage) return error("PROOF_NOT_FOUND", "إثبات الدفع غير موجود.", 404, headers);
      const row = await env.DB.prepare(
        `SELECT proof_object_key, proof_content_type, proof_file_name
         FROM payment_submissions WHERE id = ? LIMIT 1`
      ).bind(paymentProofMatch[1]).first<{ proof_object_key: string | null; proof_content_type: string | null; proof_file_name: string | null }>();
      if (!row?.proof_object_key || !row.proof_content_type) return error("PROOF_NOT_FOUND", "لا يوجد ملف إثبات لهذا الدفع.", 404, headers);
      const object = await storage.get(row.proof_object_key);
      if (!object) return error("PROOF_NOT_FOUND", "ملف إثبات الدفع غير متاح.", 404, headers);
      const safeName = (row.proof_file_name || "payment-proof").replace(/[^A-Za-z0-9._-]/g, "_");
      const proofResponse = new Response(object.body, {
        status: 200,
        headers: {
          "content-type": row.proof_content_type,
          "content-disposition": `inline; filename="${safeName}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
      return withHeaders(proofResponse, headers);
    }

    const paymentDecisionMatch = path.match(/^\/admin\/payment-submissions\/([^/]+)\/(confirm|reject)$/);
    if (request.method === "POST" && paymentDecisionMatch) {
      const auth = await authenticateAdmin(request, env, ["payments.confirm"]);
      if (auth.response) return withHeaders(auth.response, headers);
      const submissionId = paymentDecisionMatch[1];
      const decision = paymentDecisionMatch[2];
      if (!UUID_RE.test(submissionId)) return error("PAYMENT_SUBMISSION_NOT_FOUND", "طلب الدفع غير موجود.", 404, headers);
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const reviewNote = typeof body?.review_note === "string" ? body.review_note.trim() : "";
      if (reviewNote.length > 500) return error("INVALID_REVIEW_NOTE", "الملاحظة أطول من الحد المسموح.", 422, headers);
      const now = new Date().toISOString();
      const newStatus = decision === "confirm" ? "confirmed" : "rejected";
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE payment_submissions
           SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
           WHERE id = ? AND status = 'pending_review'`
        ).bind(newStatus, auth.actor.id, now, reviewNote || null, now, submissionId),
        env.DB.prepare(
          `INSERT INTO audit_logs
           (id, actor_admin_id, action_key, entity_type, entity_id, after_json, request_id, created_at)
           SELECT ?, ?, ?, 'payment_submission', ?, ?, activation_request_id, ?
           FROM payment_submissions
           WHERE id = ? AND status = ? AND reviewed_by = ?`
        ).bind(crypto.randomUUID(), auth.actor.id, `payment_submission.${decision}`,
          submissionId, JSON.stringify({ status: newStatus, review_note: reviewNote || null }),
          now, submissionId, newStatus, auth.actor.id),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
        return error("PAYMENT_SUBMISSION_NOT_REVIEWABLE", "طلب الدفع غير موجود أو سبق اتخاذ قرار بشأنه.", 409, headers);
      }
      return json({ payment_submission_id: submissionId, status: newStatus }, 200, headers);
    }

    if (request.method === "POST" && path === "/admin/activation-requests/import") {
      const auth = await authenticateAdmin(request, env, ["activation_requests.review"]);
      if (auth.response) return withHeaders(auth.response, headers);
      if (!(await rateLimit(request, env, "admin-hreq-import", 20))) {
        return error("RATE_LIMITED", "تم تجاوز عدد مرات استيراد ملفات الطلب مؤقتًا.", 429, headers);
      }
      return withHeaders(await importHreq(request, env), headers);
    }

    if (request.method === "GET" && path === "/admin/activation-requests") {
      const auth = await authenticateAdmin(request, env, ["activation_requests.read"]);
      if (auth.response) return withHeaders(auth.response, headers);
      const status = url.searchParams.get("status");
      const allowedStatuses = new Set(["pending_proof", "proof_verified", "under_review", "approved", "rejected", "cancelled", "expired"]);
      if (status && !allowedStatuses.has(status)) return error("INVALID_STATUS_FILTER", "حالة الطلب غير صالحة.", 400, headers);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 100);
      const rows = await env.DB.prepare(
        `SELECT ar.id, ar.status, ar.platform_key, ar.architecture_key, ar.device_label,
                ar.key_fingerprint, ar.customer_name_snapshot, ar.customer_phone_snapshot,
                ar.requested_plan, ar.source, ar.created_at, ar.proof_verified_at,
                (SELECT ps.id FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_submission_id,
                (SELECT ps.status FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_status,
                (SELECT ps.method FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_method,
                (SELECT ps.amount_minor FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_amount_minor,
                (SELECT ps.currency FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS payment_currency,
                (SELECT CASE WHEN ps.proof_object_key IS NOT NULL THEN 1 ELSE 0 END FROM payment_submissions ps WHERE ps.activation_request_id = ar.id ORDER BY ps.submitted_at DESC LIMIT 1) AS has_payment_proof
         FROM activation_requests ar
         WHERE (? IS NULL OR ar.status = ?)
         ORDER BY ar.created_at DESC LIMIT ?`
      ).bind(status, status, limit).all();
      return json({ items: rows.results ?? [] }, 200, headers);
    }

    const reviewMatch = path.match(/^\/admin\/activation-requests\/([^/]+)\/review$/);
    if (request.method === "POST" && reviewMatch) {
      const auth = await authenticateAdmin(request, env, ["activation_requests.review"]);
      if (auth.response) return withHeaders(auth.response, headers);
      const requestId = reviewMatch[1];
      if (!UUID_RE.test(requestId)) return error("NOT_FOUND", "طلب التفعيل غير موجود.", 404, headers);
      const now = new Date().toISOString();
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE activation_requests SET status = 'under_review', updated_at = ?
           WHERE id = ? AND status = 'proof_verified'`
        ).bind(now, requestId),
        env.DB.prepare(
          `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, request_id, created_at)
           VALUES (?, ?, 'activation.mark_under_review', 'activation_request', ?, ?, ?)`
        ).bind(crypto.randomUUID(), auth.actor.id, requestId, requestId, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) return error("REQUEST_NOT_REVIEWABLE", "الطلب غير موجود أو لا يمكن تحويله للمراجعة.", 409, headers);
      return json({ activation_request_id: requestId, status: "under_review" }, 200, headers);
    }

    const approveMatch = path.match(/^\/admin\/activation-requests\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveMatch) {
      const auth = await authenticateAdmin(request, env, [
        "activation_requests.review", "payments.confirm", "subscriptions.manage", "licenses.issue",
      ]);
      if (auth.response) return withHeaders(auth.response, headers);
      const result = await approveActivationRequest(request, env, approveMatch[1], auth.actor);
      return withHeaders(result, headers);
    }

    if (request.method === "POST" && path === "/public/trials/register") {
      if (!(await rateLimit(request, env, "trial-register", 8))) {
        return error("RATE_LIMITED", "تم تجاوز عدد محاولات تسجيل التجربة مؤقتًا.", 429, headers);
      }
      return withHeaders(await registerTrial(request, env, headers), headers);
    }

    if (request.method === "POST" && path === "/public/activation-requests") {
      return createActivation(request, env, headers);
    }
    const proofMatch = path.match(/^\/public\/activation-requests\/([^/]+)\/proof$/);
    if (request.method === "POST" && proofMatch) {
      return verifyActivationProof(request, env, proofMatch[1], headers);
    }
    if (request.method === "GET" && path === "/updates/check") {
      const productKey = url.searchParams.get("product_key") || "";
      const platform = url.searchParams.get("platform");
      const architecture = url.searchParams.get("architecture") || "universal";
      const channel = url.searchParams.get("channel") || "stable";
      const currentVersionCodeText = url.searchParams.get("current_version_code") || "0";
      const currentVersionCode = Number(currentVersionCodeText);
      if (!/^[a-z0-9-]{2,64}$/.test(productKey) ||
          !["android", "windows", "linux"].includes(platform || "") ||
          !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
          !["stable", "beta"].includes(channel) ||
          !/^\d{1,10}$/.test(currentVersionCodeText) ||
          !Number.isSafeInteger(currentVersionCode) || currentVersionCode < 0) {
        return error("INVALID_UPDATE_QUERY", "بيانات فحص التحديث غير صالحة.", 400, headers);
      }
      const update = await env.DB.prepare(
        `SELECT a.id AS publication_id, r.version, r.build_number, r.channel,
                a.file_name, a.size_bytes, a.sha256_hex, a.signature_key_id
         FROM products p
         JOIN product_releases r ON r.product_id = p.id
         JOIN release_assets a ON a.release_id = r.id
         WHERE p.product_key = ? AND p.is_active = 1
           AND r.status = 'published' AND r.channel = ?
           AND a.platform_key = ? AND a.architecture_key IN (?, 'universal')
           AND CAST(r.build_number AS INTEGER) > ?
         ORDER BY CAST(r.build_number AS INTEGER) DESC, r.published_at DESC,
                  CASE WHEN a.architecture_key = ? THEN 0 ELSE 1 END
         LIMIT 1`
      ).bind(productKey, channel, platform, architecture, currentVersionCode, architecture).first<{
        publication_id: string; version: string; build_number: string; channel: string;
        file_name: string; size_bytes: number; sha256_hex: string; signature_key_id: string | null;
      }>();
      if (!update) return json({ available: false }, 200, headers);
      const versionCode = Number(update.build_number);
      if (!update.signature_key_id || !Number.isSafeInteger(versionCode) || versionCode < 1) {
        return error("UPDATE_MANIFEST_UNAVAILABLE", "بيانات توقيع التحديث غير مكتملة.", 503, headers);
      }
      return json({
        available: true,
        publication_id: update.publication_id,
        version: update.version,
        version_code: versionCode,
        file_name: update.file_name,
        size_bytes: update.size_bytes,
        sha256_hex: update.sha256_hex,
        signing_key_id: update.signature_key_id,
      }, 200, headers);
    }

    const updateManifestMatch = path.match(/^\/updates\/([^/]+)\/manifest$/);
    if (request.method === "GET" && updateManifestMatch) {
      const manifest = await env.DB.prepare(
        `SELECT a.id AS publication_id, a.signature_key_id, a.signature_b64, a.manifest_payload_b64
         FROM release_assets a
         JOIN product_releases r ON r.id = a.release_id
         JOIN products p ON p.id = r.product_id
         WHERE a.id = ? AND r.status = 'published' AND p.is_active = 1
         LIMIT 1`
      ).bind(updateManifestMatch[1]).first<{
        publication_id: string; signature_key_id: string | null;
        signature_b64: string | null; manifest_payload_b64: string | null;
      }>();
      if (!manifest || !manifest.signature_key_id || !manifest.signature_b64 || !manifest.manifest_payload_b64) {
        return error("UPDATE_MANIFEST_NOT_FOUND", "بيان التحديث غير موجود أو غير منشور.", 404, headers);
      }
      return json({
        publication_id: manifest.publication_id,
        key_id: manifest.signature_key_id,
        manifest: manifest.manifest_payload_b64,
        signature: manifest.signature_b64,
      }, 200, headers);
    }

    const updateDownloadMatch = path.match(/^\/updates\/([^/]+)\/download$/);
    if (request.method === "GET" && updateDownloadMatch) {
      if (!storage) return error("FILE_STORAGE_UNAVAILABLE", "تخزين ملفات الإصدارات غير مهيأ.", 503, headers);
      const row = await env.DB.prepare(
        `SELECT a.r2_object_key, a.file_name, a.content_type, a.size_bytes
         FROM release_assets a
         JOIN product_releases r ON r.id = a.release_id
         JOIN products p ON p.id = r.product_id
         WHERE a.id = ? AND r.status = 'published' AND p.is_active = 1
         LIMIT 1`
      ).bind(updateDownloadMatch[1]).first<{
        r2_object_key: string; file_name: string; content_type: string; size_bytes: number;
      }>();
      if (!row) return error("UPDATE_ASSET_NOT_FOUND", "ملف التحديث غير موجود أو غير منشور.", 404, headers);
      const object = await storage.get(row.r2_object_key);
      if (!object) return error("UPDATE_ASSET_NOT_FOUND", "ملف التحديث غير متاح حاليًا.", 404, headers);
      const safeName = row.file_name.replace(/[^A-Za-z0-9._-]/g, "_");
      return withHeaders(new Response(object.body, {
        status: 200,
        headers: {
          "content-type": row.content_type,
          "content-length": String(row.size_bytes),
          "content-disposition": `attachment; filename="${safeName}"`,
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      }), headers);
    }

    const latestReleaseMatch = path.match(/^\/public\/products\/([a-z0-9-]+)\/releases\/latest$/);
    if (request.method === "GET" && latestReleaseMatch) {
      const productKey = latestReleaseMatch[1];
      const platform = url.searchParams.get("platform_key");
      const architecture = url.searchParams.get("architecture_key") || "universal";
      const channel = url.searchParams.get("channel") || "stable";
      if (!["android", "windows", "linux"].includes(platform || "") ||
          !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
          !["stable", "beta"].includes(channel)) {
        return error("INVALID_RELEASE_QUERY", "منصة أو معمارية أو قناة الإصدار غير صالحة.", 400, headers);
      }
      const release = await env.DB.prepare(
        `SELECT r.id AS release_id, r.version, r.build_number, r.channel,
                r.release_notes_ar, r.release_notes_en, r.published_at,
                a.id AS asset_id, a.platform_key, a.architecture_key, a.file_name,
                a.content_type, a.size_bytes, a.sha256_hex, a.signature_key_id, a.signature_b64, a.manifest_payload_b64
         FROM products p
         JOIN product_releases r ON r.product_id = p.id
         JOIN release_assets a ON a.release_id = r.id
         WHERE p.product_key = ? AND p.is_active = 1
           AND r.status = 'published' AND r.channel = ?
           AND a.platform_key = ?
           AND a.architecture_key IN (?, 'universal')
         ORDER BY CASE WHEN a.architecture_key = ? THEN 0 ELSE 1 END,
                  r.published_at DESC
         LIMIT 1`
      ).bind(productKey, channel, platform, architecture, architecture).first<{
        release_id: string; version: string; build_number: string; channel: string;
        release_notes_ar: string | null; release_notes_en: string | null; published_at: string;
        asset_id: string; platform_key: string; architecture_key: string; file_name: string;
        content_type: string; size_bytes: number; sha256_hex: string;
        signature_key_id: string | null; signature_b64: string | null; manifest_payload_b64: string | null;
      }>();
      if (!release) return error("RELEASE_NOT_FOUND", "لا يوجد إصدار منشور مطابق لهذا الجهاز.", 404, headers);
      return json({
        release: {
          id: release.release_id, version: release.version, build_number: release.build_number,
          channel: release.channel, release_notes_ar: release.release_notes_ar,
          release_notes_en: release.release_notes_en, published_at: release.published_at,
        },
        asset: {
          id: release.asset_id, platform_key: release.platform_key,
          architecture_key: release.architecture_key, file_name: release.file_name,
          content_type: release.content_type, size_bytes: release.size_bytes,
          sha256: release.sha256_hex, signature_key_id: release.signature_key_id,
          signature: release.signature_b64,
          manifest: release.manifest_payload_b64,
          download_url: `${API_PREFIX}/public/releases/${release.release_id}/assets/${release.asset_id}/download`,
        },
      }, 200, headers);
    }

    const releaseDownloadMatch = path.match(/^\/public\/releases\/([^/]+)\/assets\/([^/]+)\/download$/);
    if (request.method === "GET" && releaseDownloadMatch) {
      if (!storage) return error("FILE_STORAGE_UNAVAILABLE", "تخزين الملفات غير مهيأ.", 503, headers);
      const row = await env.DB.prepare(
        `SELECT a.r2_object_key, a.file_name, a.content_type, a.size_bytes
         FROM release_assets a
         JOIN product_releases r ON r.id = a.release_id
         JOIN products p ON p.id = r.product_id
         WHERE r.id = ? AND a.id = ? AND r.status = 'published' AND p.is_active = 1
         LIMIT 1`
      ).bind(releaseDownloadMatch[1], releaseDownloadMatch[2]).first<{
        r2_object_key: string; file_name: string; content_type: string; size_bytes: number;
      }>();
      if (!row) return error("RELEASE_ASSET_NOT_FOUND", "ملف الإصدار غير موجود أو لم يعد منشورًا.", 404, headers);
      const object = await storage.get(row.r2_object_key);
      if (!object) return error("RELEASE_ASSET_NOT_FOUND", "ملف الإصدار غير متاح حاليًا.", 404, headers);
      const safeName = row.file_name.replace(/[^A-Za-z0-9._-]/g, "_");
      const downloadResponse = new Response(object.body, {
        status: 200,
        headers: {
          "content-type": row.content_type,
          "content-length": String(row.size_bytes),
          "content-disposition": `attachment; filename="${safeName}"`,
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
      return withHeaders(downloadResponse, headers);
    }

    const paymentSubmissionMatch = path.match(/^\/public\/activation-requests\/([^/]+)\/payment-submissions$/);
    if (request.method === "POST" && paymentSubmissionMatch) {
      if (!(await rateLimit(request, env, "payment-evidence", 5))) {
        return error("RATE_LIMITED", "تم تجاوز عدد مرات إرسال إثبات الدفع مؤقتًا.", 429, headers);
      }
      return withHeaders(await submitPaymentEvidence(request, env, paymentSubmissionMatch[1]), headers);
    }

    const statusMatch = path.match(/^\/public\/activation-requests\/([^/]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      return activationStatus(env, statusMatch[1], headers);
    }

    const challengeMatch = path.match(/^\/public\/devices\/([^/]+)\/challenges$/);
    if (request.method === "POST" && challengeMatch) {
      if (!(await rateLimit(request, env, "device-challenge", 20))) {
        return error("RATE_LIMITED", "تم تجاوز عدد طلبات تجديد التصريح.", 429, headers);
      }
      return withHeaders(await createDeviceChallenge(request, env, challengeMatch[1]), headers);
    }

    const grantMatch = path.match(/^\/public\/licenses\/([^/]+)\/devices\/([^/]+)\/offline-grants$/);
    if (request.method === "POST" && grantMatch) {
      if (!(await rateLimit(request, env, "offline-grant", 20))) {
        return error("RATE_LIMITED", "تم تجاوز عدد محاولات تجديد التصريح.", 429, headers);
      }
      return withHeaders(await issueOfflineGrant(request, env, grantMatch[1], grantMatch[2]), headers);
    }

    return error("NOT_FOUND", "المسار غير موجود.", 404, headers);
  },
};
