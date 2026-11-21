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
  const issuedAt = timestamp(now);
  const expiresAt = timestamp(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
  const notBefore = timestamp(new Date(now.getTime() - 5 * 60 * 1000));
  const notAfter = "2099-12-31T23:59:59.000Z";
  const versionText = env.SIGNING_KEYSET_VERSION?.trim() || "1";
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("SIGNING_KEYSET_VERSION must be a positive integer.");
  }

  const payload = new TextEncoder().encode(JSON.stringify({
    schema_version: 1,
    keyset_version: version,
    issued_at: issuedAt,
    expires_at: expiresAt,
    keys: [
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
    ],
  }));
  const signature = await signRootPayload(env, payload);
  return {
    root_key_id: signature.keyId,
    payload: encodePayloadBase64(payload),
    signature: signature.signatureB64,
  };
}
