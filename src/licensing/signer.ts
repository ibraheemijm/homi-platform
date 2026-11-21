import type { Env } from "../types";

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Signing key encoding is invalid.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** المفتاح الخاص يمرر كـ Worker Secret بصيغة Base64 PKCS#8 ولا يرفع إلى Git. */
export async function signLicensePayload(
  env: Env,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  const encodedKey = env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64?.trim();
  const keyId = env.LICENSE_SIGNING_KEY_ID?.trim();
  if (!encodedKey || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("License signing is not configured.");
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", decodeBase64(encodedKey), { name: "Ed25519" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, payload));
  if (signature.length !== 64) throw new Error("Ed25519 produced an invalid signature length.");
  return { keyId, signatureB64: encodeBase64(signature) };
}

export function encodePayloadBase64(payload: Uint8Array): string {
  return encodeBase64(payload);
}
