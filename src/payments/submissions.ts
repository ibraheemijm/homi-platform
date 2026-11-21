import type { Env } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function submitPaymentEvidence(
  request: Request,
  env: Env,
  activationRequestId: string,
): Promise<Response> {
  if (!UUID_RE.test(activationRequestId)) return fail("ACTIVATION_REQUEST_NOT_FOUND", "طلب التفعيل غير موجود.", 404);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_PROOF_BYTES + 16 * 1024) return fail("PROOF_TOO_LARGE", "حجم إثبات الدفع يتجاوز 8 ميجابايت.", 413);

  let form: FormData;
  try { form = await request.formData(); }
  catch { return fail("INVALID_MULTIPART", "تعذر قراءة بيانات الدفع.", 400); }

  const method = form.get("method");
  const amountRaw = form.get("amount_minor");
  const currencyRaw = form.get("currency");
  const referenceRaw = form.get("reference_note");
  const file = form.get("proof");
  const amountMinor = typeof amountRaw === "string" ? Number(amountRaw) : Number.NaN;
  const currency = typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
  const referenceNote = typeof referenceRaw === "string" ? referenceRaw.trim() : "";

  if (typeof method !== "string" || !["cash", "bank_transfer", "other"].includes(method) ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 1 ||
      !/^[A-Z]{3}$/.test(currency) || referenceNote.length > 500) {
    return fail("INVALID_PAYMENT_SUBMISSION", "طريقة الدفع أو المبلغ أو العملة أو المرجع غير صالح.", 422);
  }

  let proofBytes: Uint8Array | null = null;
  let proofContentType: string | null = null;
  let proofFileName: string | null = null;
  let proofHash: string | null = null;
  if (file !== null) {
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_PROOF_BYTES) {
      return fail("INVALID_PAYMENT_PROOF", "ملف إثبات الدفع غير صالح أو أكبر من 8 ميجابايت.", 422);
    }
    proofContentType = file.type.toLowerCase();
    const extension = MIME_EXTENSIONS[proofContentType];
    if (!extension) return fail("UNSUPPORTED_PAYMENT_PROOF", "الصيغ المدعومة هي JPG وPNG وWEBP وPDF فقط.", 422);
    proofBytes = new Uint8Array(await file.arrayBuffer());
    proofHash = await sha256(proofBytes);
    proofFileName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || `proof.${extension}`;
  }
  if (method === "bank_transfer" && !proofBytes) {
    return fail("PAYMENT_PROOF_REQUIRED", "يرجى إرفاق صورة أو PDF لإثبات التحويل البنكي.", 422);
  }
  if (proofBytes && !env.FILES) {
    return fail("FILE_STORAGE_UNAVAILABLE", "تخزين إثباتات الدفع غير مهيأ لهذه البيئة.", 503);
  }

  const activation = await env.DB.prepare(
    `SELECT id, status FROM activation_requests WHERE id = ? LIMIT 1`
  ).bind(activationRequestId).first<{ id: string; status: string }>();
  if (!activation || !["proof_verified", "under_review"].includes(activation.status)) {
    return fail("ACTIVATION_NOT_PAYABLE", "لا يمكن إرفاق دفعة بهذا الطلب في حالته الحالية.", 409);
  }

  const confirmed = await env.DB.prepare(
    `SELECT id FROM payment_submissions
     WHERE activation_request_id = ? AND status = 'confirmed'
     LIMIT 1`
  ).bind(activationRequestId).first<{ id: string }>();
  if (confirmed) {
    return fail("PAYMENT_ALREADY_CONFIRMED", "تم تأكيد دفعة لهذا الطلب بالفعل.", 409);
  }

  const pending = await env.DB.prepare(
    `SELECT id, status FROM payment_submissions
     WHERE activation_request_id = ? AND status = 'pending_review'
     ORDER BY submitted_at DESC LIMIT 1`
  ).bind(activationRequestId).first<{ id: string; status: string }>();
  if (pending) {
    return fail("PAYMENT_ALREADY_PENDING", "يوجد إثبات دفع قيد المراجعة لهذا الطلب بالفعل.", 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let proofObjectKey: string | null = null;
  if (proofBytes && proofHash && proofContentType && proofFileName && env.FILES) {
    const extension = MIME_EXTENSIONS[proofContentType];
    proofObjectKey = `payment-evidence/${activationRequestId}/${id}/${proofHash}.${extension}`;
    await env.FILES.put(proofObjectKey, proofBytes, {
      httpMetadata: { contentType: proofContentType },
      customMetadata: { activationRequestId, paymentSubmissionId: id, sha256: proofHash },
    });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO payment_submissions
       (id, activation_request_id, method, amount_minor, currency, reference_note,
        proof_object_key, proof_file_name, proof_content_type, proof_size_bytes,
        proof_sha256_hex, status, submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)`
    ).bind(
      id, activationRequestId, method, amountMinor, currency, referenceNote || null,
      proofObjectKey, proofFileName, proofContentType, proofBytes?.length ?? null,
      proofHash, now, now, now,
    ).run();
  } catch {
    if (proofObjectKey && env.FILES) await env.FILES.delete(proofObjectKey).catch(() => undefined);
    return fail("PAYMENT_SUBMISSION_FAILED", "تعذر تسجيل إثبات الدفع. حاول مرة أخرى.", 409);
  }

  return json({
    payment_submission_id: id,
    activation_request_id: activationRequestId,
    status: "pending_review",
    has_proof: Boolean(proofObjectKey),
    submitted_at: now,
  }, 201);
}
