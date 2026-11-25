import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { inspectSigningKeyConfiguration, signLicensePayload } from "../src/licensing/signer";
import { createSignedSigningKeyset } from "../src/licensing/keyset";

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

  it("reports missing and invalid signing keys without exposing key material", async () => {
    expect(await inspectSigningKeyConfiguration(undefined, "key-v1")).toBe("missing");
    expect(await inspectSigningKeyConfiguration("not-base64", "key-v1")).toBe("invalid");
    expect(await inspectSigningKeyConfiguration("AQID", "")).toBe("missing");
  });

  it("reports a valid Ed25519 PKCS#8 private key as ready", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const privateDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8" as const, pair.privateKey) as ArrayBuffer);
    expect(await inspectSigningKeyConfiguration(base64(privateDer), "test-key-v1")).toBe("ready");
  });

  it("refuses to sign when the private key is missing", async () => {
    await expect(signLicensePayload({} as Env, new Uint8Array([1, 2, 3])))
      .rejects.toThrow("Signing key is not configured.");
  });

  it("publishes a root-signed keyset with distinct offline-grant and update keys", async () => {
    const root = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const license = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const update = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const rootPrivate = new Uint8Array(await crypto.subtle.exportKey("pkcs8" as const, root.privateKey) as ArrayBuffer);
    const licensePublic = new Uint8Array(await crypto.subtle.exportKey("spki" as const, license.publicKey) as ArrayBuffer);
    const updatePublic = new Uint8Array(await crypto.subtle.exportKey("spki" as const, update.publicKey) as ArrayBuffer);
    const env = {
      ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64: base64(rootPrivate),
      ROOT_SIGNING_KEY_ID: "homi-root-v1",
      LICENSE_SIGNING_KEY_ID: "homi-license-v1",
      LICENSE_SIGNING_PUBLIC_KEY_DER_B64: base64(licensePublic),
      UPDATE_SIGNING_KEY_ID: "homi-update-v1",
      UPDATE_SIGNING_PUBLIC_KEY_DER_B64: base64(updatePublic),
      SIGNING_KEYSET_VERSION: "3",
    } as Env;

    const envelope = await createSignedSigningKeyset(env);
    const payload = decodeBase64(envelope.payload as string);
    const signature = decodeBase64(envelope.signature as string);
    const valid = await crypto.subtle.verify("Ed25519", root.publicKey, signature, payload);
    const claims = JSON.parse(new TextDecoder().decode(payload));

    expect(envelope.root_key_id).toBe("homi-root-v1");
    expect(valid).toBe(true);
    expect(claims.keyset_version).toBeGreaterThan(3);
    expect(claims.keys.map((key: { purpose: string }) => key.purpose))
      .toEqual(["offline_license_grant", "update_manifest"]);
    expect(claims.keys[0].key_id).not.toBe(claims.keys[1].key_id);
  });

});
