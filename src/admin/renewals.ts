import type { Env } from "../types";
import { authenticateAdmin } from "../security/access";
import { encodePayloadBase64, signLicensePayload } from "../licensing/signer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const PLAN_DAYS: Record<string, number> = { monthly: 30, annual: 365 };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16 * 1024) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 16 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function decodePayload(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch { return null; }
}

export async function handleSubscriptionRenewal(request: Request, env: Env, path: string): Promise<Response | null> {
  const match = path.match(/^\/admin\/subscriptions\/([0-9a-f-]{36})\/renew$/i);
  if (!match || request.method !== "POST") return null;
  const auth = await authenticateAdmin(request, env, ["payments.confirm", "subscriptions.manage", "licenses.issue"]);
  if (auth.response) return auth.response;
  const subscriptionId = match[1];
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!UUID_RE.test(idempotencyKey)) {
    return fail("IDEMPOTENCY_KEY_REQUIRED", "يلزم إرسال Idempotency-Key بصيغة UUID لمنع تسجيل التجديد مرتين.", 422);
  }
  const operationKey = "subscription.renew:" + subscriptionId;
  const previous = await env.DB.prepare("SELECT operation_key, response_json FROM idempotency_keys WHERE idempotency_key = ? LIMIT 1")
    .bind(idempotencyKey).first<{operation_key:string;response_json:string}>();
  if (previous) {
    if (previous.operation_key !== operationKey) return fail("IDEMPOTENCY_KEY_REUSED", "مفتاح منع التكرار مستخدم لعملية أخرى.", 409);
    try { return json(JSON.parse(previous.response_json), 200); }
    catch { return fail("IDEMPOTENCY_RECORD_INVALID", "سجل منع التكرار غير صالح؛ راجع سجل الإدارة.", 500); }
  }

  const body = await parseBody(request);
  if (!body) return fail("INVALID_JSON", "بيانات التجديد غير صالحة.", 400);
  const method = typeof body.payment_method === "string" ? body.payment_method : "";
  const amount = typeof body.amount_minor === "number" ? body.amount_minor : Number.NaN;
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
  const receivedAt = typeof body.received_at === "string" ? body.received_at : "";
  const reference = typeof body.reference_note === "string" ? body.reference_note.trim() : "";
  if (!["cash","bank_transfer","other"].includes(method) ||
      !Number.isSafeInteger(amount) || amount < 1 || amount > 2_000_000_000 ||
      !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Date.parse(receivedAt)) || reference.length > 500) {
    return fail("INVALID_RENEWAL_PAYMENT", "طريقة الدفع أو المبلغ أو العملة أو تاريخ الاستلام غير صالح.", 422);
  }

  const subscription = await env.DB.prepare(
    "SELECT id, customer_id, product_id, plan_key, status, starts_at, ends_at, max_devices FROM subscriptions WHERE id = ? LIMIT 1"
  ).bind(subscriptionId).first<{
    id:string;customer_id:string;product_id:string;plan_key:string;status:string;
    starts_at:string|null;ends_at:string|null;max_devices:number;
  }>();
  if (!subscription) return fail("SUBSCRIPTION_NOT_FOUND", "الاشتراك غير موجود.", 404);
  if (!(subscription.plan_key in PLAN_DAYS) || !["active","expired"].includes(subscription.status)) {
    return fail("SUBSCRIPTION_NOT_RENEWABLE", "التجديد متاح للاشتراكات الشهرية أو السنوية النشطة أو المنتهية فقط. لا يمكن تجديد الاشتراك الموقوف أو الدائم.", 409);
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const oldEnd = subscription.ends_at;
  const oldEndMs = oldEnd ? Date.parse(oldEnd) : Number.NaN;
  const renewalStart = Number.isFinite(oldEndMs) && oldEndMs > nowDate.getTime() ? oldEndMs : nowDate.getTime();
  const newEnd = new Date(renewalStart + PLAN_DAYS[subscription.plan_key] * 24 * 60 * 60 * 1000).toISOString();
  const graceEnd = new Date(Date.parse(newEnd) + 7 * 24 * 60 * 60 * 1000).toISOString();

  const licenseRows = await env.DB.prepare(
    "SELECT l.id, l.device_id, l.payload_b64, d.status AS device_status " +
    "FROM licenses l JOIN devices d ON d.id = l.device_id " +
    "WHERE l.subscription_id = ? AND l.status IN ('active','suspended','expired') " +
    "AND d.status IN ('active','suspended') ORDER BY l.created_at"
  ).bind(subscriptionId).all<{id:string;device_id:string;payload_b64:string;device_status:string}>();

  const renewed: Array<{id:string;status:string;payload:string;signature:string;keyId:string}> = [];
  try {
    for (const license of licenseRows.results ?? []) {
      const claims = decodePayload(license.payload_b64);
      if (!claims || claims.license_id !== license.id || claims.device_id !== license.device_id ||
          claims.subscription_id !== subscriptionId || claims.plan_key !== subscription.plan_key) {
        return fail("LICENSE_PAYLOAD_INVALID", "تعذر تجديد أحد التراخيص المرتبطة؛ بياناته لا تطابق الاشتراك.", 409);
      }
      const updatedClaims = {
        ...claims,
        ends_at: newEnd,
        subscription_ends_at: newEnd,
        offline_expires_at: graceEnd,
        grace_ends_at: graceEnd,
        access_policy: "full_until_subscription_end_then_read_export_until_grace_end",
        entitlement_version: typeof claims.entitlement_version === "number" ? claims.entitlement_version + 1 : 2,
        issued_at: now,
        key_id: env.LICENSE_SIGNING_KEY_ID,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(updatedClaims));
      const signed = await signLicensePayload(env, bytes);
      const finalBytes = new TextEncoder().encode(JSON.stringify({ ...updatedClaims, key_id: signed.keyId }));
      renewed.push({
        id:license.id,status:license.device_status === "active" ? "active" : "suspended",
        payload:encodePayloadBase64(finalBytes),signature:signed.signatureB64,keyId:signed.keyId,
      });
    }
  } catch {
    return fail("LICENSE_SIGNING_UNAVAILABLE", "تعذر توقيع التراخيص المجددة؛ لم يتم تسجيل الدفعة أو تمديد الاشتراك.", 503);
  }

  const paymentId = crypto.randomUUID();
  const startsAt = subscription.starts_at || now;
  const responsePayload = {
    subscription_id:subscriptionId,payment_id:paymentId,status:"active",plan_key:subscription.plan_key,
    starts_at:startsAt,ends_at:newEnd,renewed_license_count:renewed.length,payment_status:"confirmed",
  };
  const expiresAt = new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO idempotency_keys (idempotency_key,operation_key,response_json,created_at,expires_at) " +
      "SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ? " +
      "AND status IN ('active','expired') AND ends_at IS ?)"
    ).bind(idempotencyKey,operationKey,JSON.stringify(responsePayload),now,expiresAt,subscriptionId,oldEnd),
    env.DB.prepare(
      "UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ?, updated_at = ? " +
      "WHERE id = ? AND status IN ('active','expired') AND ends_at IS ?"
    ).bind(startsAt,newEnd,now,subscriptionId,oldEnd),
    env.DB.prepare(
      "INSERT INTO payments (id,subscription_id,method,amount_minor,currency,received_at,status,reference_note,confirmed_by,created_at,updated_at) " +
      "SELECT ?,?,?,?,?,?,'confirmed',?,?,?,? WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?) " +
      "AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND ends_at = ? AND updated_at = ?)"
    ).bind(paymentId,subscriptionId,method,amount,currency,new Date(receivedAt).toISOString(),
      reference || null,auth.actor.id,now,now,idempotencyKey,subscriptionId,newEnd,now),
  ];
  for (const license of renewed) {
    statements.push(env.DB.prepare(
      "UPDATE licenses SET status = ?, key_id = ?, payload_b64 = ?, signature_b64 = ?, starts_at = ?, ends_at = ? " +
      "WHERE id = ? AND subscription_id = ? AND status IN ('active','suspended','expired') " +
      "AND EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?) " +
      "AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND ends_at = ? AND updated_at = ?)"
    ).bind(license.status,license.keyId,license.payload,license.signature,startsAt,newEnd,
      license.id,subscriptionId,idempotencyKey,subscriptionId,newEnd,now));
  }
  statements.push(env.DB.prepare(
    "INSERT INTO audit_logs (id,actor_admin_id,action_key,entity_type,entity_id,before_json,after_json,created_at) " +
    "SELECT ?,?,'subscription.renewed','subscription',?,?,?,? " +
    "WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?) " +
    "AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'confirmed')"
  ).bind(crypto.randomUUID(),auth.actor.id,subscriptionId,
    JSON.stringify({status:subscription.status,ends_at:oldEnd}),
    JSON.stringify({status:"active",ends_at:newEnd,payment_id:paymentId,amount_minor:amount,currency}),
    now,idempotencyKey,paymentId));

  try {
    const results = await env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1) {
      return fail("SUBSCRIPTION_CHANGED", "تغير الاشتراك أثناء التجديد؛ لم يتم اعتماد العملية. أعد تحميل بيانات العميل.", 409);
    }
  } catch {
    const replay = await env.DB.prepare(
      "SELECT operation_key,response_json FROM idempotency_keys WHERE idempotency_key = ? LIMIT 1"
    ).bind(idempotencyKey).first<{operation_key:string;response_json:string}>();
    if (replay?.operation_key === operationKey) {
      try { return json(JSON.parse(replay.response_json),200); } catch { /* fall through */ }
    }
    return fail("SUBSCRIPTION_RENEWAL_FAILED", "تعذر تسجيل الدفعة أو تحديث التراخيص. لم يتم اعتماد التجديد.", 409);
  }
  return json(responsePayload,201);
}
