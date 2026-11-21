import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { signLicensePayload } from "../src/licensing/signer";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

describe("Ed25519 license signer", () => {
  it("signs the exact payload bytes with the configured key id", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const privateDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8" as const, pair.privateKey) as ArrayBuffer);
    const payload = new TextEncoder().encode('{"schema_version":1,"license_id":"test"}');
    const env = {
      LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64: base64(privateDer),
      LICENSE_SIGNING_KEY_ID: "test-key-v1",
    } as Env;

    const signed = await signLicensePayload(env, payload);
    const valid = await crypto.subtle.verify(
      "Ed25519",
      pair.publicKey,
      decodeBase64(signed.signatureB64),
      payload,
    );

    expect(signed.keyId).toBe("test-key-v1");
    expect(valid).toBe(true);
  });

  it("refuses to sign when the private key is missing", async () => {
    await expect(signLicensePayload({} as Env, new Uint8Array([1, 2, 3])))
      .rejects.toThrow("License signing is not configured.");
  });
});
