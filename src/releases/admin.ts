import type { Env } from "../types";
import { authenticateAdmin } from "../security/access";
import { encodePayloadBase64, signUpdatePayload } from "../licensing/signer";
import { getStorage } from "../storage/backblaze";

const API_PREFIX = "/api/v1";

type UploadSession = {
  id: string;
  release_id: string;
  object_key: string;
  upload_id: string;
  file_name: string;
  content_type: string;
  platform_key: string;
  architecture_key: string;
  size_bytes: number;
  sha256_hex: string;
  status: string;
  created_by: string;
};

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(code: string, message: string, status: number, headers: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

function safeFileName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 180 || name.includes("..") || /[\/\\\x00-\x1f]/.test(name)) return null;
  return name;
}

function allowedAsset(platform: string, fileName: string, contentType: string): boolean {
  const extension = fileName.toLowerCase().split(".").pop() || "";
  if (platform === "android") return extension === "apk" && contentType === "application/vnd.android.package-archive";
  if (platform === "windows") return ["exe", "msi", "zip"].includes(extension) &&
    ["application/octet-stream", "application/zip", "application/x-msdownload", "application/x-msi"].includes(contentType);
  if (platform === "linux") return ["appimage", "deb", "rpm", "tar", "gz", "zip"].includes(extension) &&
    ["application/octet-stream", "application/zip", "application/gzip", "application/x-debian-package", "application/vnd.debian.binary-package", "application/x-rpm"].includes(contentType);
  return false;
}

async function admin(request: Request, env: Env, headers: HeadersInit) {
  const auth = await authenticateAdmin(request, env, ["releases.manage"]);
  if (auth.response) return { response: new Response(auth.response.body, {
    status: auth.response.status, statusText: auth.response.statusText,
    headers: { ...Object.fromEntries(new Headers(auth.response.headers)), ...Object.fromEntries(new Headers(headers)) },
  }) };
  return { actor: auth.actor };
}

/** Handles all authenticated release-catalogue management routes. */
export async function handleReleaseAdmin(
  request: Request,
  env: Env,
  path: string,
  headers: HeadersInit,
): Promise<Response | null> {
  if (!path.startsWith("/admin/releases") && !path.startsWith("/admin/release-uploads/")) return null;
  const auth = await admin(request, env, headers);
  if (auth.response) return auth.response;

  if (path === "/admin/releases" && request.method === "GET") {
    const productKey = new URL(request.url).searchParams.get("product_key") || "homi-grocery";
    const rows = await env.DB.prepare(
      `SELECT r.id, p.product_key, p.display_name, r.version, r.build_number, r.channel,
              r.status, r.release_notes_ar, r.release_notes_en, r.published_at, r.created_at,
              (SELECT COUNT(*) FROM release_assets a WHERE a.release_id = r.id) AS asset_count,
              (SELECT json_group_array(json_object(
                'platform_key', a.platform_key, 'architecture_key', a.architecture_key,
                'file_name', a.file_name, 'size_bytes', a.size_bytes
              )) FROM release_assets a WHERE a.release_id = r.id) AS assets_json
       FROM product_releases r JOIN products p ON p.id = r.product_id
       WHERE p.product_key = ? ORDER BY r.created_at DESC LIMIT 100`
    ).bind(productKey).all();
    return json({ items: rows.results ?? [] }, 200, headers);
  }

  if (path === "/admin/releases" && request.method === "POST") {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const productKey = typeof body?.product_key === "string" ? body.product_key.trim() : "";
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    const buildNumber = typeof body?.build_number === "string" ? body.build_number.trim() : "";
    const channel = body?.channel;
    const notesAr = typeof body?.release_notes_ar === "string" ? body.release_notes_ar.trim() : "";
    const notesEn = typeof body?.release_notes_en === "string" ? body.release_notes_en.trim() : "";
    if (!/^[a-z0-9-]{2,64}$/.test(productKey) ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ||
        !/^[0-9]{1,10}$/.test(buildNumber) ||
        !["stable", "beta", "internal"].includes(String(channel)) ||
        notesAr.length > 4000 || notesEn.length > 4000) {
      return fail("INVALID_RELEASE", "بيانات الإصدار غير صالحة.", 422, headers);
    }
    const product = await env.DB.prepare("SELECT id FROM products WHERE product_key = ? AND is_active = 1 LIMIT 1")
      .bind(productKey).first<{ id: string }>();
    if (!product) return fail("PRODUCT_NOT_FOUND", "التطبيق غير موجود أو غير نشط.", 404, headers);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO product_releases
         (id, product_id, version, build_number, channel, status, release_notes_ar, release_notes_en,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
      ).bind(id, product.id, version, buildNumber, channel, notesAr || null, notesEn || null, auth.actor!.id, now, now).run();
    } catch {
      return fail("RELEASE_CONFLICT", "يوجد إصدار بنفس رقم النسخة والبناء والقناة.", 409, headers);
    }
    return json({ release_id: id, status: "draft" }, 201, headers);
  }

  const storage = getStorage(env);
  if (!storage) return fail("FILE_STORAGE_UNAVAILABLE", "تخزين ملفات الإصدارات غير مهيأ.", 503, headers);

  const startMatch = path.match(/^\/admin\/releases\/([0-9a-f-]{36})\/uploads$/i);
  if (request.method === "POST" && startMatch) {
    const releaseId = startMatch[1];
    const release = await env.DB.prepare(
      "SELECT id, status FROM product_releases WHERE id = ? LIMIT 1"
    ).bind(releaseId).first<{ id: string; status: string }>();
    if (!release) return fail("RELEASE_NOT_FOUND", "الإصدار غير موجود.", 404, headers);
    if (release.status !== "draft") return fail("RELEASE_NOT_EDITABLE", "لا يمكن تعديل إصدار منشور أو مسحوب.", 409, headers);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const platform = typeof body?.platform_key === "string" ? body.platform_key : "";
    const architecture = typeof body?.architecture_key === "string" ? body.architecture_key : "";
    const fileName = typeof body?.file_name === "string" ? safeFileName(body.file_name) : null;
    const contentType = typeof body?.content_type === "string" ? body.content_type : "";
    const sizeBytes = Number(body?.size_bytes);
    const sha256 = typeof body?.sha256_hex === "string" ? body.sha256_hex.toLowerCase() : "";
    if (!["android", "windows", "linux"].includes(platform) ||
        !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(architecture) ||
        !fileName || !allowedAsset(platform, fileName, contentType) ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 1024 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(sha256)) {
      return fail("INVALID_RELEASE_ASSET", "بيانات ملف الإصدار غير صالحة أو حجم الملف يتجاوز 1 جيجابايت.", 422, headers);
    }
    const existingAsset = await env.DB.prepare(
      "SELECT id FROM release_assets WHERE release_id = ? AND platform_key = ? AND architecture_key = ? LIMIT 1"
    ).bind(releaseId, platform, architecture).first<{ id: string }>();
    if (existingAsset) {
      return fail("RELEASE_ASSET_ALREADY_EXISTS", "توجد حزمة لهذه المنصة والمعمارية ضمن الإصدار.", 409, headers);
    }
    const id = crypto.randomUUID();
    const objectKey = `releases/${releaseId}/${id}/${fileName}`;
    const now = new Date().toISOString();
    const upload = await storage.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
      customMetadata: { releaseId, platform, architecture, sha256 },
    });
    try {
      await env.DB.prepare(
        `INSERT INTO release_upload_sessions
         (id, release_id, object_key, upload_id, file_name, content_type, platform_key,
          architecture_key, size_bytes, sha256_hex, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`
      ).bind(id, releaseId, objectKey, upload.uploadId, fileName, contentType, platform,
        architecture, sizeBytes, sha256, auth.actor!.id, now, now).run();
    } catch {
      await upload.abort();
      return fail("UPLOAD_SESSION_FAILED", "تعذر إنشاء جلسة رفع الملف.", 500, headers);
    }
    return json({ upload_session_id: id, chunk_size_bytes: 8 * 1024 * 1024 }, 201, headers);
  }

  const partMatch = path.match(/^\/admin\/release-uploads\/([0-9a-f-]{36})\/parts\/(\d+)$/i);
  if (request.method === "PUT" && partMatch) {
    const session = await env.DB.prepare(
      "SELECT * FROM release_upload_sessions WHERE id = ? AND status = 'uploading' LIMIT 1"
    ).bind(partMatch[1]).first<UploadSession>();
    if (!session) return fail("UPLOAD_SESSION_NOT_FOUND", "جلسة الرفع غير موجودة أو انتهت.", 404, headers);
    const partNumber = Number(partMatch[2]);
    const length = Number(request.headers.get("content-length") || "0");
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 ||
        !request.body || length < 1 || length > 8 * 1024 * 1024) {
      return fail("INVALID_UPLOAD_PART", "جزء الملف غير صالح أو حجمه يتجاوز 8 ميجابايت.", 422, headers);
    }
    const upload = storage.resumeMultipartUpload(session.object_key, session.upload_id);
    const part = await upload.uploadPart(partNumber, request.body);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO release_upload_parts (upload_session_id, part_number, etag, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(upload_session_id, part_number) DO UPDATE SET
         etag = excluded.etag, size_bytes = excluded.size_bytes, created_at = excluded.created_at`
    ).bind(session.id, partNumber, part.etag, length, now).run();
    return json({ part_number: part.partNumber, etag: part.etag }, 200, headers);
  }

  const completeMatch = path.match(/^\/admin\/release-uploads\/([0-9a-f-]{36})\/complete$/i);
  if (request.method === "POST" && completeMatch) {
    const session = await env.DB.prepare(
      "SELECT * FROM release_upload_sessions WHERE id = ? AND status = 'uploading' LIMIT 1"
    ).bind(completeMatch[1]).first<UploadSession>();
    if (!session) return fail("UPLOAD_SESSION_NOT_FOUND", "جلسة الرفع غير موجودة أو انتهت.", 404, headers);
    const partsResult = await env.DB.prepare(
      "SELECT part_number, etag, size_bytes FROM release_upload_parts WHERE upload_session_id = ? ORDER BY part_number"
    ).bind(session.id).all<{ part_number: number; etag: string; size_bytes: number }>();
    const rows = partsResult.results ?? [];
    const total = rows.reduce((sum, row) => sum + row.size_bytes, 0);
    const sequential = rows.every((row, index) => row.part_number === index + 1);
    if (!rows.length || !sequential || total !== session.size_bytes) {
      return fail("UPLOAD_INCOMPLETE", "لم تكتمل جميع أجزاء الملف أو لا يطابق الحجم المتوقع.", 409, headers);
    }
    const upload = storage.resumeMultipartUpload(session.object_key, session.upload_id);
    const completed = await upload.complete(rows.map((row) => ({ partNumber: row.part_number, etag: row.etag })));
    if (completed.size !== session.size_bytes) {
      await storage.delete(session.object_key);
      await env.DB.prepare("UPDATE release_upload_sessions SET status = 'failed', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), session.id).run();
      return fail("UPLOAD_SIZE_MISMATCH", "حجم الملف بعد الرفع لا يطابق الحجم المتوقع.", 409, headers);
    }
    try {
      const assetId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO release_assets
           (id, release_id, platform_key, architecture_key, file_name, content_type, size_bytes,
            sha256_hex, r2_object_key, signature_key_id, signature_b64, manifest_payload_b64,
            is_primary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?)`
        ).bind(assetId, session.release_id, session.platform_key, session.architecture_key,
          session.file_name, session.content_type, session.size_bytes, session.sha256_hex,
          session.object_key, now),
        env.DB.prepare("UPDATE release_upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?")
          .bind(now, session.id),
        env.DB.prepare(
          `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, after_json, created_at)
           VALUES (?, ?, 'release.asset_uploaded', 'release_asset', ?, ?, ?)`
        ).bind(crypto.randomUUID(), auth.actor!.id, assetId, JSON.stringify({
          release_id: session.release_id, platform_key: session.platform_key,
          architecture_key: session.architecture_key, file_name: session.file_name,
          size_bytes: session.size_bytes, sha256_hex: session.sha256_hex,
        }), now),
      ]);
      return json({ asset_id: assetId, status: "uploaded", sha256: session.sha256_hex }, 201, headers);
    } catch {
      await storage.delete(session.object_key);
      await env.DB.prepare("UPDATE release_upload_sessions SET status = 'failed', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), session.id).run();
      return fail("RELEASE_ASSET_SAVE_FAILED", "تعذر حفظ ملف الإصدار وبياناته.", 503, headers);
    }
  }

  const publishMatch = path.match(/^\/admin\/releases\/([0-9a-f-]{36})\/publish$/i);
  if (request.method === "POST" && publishMatch) {
    const releaseId = publishMatch[1];
    const release = await env.DB.prepare(
      `SELECT r.id, r.status, r.version, r.build_number, r.channel,
              r.release_notes_ar, r.release_notes_en, p.product_key
       FROM product_releases r JOIN products p ON p.id = r.product_id
       WHERE r.id = ? LIMIT 1`
    ).bind(releaseId).first<{
      id: string; status: string; version: string; build_number: string; channel: string;
      release_notes_ar: string | null; release_notes_en: string | null; product_key: string;
    }>();
    if (!release) return fail("RELEASE_NOT_FOUND", "الإصدار غير موجود.", 404, headers);
    if (release.status !== "draft") return fail("RELEASE_NOT_EDITABLE", "الإصدار ليس مسودة.", 409, headers);
    const versionCode = Number(release.build_number);
    if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 0x7fffffff) {
      return fail("INVALID_BUILD_NUMBER", "رقم البناء يجب أن يكون عددًا صحيحًا موجبًا.", 422, headers);
    }
    const assets = await env.DB.prepare(
      `SELECT id, platform_key, architecture_key, file_name, size_bytes, sha256_hex
       FROM release_assets WHERE release_id = ? ORDER BY platform_key, architecture_key`
    ).bind(releaseId).all<{
      id: string; platform_key: string; architecture_key: string;
      file_name: string; size_bytes: number; sha256_hex: string;
    }>();
    const assetRows = assets.results ?? [];
    if (assetRows.length < 1) return fail("RELEASE_ASSET_REQUIRED", "أضف ملف تثبيت واحدًا على الأقل قبل النشر.", 409, headers);
    const now = new Date().toISOString();
    const updates: D1PreparedStatement[] = [];
    try {
      for (const asset of assetRows) {
        const downloadPath = `${API_PREFIX}/updates/${asset.id}/download`;
        const manifest = {
          schema_version: 1,
          publication_id: asset.id,
          product_key: release.product_key,
          platform: asset.platform_key,
          architecture: asset.architecture_key,
          channel: release.channel,
          version: release.version,
          version_code: versionCode,
          file_name: asset.file_name,
          size_bytes: asset.size_bytes,
          sha256: asset.sha256_hex,
          key_id: env.UPDATE_SIGNING_KEY_ID,
          download_url: downloadPath,
          published_at: now,
          release_notes: release.release_notes_en || release.release_notes_ar || null,
        };
        const payload = new TextEncoder().encode(JSON.stringify(manifest));
        const signature = await signUpdatePayload(env, payload);
        updates.push(env.DB.prepare(
          `UPDATE release_assets
           SET signature_key_id = ?, signature_b64 = ?, manifest_payload_b64 = ?
           WHERE id = ? AND release_id = ?`
        ).bind(signature.keyId, signature.signatureB64, encodePayloadBase64(payload), asset.id, releaseId));
      }
    } catch {
      return fail("RELEASE_SIGNING_FAILED", "تعذر توقيع بيانات الإصدار. تحقق من مفتاح تحديثات Ed25519.", 503, headers);
    }
    await env.DB.batch([
      ...updates,
      env.DB.prepare("UPDATE product_releases SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
        .bind(now, now, releaseId),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, after_json, created_at)
         VALUES (?, ?, 'release.published', 'product_release', ?, ?, ?)`
      ).bind(crypto.randomUUID(), auth.actor!.id, releaseId, JSON.stringify({
        status: "published", asset_count: assetRows.length, version: release.version,
        build_number: release.build_number, channel: release.channel,
      }), now),
    ]);
    return json({ release_id: releaseId, status: "published", published_at: now }, 200, headers);
  }

  const withdrawMatch = path.match(/^\/admin\/releases\/([0-9a-f-]{36})\/withdraw$/i);
  if (request.method === "POST" && withdrawMatch) {
    const releaseId = withdrawMatch[1];
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      "UPDATE product_releases SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'published'"
    ).bind(now, releaseId).run();
    if ((result.meta.changes ?? 0) !== 1) return fail("RELEASE_NOT_WITHDRAWABLE", "الإصدار غير منشور أو غير موجود.", 409, headers);
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_admin_id, action_key, entity_type, entity_id, after_json, created_at)
       VALUES (?, ?, 'release.withdrawn', 'product_release', ?, ?, ?)`
    ).bind(crypto.randomUUID(), auth.actor!.id, releaseId, JSON.stringify({ status: "withdrawn" }), now).run();
    return json({ release_id: releaseId, status: "withdrawn" }, 200, headers);
  }

  return fail("METHOD_NOT_ALLOWED", "طريقة الطلب غير مدعومة لهذا المسار.", 405, headers);
}
