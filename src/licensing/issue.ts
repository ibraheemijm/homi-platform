import type { Env } from "../types";
import type { AdminActor } from "../security/access";
import { encodePayloadBase64, signLicensePayload } from "./signer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_DAYS: Record<string, number> = { monthly: 30, annual: 365 };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16 * 1024) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function licenseFile(license: {
  id: string; deviceId: string; keyId: string; payload: string; signature: string;
}) {
  return {
    format: "HOMI_LICENSE_FILE",
    format_version: 1,
    status: "active",
    license_id: license.id,
    device_id: license.deviceId,
    key_id: license.keyId,
    payload: license.payload,
    signature: license.signature,
  };
}

async function existingLicense(env: Env, requestId: string): Promise<Response | null> {
  const row = await env.DB.prepare(
    `SELECT id, device_id, key_id, payload_b64, signature_b64, status
     FROM licenses WHERE activation_request_id = ? LIMIT 1`
  ).bind(requestId).first<{
    id: string; device_id: string; key_id: string; payload_b64: string;
    signature_b64: string; status: string;
  }>();
  if (!row || row.status !== "active") return null;
  const file = licenseFile({
    id: row.id, deviceId: row.device_id, keyId: row.key_id,
    payload: row.payload_b64, signature: row.signature_b64,
  });
  return json({
    status: "approved",
    license: {
      id: row.id, device_id: row.device_id, key_id: row.key_id,
      status: row.status, payload: row.payload_b64, signature: row.signature_b64,
    },
    license_file: file,
    idempotent_replay: true,
  });
}

export async function approveActivationRequest(
  request: Request,
  env: Env,
  requestId: string,
  actor: AdminActor,
): Promise<Response> {
  if (!UUID_RE.test(requestId)) return fail("ACTIVATION_REQUEST_NOT_FOUND", "طلب التفعيل غير موجود.", 404);
  const replay = await existingLicense(env, requestId);
  if (replay) return replay;

  const body = await parseBody(request);
  if (!body) return fail("INVALID_JSON", "بيانات الموافقة غير صالحة.", 400);

  const customerName = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
  const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : "";
  const plan = body.plan_key;
  const maxDevices = body.max_devices;
  const paymentSubmissionId = typeof body.payment_submission_id === "string"
    ? body.payment_submission_id : null;
  let paymentMethod: string = typeof body.payment_method === "string" ? body.payment_method : "";
  let amountMinor: number = typeof body.amount_minor === "number" ? body.amount_minor : 0;
  let currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
  let receivedAt = typeof body.received_at === "string" ? body.received_at : "";
  let referenceNote = typeof body.reference_note === "string" ? body.reference_note.trim() : null;

  if (customerName.length < 2 || customerName.length > 120 ||
      !/^[+][1-9][0-9]{7,14}$/.test(phone) ||
      typeof plan !== "string" || !["monthly", "annual", "lifetime"].includes(plan) ||
      typeof maxDevices !== "number" || !Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100 ||
      (paymentSubmissionId !== null && !UUID_RE.test(paymentSubmissionId)) ||
      (paymentSubmissionId === null && (
        typeof paymentMethod !== "string" || !["cash", "bank_transfer", "other"].includes(paymentMethod) ||
        typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor < 1 ||
        !/^[A-Z]{3}$/.test(currency) ||
        !Number.isFinite(Date.parse(receivedAt)) ||
        (referenceNote !== null && referenceNote.length > 500)
      ))) {
    return fail("INVALID_APPROVAL_DETAILS", "بيانات العميل أو الاشتراك أو تأكيد الدفع غير مكتملة.", 422);
  }

  const activation = await env.DB.prepare(
    `SELECT ar.id, ar.product_id, ar.key_fingerprint, ar.platform_key, ar.architecture_key,
            ar.device_label, ar.status, ar.proof_verified_at,
            d.id AS device_id, d.status AS device_status, p.product_key
     FROM activation_requests ar
     JOIN products p ON p.id = ar.product_id
     JOIN devices d ON d.product_id = ar.product_id AND d.key_fingerprint = ar.key_fingerprint
     WHERE ar.id = ? LIMIT 1`
  ).bind(requestId).first<{
    id: string; product_id: string; key_fingerprint: string; platform_key: string;
    architecture_key: string; device_label: string; status: string; proof_verified_at: string | null;
    device_id: string; device_status: string; product_key: string;
  }>();

  if (!activation) return fail("ACTIVATION_REQUEST_NOT_FOUND", "طلب التفعيل أو الجهاز المرتبط به غير موجود.", 404);
  if (activation.product_key !== "homi-grocery" ||
      !activation.proof_verified_at ||
      !["proof_verified", "under_review"].includes(activation.status) ||
      ["revoked", "suspended"].includes(activation.device_status)) {
    return fail("ACTIVATION_REQUEST_NOT_APPROVABLE", "الطلب لم يجتز إثبات الجهاز أو لم يعد قابلًا للموافقة.", 409);
  }

  if (paymentSubmissionId !== null) {
    const submission = await env.DB.prepare(
      `SELECT method, amount_minor, currency, reference_note, submitted_at
       FROM payment_submissions
       WHERE id = ? AND activation_request_id = ? AND status = 'confirmed'
       LIMIT 1`
    ).bind(paymentSubmissionId, requestId).first<{
      method: string; amount_minor: number; currency: string; reference_note: string | null; submitted_at: string;
    }>();
    if (!submission) {
      return fail("PAYMENT_NOT_CONFIRMED", "يجب تأكيد استلام إثبات الدفع المرتبط بهذا الطلب قبل إصدار الترخيص.", 409);
    }
    paymentMethod = submission.method;
    amountMinor = submission.amount_minor;
    currency = submission.currency;
    receivedAt = submission.submitted_at;
    referenceNote = submission.reference_note;
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const endsAt = plan === "lifetime"
    ? null
    : new Date(nowDate.getTime() + PLAN_DAYS[plan] * 24 * 60 * 60 * 1000).toISOString();
  const graceEndsAt = endsAt
    ? new Date(Date.parse(endsAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const customerId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const licenseId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();

  const accessPolicy = plan === "lifetime"
    ? "full_forever"
    : "full_until_subscription_end_then_read_export_until_grace_end";

  const claims = {
    schema_version: 1,
    license_id: licenseId,
    organization_id: customerId,
    user_id: customerId,
    product_id: activation.product_id,
    product_key: "homi-grocery",
    subscription_id: subscriptionId,
    device_id: activation.device_id,
    device_fingerprints: [activation.key_fingerprint],
    plan_key: plan,
    starts_at: now,
    ends_at: endsAt,
    trial_ends_at: null,
    subscription_ends_at: endsAt,
    offline_expires_at: graceEndsAt,
    grace_ends_at: graceEndsAt,
    access_policy: accessPolicy,
    max_devices: maxDevices,
    entitlement_version: 1,
    issued_at: now,
  } as const;

  let signed: { keyId: string; signatureB64: string };
  let payloadBytes: Uint8Array;
  try {
    signed = await signLicensePayload(env, new TextEncoder().encode(JSON.stringify({
      ...claims,
      key_id: env.LICENSE_SIGNING_KEY_ID,
    })));
    payloadBytes = new TextEncoder().encode(JSON.stringify({ ...claims, key_id: signed.keyId }));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "";
    if (reason === "Signing key is not configured.") {
      return fail("LICENSE_SIGNING_KEY_MISSING", "مفتاح توقيع التراخيص الخاص غير مضبوط في بيئة Preview؛ لم يتم تسجيل الموافقة أو الدفع.", 503);
    }
    if (reason === "Signing private key does not match configured public key.") {
      return fail("LICENSE_SIGNING_KEY_MISMATCH", "مفتاح التوقيع الخاص لا يطابق مفتاح التحقق العام المسجل؛ لم يتم تسجيل الموافقة أو الدفع.", 503);
    }
    if (reason === "Signing key encoding is invalid." ||
        reason.includes("Ed25519") ||
        reason.includes("importKey")) {
      return fail("LICENSE_SIGNING_KEY_INVALID", "مفتاح توقيع التراخيص غير صالح أو ليس بصيغة PKCS#8 Ed25519؛ لم يتم تسجيل الموافقة أو الدفع.", 503);
    }
    return fail("LICENSE_SIGNING_UNAVAILABLE", "تعذر تشغيل خدمة توقيع التراخيص؛ لم يتم تسجيل الموافقة أو الدفع.", 503);
  }

  const payloadB64 = encodePayloadBase64(payloadBytes);
  const license = {
    id: licenseId,
    deviceId: activation.device_id,
    keyId: signed.keyId,
    payload: payloadB64,
    signature: signed.signatureB64,
  };
  const file = licenseFile(license);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customers (id, display_name, phone_e164, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(customerId, customerName, phone, now, now),
      env.DB.prepare(
        `INSERT INTO subscriptions
         (id, customer_id, product_id, plan_key, status, starts_at, ends_at, max_devices, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).bind(subscriptionId, customerId, activation.product_id, plan, now, endsAt, maxDevices, now, now),
      env.DB.prepare(
        `INSERT INTO payments
         (id, subscription_id, method, amount_minor, currency, received_at, status, reference_note,
          confirmed_by, payment_submission_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`
      ).bind(paymentId, subscriptionId, paymentMethod, amountMinor, currency,
        new Date(receivedAt).toISOString(), referenceNote, actor.id, paymentSubmissionId, now, now),
      env.DB.prepare(
        `UPDATE devices SET customer_id = ?, status = 'active', updated_at = ? WHERE id = ?`
      ).bind(customerId, now, activation.device_id),
      env.DB.prepare(
        `UPDATE activation_requests
         SET customer_id = ?, customer_name_snapshot = ?, customer_phone_snapshot = ?,
             requested_plan = ?, status = 'approved', updated_at = ?
         WHERE id = ?`
      ).bind(customerId, customerName, phone, plan, now, requestId),
      env.DB.prepare(
        `INSERT INTO licenses
         (id, subscription_id, device_id, product_id, key_id, status, payload_b64, signature_b64,
          issued_at, starts_at, ends_at, activation_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(licenseId, subscriptionId, activation.device_id, activation.product_id,
        signed.keyId, payloadB64, signed.signatureB64, now, now, endsAt, requestId, now),
      env.DB.prepare(
        `INSERT INTO audit_logs
         (id, actor_admin_id, action_key, entity_type, entity_id, after_json, request_id, created_at)
         VALUES (?, ?, 'activation.approve_and_issue', 'license', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, licenseId, JSON.stringify({
        activation_request_id: requestId, customer_id: customerId, subscription_id: subscriptionId,
        plan_key: plan, max_devices: maxDevices, payment_id: paymentId, payment_submission_id: paymentSubmissionId, amount_minor: amountMinor, currency,
      }), requestId, now),
    ]);
  } catch {
    const replayAfterConflict = await existingLicense(env, requestId);
    if (replayAfterConflict) return replayAfterConflict;
    return fail("LICENSE_ISSUE_FAILED", "تعذر حفظ الترخيص؛ لم يتم اعتماد العملية. راجع سجل الإدارة وحاول مرة أخرى.", 409);
  }

  return json({
    status: "approved",
    license: {
      id: licenseId,
      device_id: activation.device_id,
      key_id: signed.keyId,
      status: "active",
      payload: payloadB64,
      signature: signed.signatureB64,
    },
    license_file: file,
    idempotent_replay: false,
  }, 201);
}
