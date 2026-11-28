import type { Env } from "../types";
import { decodePublicKeyDer, encodePayloadBase64, signRootPayload } from "./signer";

function timestamp(date: Date): string {
  return date.toISOString();
}

export async function createSignedSigningKeyset(env: Env): Promise<Record<string, unknown>> {
  const licenseKeyId = env.LICENSE_SIGNING_KEY_ID?.trim();
  const updateKeyId = env.UPDATE_SIGNING_KEY_ID?.trim();
  if (!licenseKeyId || !updateKeyId || licenseKeyId === updateKeyId) {
    throw new Error("Distinct license and update signing key IDs are required.");
  }
  const licensePublicKey = decodePublicKeyDer(env.LICENSE_SIGNING_PUBLIC_KEY_DER_B64);
  const updatePublicKey = decodePublicKeyDer(env.UPDATE_SIGNING_PUBLIC_KEY_DER_B64);
  const now = new Date();
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  const utcDay = Math.floor(now.getTime() / dayMilliseconds);
  const dayStart = new Date(utcDay * dayMilliseconds);
  // يظل محتوى Keyset ثابتًا طوال اليوم؛ يتغير الإصدار مرة يوميًا لتجنب رفض العميل
  // لنفس رقم الإصدار مع payload مختلف بسبب أوقات الإصدار المتغيرة.
  const issuedAt = timestamp(dayStart);
  const expiresAt = timestamp(new Date((utcDay + 30) * dayMilliseconds));
  // تاريخ صلاحية المفتاح ثابت؛ لا يتغير مع كل تجديد للـKeyset حتى تبقى التواقيع السابقة قابلة للتحقق.
  const notBefore = "2020-01-01T00:00:00.000Z";
  const notAfter = "2099-12-31T23:59:59.000Z";
  const versionText = env.SIGNING_KEYSET_VERSION?.trim() || "1";
  const versionSeed = Number(versionText);
  const version = versionSeed + utcDay;
  if (!Number.isSafeInteger(versionSeed) || versionSeed < 1 ||
      !Number.isSafeInteger(version) || version < 1) {
    throw new Error("SIGNING_KEYSET_VERSION must be a positive integer.");
  }

  const keys: Array<Record<string, unknown>> = [
    {
      key_id: licenseKeyId,
      purpose: "offline_license_grant",
      algorithm: "Ed25519",
      public_key: encodePayloadBase64(licensePublicKey),
      status: "active",
      not_before: notBefore,
      not_after: notAfter,
      signing_not_after: null,
    },
    {
      key_id: updateKeyId,
      purpose: "update_manifest",
      algorithm: "Ed25519",
      public_key: encodePayloadBase64(updatePublicKey),
      status: "active",
      not_before: notBefore,
      not_after: notAfter,
      signing_not_after: null,
    },
  ];
  const additionalText = env.SIGNING_KEYSET_ADDITIONAL_KEYS_JSON?.trim() || "[]";
  let additional: unknown;
  try {
    additional = JSON.parse(additionalText);
  } catch {
    throw new Error("SIGNING_KEYSET_ADDITIONAL_KEYS_JSON must be valid JSON.");
  }
  if (!Array.isArray(additional) || additional.length > 98) {
    throw new Error("At most 98 additional verification keys are allowed.");
  }
  const ids = new Set([licenseKeyId, updateKeyId]);
  for (const raw of additional) {
    if (!raw || typeof raw !== "object") throw new Error("Additional signing key is invalid.");
    const key = raw as Record<string, unknown>;
    const keyId = key.key_id;
    const purpose = key.purpose;
    const publicKey = key.public_key;
    const status = key.status;
    const notBeforeText = key.not_before;
    const notAfterText = key.not_after;
    const signingNotAfterText = key.signing_not_after;
    if (typeof keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId) ||
        ids.has(keyId) ||
        !["offline_license_grant", "update_manifest"].includes(String(purpose)) ||
        typeof publicKey !== "string" ||
        !["verify_only", "revoked"].includes(String(status)) ||
        typeof notBeforeText !== "string" || typeof notAfterText !== "string" ||
        (signingNotAfterText !== null && typeof signingNotAfterText !== "string")) {
      throw new Error("Additional signing key fields are invalid.");
    }
    const notBeforeDate = new Date(notBeforeText);
    const notAfterDate = new Date(notAfterText);
    const signingNotAfterDate = typeof signingNotAfterText === "string"
      ? new Date(signingNotAfterText) : null;
    if (!Number.isFinite(notBeforeDate.getTime()) ||
        !Number.isFinite(notAfterDate.getTime()) ||
        notAfterDate <= notBeforeDate ||
        (status === "verify_only" && !signingNotAfterDate) ||
        (signingNotAfterDate &&
          (!Number.isFinite(signingNotAfterDate.getTime()) ||
            signingNotAfterDate < notBeforeDate ||
            signingNotAfterDate > notAfterDate))) {
      throw new Error("Additional signing key validity period is invalid.");
    }
    const publicDer = decodePublicKeyDer(publicKey);
    ids.add(keyId);
    keys.push({
      key_id: keyId,
      purpose,
      algorithm: "Ed25519",
      public_key: encodePayloadBase64(publicDer),
      status,
      not_before: timestamp(notBeforeDate),
      not_after: timestamp(notAfterDate),
      signing_not_after: signingNotAfterDate ? timestamp(signingNotAfterDate) : null,
    });
  }

  const payload = new TextEncoder().encode(JSON.stringify({
    schema_version: 1,
    keyset_version: version,
    issued_at: issuedAt,
    expires_at: expiresAt,
    keys,
  }));
  const signature = await signRootPayload(env, payload);
  return {
    root_key_id: signature.keyId,
    payload: encodePayloadBase64(payload),
    signature: signature.signatureB64,
  };
}
