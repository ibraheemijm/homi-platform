import type { Env } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 64 * 1024;

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
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function importHreq(request: Request, env: Env): Promise<Response> {
  if (!env.FILES) return fail("FILE_STORAGE_UNAVAILABLE", "تخزين ملفات الطلبات غير مهيأ لهذه البيئة.", 503);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_FILE_BYTES + 8192) return fail("FILE_TOO_LARGE", "حجم ملف الطلب أكبر من الحد المسموح.", 413);

  let form: FormData;
  try { form = await request.formData(); }
  catch { return fail("INVALID_MULTIPART", "تعذر قراءة ملف طلب التفعيل.", 400); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1 || file.size > MAX_FILE_BYTES ||
      !file.name.toLowerCase().endsWith(".hreq")) {
    return fail("INVALID_HREQ_FILE", "يجب رفع ملف Homi بطول صالح وامتداد .hreq.", 422);
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fileBytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    envelope = parsed as Record<string, unknown>;
  } catch {
    return fail("INVALID_HREQ_FILE", "محتوى ملف الطلب ليس JSON صالحًا.", 422);
  }
  if (envelope.format !== "HOMI_ACTIVATION_REQUEST" || envelope.format_version !== 1 ||
      typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    return fail("UNSUPPORTED_HREQ_FORMAT", "صيغة ملف الطلب أو إصدارها غير مدعوم.", 422);
  }

  const payloadBytes = decodeBase64Url(envelope.payload);
  const signature = decodeBase64Url(envelope.signature);
  if (!payloadBytes || payloadBytes.length > MAX_FILE_BYTES || !signature || signature.length !== 64) {
    return fail("INVALID_HREQ_PROOF", "ترميز محتوى الطلب أو توقيعه غير صالح.", 422);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payloadBytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    return fail("INVALID_HREQ_PAYLOAD", "بيانات طلب التفعيل الداخلية غير صالحة.", 422);
  }

  const requestId = payload.request_id;
  const createdAt = payload.created_at;
  const productKey = payload.product_key;
  const customer = payload.customer;
  const device = payload.device;
  const application = payload.application;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      Date.parse(createdAt) > Date.now() + 5 * 60 * 1000 ||
      productKey !== "homi-grocery" ||
      customer === null || typeof customer !== "object" || Array.isArray(customer) ||
      device === null || typeof device !== "object" || Array.isArray(device) ||
      application === null || typeof application !== "object" || Array.isArray(application)) {
    return fail("INVALID_HREQ_PAYLOAD", "الحقول الأساسية في طلب التفعيل غير مكتملة.", 422);
  }

  const customerData = customer as Record<string, unknown>;
  const deviceData = device as Record<string, unknown>;
  const appData = application as Record<string, unknown>;
  const customerName = typeof customerData.display_name === "string" ? customerData.display_name.trim() : "";
  const customerPhone = typeof customerData.phone === "string" ? customerData.phone.trim() : "";
  const requestedPlan = customerData.requested_plan;
  const notes = typeof customerData.notes === "string" ? customerData.notes.trim() : "";
  const deviceId = deviceData.device_id;
  const platform = deviceData.platform;
  const architecture = deviceData.architecture;
  const deviceLabel = deviceData.device_label;
  const publicKeyText = deviceData.public_key;
  const fingerprintText = deviceData.key_fingerprint;
  const appVersion = typeof appData.version === "string" ? appData.version : "";
  const buildNumber = typeof appData.build_number === "string" ? appData.build_number : "";

  if (customerName.length < 2 || customerName.length > 120 ||
      !/^\+[1-9][0-9]{7,14}$/.test(customerPhone) ||
      typeof requestedPlan !== "string" || !["monthly", "annual", "lifetime"].includes(requestedPlan) ||
      notes.length > 500 ||
      typeof deviceId !== "string" || !UUID_RE.test(deviceId) ||
      typeof platform !== "string" || !["android", "windows", "linux"].includes(platform) ||
      typeof architecture !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
      typeof deviceLabel !== "string" || deviceLabel.length < 2 || deviceLabel.length > 80 ||
      typeof publicKeyText !== "string" || typeof fingerprintText !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(appVersion) || buildNumber.length > 64) {
    return fail("INVALID_HREQ_PAYLOAD", "بيانات العميل أو الجهاز أو التطبيق غير صالحة.", 422);
  }

  const publicKey = decodeBase64Url(publicKeyText);
  if (!publicKey || publicKey.length !== 32) return fail("INVALID_DEVICE_KEY", "مفتاح الجهاز العام غير صالح.", 422);
  const fingerprint = hex(await sha256(publicKey));
  if (fingerprintText !== fingerprint) return fail("DEVICE_FINGERPRINT_MISMATCH", "بصمة مفتاح الجهاز لا تطابق المفتاح العام.", 422);

  const payloadDigest = hex(await sha256(payloadBytes));
  const proofMessage = new TextEncoder().encode(`HOMI_HREQ_V1\n${payloadDigest}`);
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, signature, proofMessage);
    if (!valid) return fail("DEVICE_PROOF_INVALID", "تعذر إثبات أن ملف الطلب صادر من هذا الجهاز.", 403);
  } catch {
    return fail("DEVICE_PROOF_INVALID", "تعذر التحقق من توقيع ملف الطلب.", 403);
  }

  const fileHash = hex(await sha256(fileBytes));
  const existing = await env.DB.prepare(
    `SELECT ar.id, ar.status, ar.key_fingerprint, f.sha256_hex
     FROM activation_requests ar
     LEFT JOIN activation_request_files f ON f.activation_request_id = ar.id
     WHERE ar.id = ? LIMIT 1`
  ).bind(requestId).first<{ id: string; status: string; key_fingerprint: string; sha256_hex: string | null }>();
  if (existing) {
    if (existing.key_fingerprint === fingerprint && existing.sha256_hex === fileHash) {
      return json({
        activation_request_id: existing.id,
        status: existing.status,
        key_fingerprint: fingerprint,
        support_whatsapp: env.SUPPORT_PHONE.replace(/^\+/, ""),
        idempotent_replay: true,
      }, 200);
    }
    return fail("ACTIVATION_REQUEST_ID_CONFLICT", "معرف الطلب مستخدم مسبقًا لملف مختلف.", 409);
  }

  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE product_key = ? AND is_active = 1"
  ).bind(productKey).first<{ id: string }>();
  if (!product) return fail("PRODUCT_UNAVAILABLE", "التطبيق غير متاح لطلبات التفعيل حاليًا.", 404);

  const deviceById = await env.DB.prepare(
    "SELECT id, key_fingerprint FROM devices WHERE id = ? AND product_id = ? LIMIT 1"
  ).bind(deviceId, product.id).first<{ id: string; key_fingerprint: string }>();
  if (deviceById && deviceById.key_fingerprint !== fingerprint) {
    return fail("DEVICE_ID_CONFLICT", "معرف الجهاز مرتبط بمفتاح مختلف.", 409);
  }
  const deviceByKey = await env.DB.prepare(
    "SELECT id FROM devices WHERE product_id = ? AND key_fingerprint = ? LIMIT 1"
  ).bind(product.id, fingerprint).first<{ id: string }>();
  if (deviceByKey && deviceByKey.id !== deviceId) {
    return fail("DEVICE_ID_CONFLICT", "مفتاح الجهاز مرتبط بمعرف جهاز آخر.", 409);
  }

  const now = new Date().toISOString();
  const challenge = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeExpires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const fileKey = `activation-requests/${requestId}/${fileHash}-${crypto.randomUUID()}.hreq`;
  await env.FILES.put(fileKey, fileBytes, {
    httpMetadata: { contentType: "application/vnd.homi.activation-request+json" },
    customMetadata: { requestId, productKey: "homi-grocery", sha256: fileHash },
  });

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO devices
         (id, product_id, platform_key, architecture_key, device_label, public_key_raw_b64url,
          key_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(deviceId, product.id, platform, architecture, deviceLabel, publicKeyText, fingerprint, now, now),
      env.DB.prepare(
        `UPDATE devices SET platform_key = ?, architecture_key = ?, device_label = ?, updated_at = ?
         WHERE id = ? AND product_id = ? AND key_fingerprint = ?`
      ).bind(platform, architecture, deviceLabel, now, deviceId, product.id, fingerprint),
      env.DB.prepare(
        `INSERT INTO activation_requests
         (id, product_id, platform_key, architecture_key, device_label, public_key_raw_b64url,
          key_fingerprint, challenge, challenge_expires_at, proof_verified_at, status,
          requested_plan, customer_name_snapshot, customer_phone_snapshot, customer_notes,
          source, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proof_verified', ?, ?, ?, ?, 'hreq_upload', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM devices WHERE id = ? AND product_id = ? AND key_fingerprint = ?
         )`
      ).bind(requestId, product.id, platform, architecture, deviceLabel, publicKeyText, fingerprint,
        challenge, challengeExpires, now, requestedPlan, customerName, customerPhone, notes || null, now, now,
        deviceId, product.id, fingerprint),
      env.DB.prepare(
        `INSERT INTO activation_request_files
         (id, activation_request_id, original_file_name, sha256_hex, size_bytes,
          r2_object_key, validation_status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, 'valid', ?
         WHERE EXISTS (SELECT 1 FROM activation_requests WHERE id = ?)`
      ).bind(crypto.randomUUID(), requestId, file.name.slice(0, 180), fileHash, fileBytes.length, fileKey, now, requestId),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1 ||
        (results[3]?.meta.changes ?? 0) !== 1) {
      throw new Error("HREQ records were not created atomically.");
    }
  } catch {
    await env.FILES.delete(fileKey).catch(() => undefined);
    return fail("HREQ_IMPORT_FAILED", "تعذر تسجيل ملف الطلب؛ لم يتم إنشاء طلب تفعيل.", 409);
  }

  return json({
    activation_request_id: requestId,
    status: "proof_verified",
    key_fingerprint: fingerprint,
    support_whatsapp: env.SUPPORT_PHONE.replace(/^\+/, ""),
    idempotent_replay: false,
  }, 201);
}
