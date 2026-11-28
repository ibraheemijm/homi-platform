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

export type SigningKeyHealth = "ready" | "missing" | "invalid" | "mismatch";

/** يفحص جاهزية المفتاح دون إظهار قيمته أو تنفيذ عملية إصدار فعلية. */
export async function inspectSigningKeyConfiguration(
  encodedKey: string | undefined,
  keyIdValue: string | undefined,
  publicKeyDerValue?: string,
): Promise<SigningKeyHealth> {
  const encoded = encodedKey?.trim();
  const keyId = keyIdValue?.trim();
  if (!encoded || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    return "missing";
  }
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", decodeBase64(encoded), { name: "Ed25519" }, false, ["sign"],
    );
    const probe = new TextEncoder().encode("HOMI_SIGNING_KEY_SELF_TEST_V1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, probe);
    if (signature.byteLength !== 64) return "invalid";
    if (publicKeyDerValue) {
      const publicKey = await crypto.subtle.importKey(
        "spki",
        decodePublicKeyDer(publicKeyDerValue),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const matches = await crypto.subtle.verify("Ed25519", publicKey, signature, probe);
      if (!matches) return "mismatch";
    }
    return "ready";
  } catch {
    return "invalid";
  }
}

async function signWithKey(
  encodedKey: string | undefined,
  keyIdValue: string | undefined,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  const encoded = encodedKey?.trim();
  const keyId = keyIdValue?.trim();
  if (!encoded || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("Signing key is not configured.");
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", decodeBase64(encoded), { name: "Ed25519" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, payload));
  if (signature.length !== 64) throw new Error("Ed25519 produced an invalid signature length.");
  return { keyId, signatureB64: encodeBase64(signature) };
}

async function signWithConfiguredPair(
  encodedPrivateKey: string | undefined,
  keyId: string | undefined,
  encodedPublicKey: string | undefined,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  const signed = await signWithKey(encodedPrivateKey, keyId, payload);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    decodePublicKeyDer(encodedPublicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    decodeBase64(signed.signatureB64),
    payload,
  );
  if (!valid) {
    throw new Error("Signing private key does not match configured public key.");
  }
  return signed;
}

/** المفتاح الخاص يمرر كـ Worker Secret بصيغة Base64 PKCS#8 ولا يرفع إلى Git. */
export async function signLicensePayload(
  env: Env,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  return signWithConfiguredPair(
    env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64,
    env.LICENSE_SIGNING_KEY_ID,
    env.LICENSE_SIGNING_PUBLIC_KEY_DER_B64,
    payload,
  );
}

/** مفتاح منفصل لتوقيع بيانات تحديثات التطبيقات. */
export async function signUpdatePayload(
  env: Env,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  return signWithConfiguredPair(
    env.UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64,
    env.UPDATE_SIGNING_KEY_ID,
    env.UPDATE_SIGNING_PUBLIC_KEY_DER_B64,
    payload,
  );
}

/** جذر الثقة يوقّع Keyset فقط؛ لا يستخدم لتوقيع التراخيص أو حزم التطبيقات. */
export async function signRootPayload(
  env: Env,
  payload: Uint8Array,
): Promise<{ keyId: string; signatureB64: string }> {
  return signWithKey(
    env.ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64,
    env.ROOT_SIGNING_KEY_ID,
    payload,
  );
}

export function encodePayloadBase64(payload: Uint8Array): string {
  return encodeBase64(payload);
}

export function decodePublicKeyDer(value: string | undefined): Uint8Array {
  if (!value) throw new Error("Public signing key is not configured.");
  const decoded = decodeBase64(value.trim());
  const spkiPrefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
  if (decoded.length !== 44 || !spkiPrefix.every((byte, index) => decoded[index] === byte)) {
    throw new Error("Ed25519 public key must be DER/SPKI (44 bytes).");
  }
  return decoded;
}
