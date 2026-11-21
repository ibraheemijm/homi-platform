import type { Env } from "../types";
import { authenticateAdmin } from "../security/access";
import { encodePayloadBase64, signLicensePayload } from "../licensing/signer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
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

export async function handleCustomerAdmin(
  request: Request, env: Env, path: string, url: URL,
): Promise<Response | null> {
  const customerMatch = path.match(/^\/admin\/customers\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && path === "/admin/customers") {
    const auth = await authenticateAdmin(request, env, ["customers.read"]);
    if (auth.response) return auth.response;
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 100);
    const pattern = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = await env.DB.prepare(
      `SELECT c.id, c.display_name, c.phone_e164, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM subscriptions s WHERE s.customer_id = c.id) AS subscription_count,
              (SELECT COUNT(*) FROM devices d WHERE d.customer_id = c.id AND d.status = 'active') AS active_device_count
       FROM customers c
       WHERE (? IS NULL OR c.display_name LIKE ? ESCAPE '\\' OR c.phone_e164 LIKE ? ESCAPE '\\')
       ORDER BY c.updated_at DESC LIMIT ?`
    ).bind(pattern, pattern, pattern, limit).all();
    return json({ items: rows.results ?? [], limit });
  }

  if (customerMatch && request.method === "GET") {
    const auth = await authenticateAdmin(request, env, ["customers.read"]);
    if (auth.response) return auth.response;
    const customerId = customerMatch[1];
    const customer = await env.DB.prepare(
      "SELECT id, display_name, phone_e164, notes, created_at, updated_at FROM customers WHERE id = ? LIMIT 1"
    ).bind(customerId).first();
    if (!customer) return fail("CUSTOMER_NOT_FOUND", "العميل غير موجود.", 404);
    const [subscriptions, devices, payments] = await Promise.all([
      env.DB.prepare(
        `SELECT s.id, s.product_id, p.product_key, p.display_name AS product_name,
                s.plan_key, s.status, s.starts_at, s.ends_at, s.max_devices,
                s.updates_until, s.support_until, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM licenses l WHERE l.subscription_id = s.id AND l.status = 'active') AS active_seats
         FROM subscriptions s JOIN products p ON p.id = s.product_id
         WHERE s.customer_id = ? ORDER BY s.created_at DESC`
      ).bind(customerId).all(),
      env.DB.prepare(
        `SELECT d.id, d.product_id, p.product_key, d.platform_key, d.architecture_key,
                d.device_label, d.key_fingerprint, d.status, d.created_at, d.updated_at,
                l.id AS license_id, l.subscription_id, l.status AS license_status,
                l.starts_at AS license_starts_at, l.ends_at AS license_ends_at
         FROM devices d JOIN products p ON p.id = d.product_id
         LEFT JOIN licenses l ON l.id = (SELECT l2.id FROM licenses l2 WHERE l2.device_id = d.id ORDER BY l2.created_at DESC LIMIT 1)
         WHERE d.customer_id = ? ORDER BY d.created_at DESC`
      ).bind(customerId).all(),
      env.DB.prepare(
        `SELECT pay.id, pay.subscription_id, pay.method, pay.amount_minor, pay.currency,
                pay.received_at, pay.status, pay.reference_note, pay.created_at
         FROM payments pay JOIN subscriptions s ON s.id = pay.subscription_id
         WHERE s.customer_id = ? ORDER BY pay.created_at DESC LIMIT 100`
      ).bind(customerId).all(),
    ]);
    return json({
      customer,
      subscriptions: subscriptions.results ?? [],
      devices: devices.results ?? [],
      payments: payments.results ?? [],
    });
  }

  if (customerMatch && request.method === "PATCH") {
    const auth = await authenticateAdmin(request, env, ["customers.write"]);
    if (auth.response) return auth.response;
    const customerId = customerMatch[1];
    const body = await bodyOf(request);
    if (!body) return fail("INVALID_JSON", "بيانات العميل غير صالحة.", 400);
    const current = await env.DB.prepare(
      "SELECT display_name, phone_e164, notes FROM customers WHERE id = ? LIMIT 1"
    ).bind(customerId).first<{display_name:string;phone_e164:string;notes:string|null}>();
    if (!current) return fail("CUSTOMER_NOT_FOUND", "العميل غير موجود.", 404);
    const name = body.display_name === undefined ? current.display_name
      : typeof body.display_name === "string" ? body.display_name.trim() : "";
    const phone = body.phone_e164 === undefined ? current.phone_e164
      : typeof body.phone_e164 === "string" ? body.phone_e164.trim() : "";
    const notes = body.notes === undefined ? current.notes
      : body.notes === null ? null : typeof body.notes === "string" ? body.notes.trim() : "";
    if (name.length < 2 || name.length > 120 || !/^\+[1-9][0-9]{7,14}$/.test(phone) ||
        (notes !== null && notes.length > 1000)) {
      return fail("INVALID_CUSTOMER_DETAILS", "اسم العميل أو رقم الهاتف أو الملاحظات غير صالحة.", 422);
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE customers SET display_name = ?, phone_e164 = ?, notes = ?, updated_at = ? WHERE id = ?")
        .bind(name, phone, notes, now, customerId),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, before_json, after_json, created_at)
         VALUES (?, ?, 'customer.updated', 'customer', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), auth.actor.id, customerId,
        JSON.stringify(current), JSON.stringify({display_name:name,phone_e164:phone,notes}), now),
    ]);
    return json({ customer_id: customerId, updated: true });
  }

  const subscriptionMatch = path.match(/^\/admin\/subscriptions\/([0-9a-f-]{36})(?:\/(suspend|reactivate|assign-device))?$/i);
  if (subscriptionMatch && request.method === "PATCH" && !subscriptionMatch[2]) {
    const auth = await authenticateAdmin(request, env, ["subscriptions.manage"]);
    if (auth.response) return auth.response;
    const subscriptionId = subscriptionMatch[1];
    const body = await bodyOf(request);
    if (!body || typeof body.max_devices !== "number" ||
        !Number.isInteger(body.max_devices) || body.max_devices < 1 || body.max_devices > 100) {
      return fail("INVALID_SEAT_LIMIT", "عدد مقاعد الأجهزة يجب أن يكون من 1 إلى 100.", 422);
    }
    const sub = await env.DB.prepare(
      "SELECT max_devices, status FROM subscriptions WHERE id = ? LIMIT 1"
    ).bind(subscriptionId).first<{max_devices:number;status:string}>();
    if (!sub) return fail("SUBSCRIPTION_NOT_FOUND", "الاشتراك غير موجود.", 404);
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM licenses WHERE subscription_id = ? AND status = 'active'"
    ).bind(subscriptionId).first<{count:number}>();
    if ((active?.count ?? 0) > body.max_devices) {
      return fail("SEAT_LIMIT_BELOW_USAGE", "لا يمكن تقليل المقاعد إلى أقل من عدد الأجهزة المرخصة النشطة.", 409);
    }
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE subscriptions SET max_devices = ?, updated_at = ? WHERE id = ? AND max_devices = ?")
        .bind(body.max_devices, now, subscriptionId, sub.max_devices),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, before_json, after_json, created_at)
         SELECT ?, ?, 'subscription.seats_changed', 'subscription', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND max_devices = ?)`
      ).bind(crypto.randomUUID(), auth.actor.id, subscriptionId,
        JSON.stringify({max_devices:sub.max_devices}), JSON.stringify({max_devices:body.max_devices}),
        now, subscriptionId, body.max_devices),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return fail("SUBSCRIPTION_CHANGED", "تغير الاشتراك بالتزامن؛ أعد تحميل البيانات.", 409);
    return json({ subscription_id: subscriptionId, max_devices: body.max_devices });
  }

  if (subscriptionMatch && request.method === "POST" && subscriptionMatch[2] === "assign-device") {
    const auth = await authenticateAdmin(request, env, ["activation_requests.review", "subscriptions.manage", "licenses.issue"]);
    if (auth.response) return auth.response;
    const subscriptionId = subscriptionMatch[1];
    const body = await bodyOf(request);
    const requestId = typeof body?.activation_request_id === "string" ? body.activation_request_id : "";
    if (!UUID_RE.test(requestId)) return fail("INVALID_ACTIVATION_REQUEST", "معرف طلب التفعيل غير صالح.", 422);
    const existing = await env.DB.prepare(
      `SELECT l.id, l.device_id, l.key_id, l.payload_b64, l.signature_b64, l.status
       FROM licenses l WHERE l.activation_request_id = ? LIMIT 1`
    ).bind(requestId).first<{id:string;device_id:string;key_id:string;payload_b64:string;signature_b64:string;status:string}>();
    if (existing?.status === "active") {
      return json({status:"approved",idempotent_replay:true,license:{
        id:existing.id,device_id:existing.device_id,key_id:existing.key_id,status:existing.status,
        payload:existing.payload_b64,signature:existing.signature_b64
      }});
    }
    if (existing) return fail("ACTIVATION_ALREADY_LICENSED", "سبق إصدار ترخيص لهذا الطلب ولم يعد نشطًا.", 409);

    const row = await env.DB.prepare(
      `SELECT s.id AS subscription_id, s.customer_id, s.product_id, s.plan_key, s.status AS subscription_status,
              s.starts_at, s.ends_at, s.max_devices, ar.id AS request_id, ar.status AS request_status,
              ar.proof_verified_at, ar.key_fingerprint, ar.platform_key, ar.architecture_key,
              ar.device_label, ar.product_id AS request_product_id,
              d.id AS device_id, d.status AS device_status, d.customer_id AS device_customer_id,
              p.product_key
       FROM subscriptions s
       JOIN activation_requests ar ON ar.id = ?
       JOIN products p ON p.id = s.product_id
       JOIN devices d ON d.product_id = ar.product_id AND d.key_fingerprint = ar.key_fingerprint
       WHERE s.id = ?
         AND NOT EXISTS (SELECT 1 FROM licenses prior WHERE prior.device_id = d.id AND prior.status = 'active')
       LIMIT 1`
    ).bind(requestId, subscriptionId).first<{
      subscription_id:string;customer_id:string;product_id:string;plan_key:string;subscription_status:string;
      starts_at:string|null;ends_at:string|null;max_devices:number;request_id:string;request_status:string;
      proof_verified_at:string|null;key_fingerprint:string;platform_key:string;architecture_key:string;
      device_label:string;request_product_id:string;device_id:string;device_status:string;
      device_customer_id:string|null;product_key:string;
    }>();
    if (!row) return fail("ASSIGNMENT_NOT_FOUND", "الاشتراك أو طلب التفعيل أو الجهاز غير موجود.", 404);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    if (row.product_key !== "homi-grocery" || row.product_id !== row.request_product_id ||
        row.subscription_status !== "active" ||
        (row.ends_at !== null && Date.parse(row.ends_at) <= nowDate.getTime()) ||
        !row.proof_verified_at || !["proof_verified","under_review"].includes(row.request_status) ||
        !["pending","active"].includes(row.device_status) ||
        (row.device_customer_id !== null && row.device_customer_id !== row.customer_id)) {
      return fail("DEVICE_NOT_ASSIGNABLE", "لا يمكن ربط هذا الجهاز بالاشتراك الحالي؛ تحقق من حالة الاشتراك والجهاز وإثبات الملكية.", 409);
    }

    const licenseId = crypto.randomUUID();
    const startsAt = row.starts_at || now;
    const endsAt = row.ends_at;
    const graceEndsAt = endsAt ? new Date(Date.parse(endsAt) + 7*24*60*60*1000).toISOString() : null;
    const claims = {
      schema_version:1, license_id:licenseId, organization_id:row.customer_id, user_id:row.customer_id,
      product_id:row.product_id, product_key:row.product_key, subscription_id:row.subscription_id,
      device_id:row.device_id, device_fingerprints:[row.key_fingerprint], plan_key:row.plan_key,
      starts_at:startsAt, ends_at:endsAt, trial_ends_at:null, subscription_ends_at:endsAt,
      offline_expires_at:graceEndsAt, grace_ends_at:graceEndsAt,
      access_policy:row.plan_key === "lifetime" ? "full_forever" : "full_until_subscription_end_then_read_export_until_grace_end",
      max_devices:row.max_devices, entitlement_version:1, issued_at:now,
    };
    let signed:{keyId:string;signatureB64:string};
    let payloadB64:string;
    try {
      signed = await signLicensePayload(env,new TextEncoder().encode(JSON.stringify({...claims,key_id:env.LICENSE_SIGNING_KEY_ID})));
      payloadB64 = encodePayloadBase64(new TextEncoder().encode(JSON.stringify({...claims,key_id:signed.keyId})));
    } catch {
      return fail("LICENSE_SIGNING_UNAVAILABLE","خدمة توقيع التراخيص غير مهيأة.",503);
    }

    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO licenses
         (id,subscription_id,device_id,product_id,key_id,status,payload_b64,signature_b64,issued_at,starts_at,ends_at,activation_request_id,created_at)
         SELECT ?,s.id,?,s.product_id,?,'active',?,?,?,?,?,?,?
         FROM subscriptions s
         WHERE s.id = ? AND s.status = 'active'
           AND (s.ends_at IS NULL OR s.ends_at > ?)
           AND (SELECT COUNT(*) FROM licenses l WHERE l.subscription_id = s.id AND l.status = 'active') < s.max_devices`
      ).bind(licenseId,row.device_id,signed.keyId,payloadB64,signed.signatureB64,now,startsAt,endsAt,requestId,now,subscriptionId,now),
      env.DB.prepare(
        `UPDATE devices SET customer_id = ?, status = 'active', updated_at = ?
         WHERE id = ? AND (customer_id IS NULL OR customer_id = ?)
           AND EXISTS (SELECT 1 FROM licenses WHERE id = ?)`
      ).bind(row.customer_id,now,row.device_id,row.customer_id,licenseId),
      env.DB.prepare(
        `UPDATE activation_requests SET customer_id = ?, status = 'approved', updated_at = ?
         WHERE id = ? AND status IN ('proof_verified','under_review')
           AND EXISTS (SELECT 1 FROM licenses WHERE id = ?)`
      ).bind(row.customer_id,now,requestId,licenseId),
      env.DB.prepare(
        `INSERT INTO audit_logs (id,actor_admin_id,action_key,entity_type,entity_id,after_json,request_id,created_at)
         SELECT ?,?,'subscription.device_assigned','license',?,?,?,?
         WHERE EXISTS (SELECT 1 FROM licenses WHERE id = ?)`
      ).bind(crypto.randomUUID(),auth.actor.id,licenseId,
        JSON.stringify({subscription_id:subscriptionId,device_id:row.device_id,activation_request_id:requestId}),
        requestId,now,licenseId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      return fail("SEAT_LIMIT_REACHED", "لا توجد مقاعد أجهزة متاحة في هذا الاشتراك أو تعذر حجز المقعد بالتزامن.", 409);
    }
    return json({status:"approved",idempotent_replay:false,license:{
      id:licenseId,device_id:row.device_id,key_id:signed.keyId,status:"active",
      payload:payloadB64,signature:signed.signatureB64
    }},201);
  }

  if (subscriptionMatch && request.method === "POST" && ["suspend","reactivate"].includes(subscriptionMatch[2] ?? "")) {
    const auth = await authenticateAdmin(request, env, ["subscriptions.manage"]);
    if (auth.response) return auth.response;
    const subscriptionId = subscriptionMatch[1];
    const action = subscriptionMatch[2]!;
    const current = await env.DB.prepare(
      "SELECT status, ends_at FROM subscriptions WHERE id = ? LIMIT 1"
    ).bind(subscriptionId).first<{status:string;ends_at:string|null}>();
    if (!current) return fail("SUBSCRIPTION_NOT_FOUND", "الاشتراك غير موجود.", 404);
    if (action === "reactivate" && (current.status !== "suspended" ||
        (current.ends_at !== null && Date.parse(current.ends_at) <= Date.now()))) {
      return fail("SUBSCRIPTION_NOT_REACTIVATABLE", "لا يمكن إعادة تفعيل اشتراك موقوف أو منتهي الصلاحية.", 409);
    }
    if (action === "suspend" && current.status !== "active") {
      return fail("SUBSCRIPTION_NOT_SUSPENDABLE", "لا يمكن إيقاف هذا الاشتراك في حالته الحالية.", 409);
    }
    const next = action === "suspend" ? "suspended" : "active";
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .bind(next,now,subscriptionId,current.status),
      env.DB.prepare(
        `UPDATE licenses SET status = ?
         WHERE subscription_id = ? AND status = ?
           AND ( ? = 'suspend' OR EXISTS (
             SELECT 1 FROM devices d WHERE d.id = licenses.device_id AND d.status = 'active'
           ))`
      ).bind(action === "suspend" ? "suspended" : "active",subscriptionId,
        action === "suspend" ? "active" : "suspended",action),
      env.DB.prepare(
        `INSERT INTO audit_logs (id,actor_admin_id,action_key,entity_type,entity_id,before_json,after_json,created_at)
         VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(),auth.actor.id,`subscription.${action}`,subscriptionId,
        JSON.stringify({status:current.status}),JSON.stringify({status:next}),now),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return fail("SUBSCRIPTION_CHANGED", "تغير الاشتراك بالتزامن؛ أعد تحميل البيانات.", 409);
    return json({subscription_id:subscriptionId,status:next});
  }

  const deviceMatch = path.match(/^\/admin\/devices\/([0-9a-f-]{36})\/(suspend|reactivate|revoke)$/i);
  if (deviceMatch && request.method === "POST") {
    const auth = await authenticateAdmin(request, env, ["devices.manage"]);
    if (auth.response) return auth.response;
    const deviceId = deviceMatch[1];
    const action = deviceMatch[2];
    const current = await env.DB.prepare("SELECT status FROM devices WHERE id = ? LIMIT 1")
      .bind(deviceId).first<{status:string}>();
    if (!current) return fail("DEVICE_NOT_FOUND", "الجهاز غير موجود.", 404);
    const allowed = action === "suspend" ? current.status === "active"
      : action === "reactivate" ? current.status === "suspended" : current.status !== "revoked";
    if (!allowed) return fail("DEVICE_STATE_CONFLICT", "لا يمكن تنفيذ الإجراء على الجهاز في حالته الحالية.", 409);
    const next = action === "suspend" ? "suspended" : action === "reactivate" ? "active" : "revoked";
    const licenseStatus = action === "suspend" ? "suspended" : action === "reactivate" ? "active" : "revoked";
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE devices SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .bind(next,now,deviceId,current.status),
      env.DB.prepare(
        `UPDATE licenses SET status = ?
         WHERE device_id = ? AND (
           (? = 'revoke' AND status IN ('active','suspended'))
           OR (? = 'suspend' AND status = 'active')
           OR (? = 'reactivate' AND status = 'suspended'
             AND (subscription_id IS NULL OR EXISTS (
               SELECT 1 FROM subscriptions s WHERE s.id = licenses.subscription_id
                 AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > ?)
             )))
         )`
      ).bind(licenseStatus,deviceId,action,action,action,now),
      env.DB.prepare(
        `INSERT INTO audit_logs (id,actor_admin_id,action_key,entity_type,entity_id,before_json,after_json,created_at)
         VALUES (?, ?, ?, 'device', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(),auth.actor.id,`device.${action}`,deviceId,
        JSON.stringify({status:current.status}),JSON.stringify({status:next}),now),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return fail("DEVICE_STATE_CONFLICT", "تغيرت حالة الجهاز بالتزامن؛ أعد تحميل البيانات.", 409);
    return json({device_id:deviceId,status:next});
  }

  return null;
}
