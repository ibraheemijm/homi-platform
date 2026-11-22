import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
interface StoredTrial {
  id: string; product_id: string; device_id: string; key_fingerprint: string;
  trial_started_at: string; trial_ends_at: string; first_seen_at: string;
}
function testEnv() {
  let trial: StoredTrial | null = null;
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes("api_rate_limits")) return { request_count: 1 };
              if (sql.includes("FROM products")) return { id: "prod_homi_grocery_v1" };
              if (sql.includes("FROM trial_registrations")) {
                const [productId, fingerprint, deviceId] = values;
                if (trial && trial.product_id === productId &&
                    (trial.key_fingerprint === fingerprint || trial.device_id === deviceId)) return trial;
                return null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes("INSERT OR IGNORE INTO trial_registrations")) {
                if (!trial) {
                  trial = {
                    id: String(values[0]), product_id: String(values[1]), device_id: String(values[2]),
                    key_fingerprint: String(values[6]), trial_started_at: String(values[7]),
                    trial_ends_at: String(values[8]), first_seen_at: String(values[9]),
                  };
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db, SUPPORT_PHONE: "+2490904697455",
    PUBLIC_SITE_ORIGIN: "https://homi.example",
    ADMIN_SITE_ORIGIN: "https://admin.homi.example",
  } as unknown as Env;
  return { env, getTrial: () => trial };
}
async function signedTrialBody(startedAt = new Date(Date.now() - 60_000)) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const fingerprint = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
  const deviceId = "123e4567-e89b-42d3-a456-426614174099";
  const normalizedStart = startedAt.toISOString();
  const proof = [
    "HOMI_TRIAL_REGISTRATION_V1", deviceId, "homi-grocery", "android",
    "universal", fingerprint, normalizedStart,
  ].join("\n");
  const signature = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", pair.privateKey, new TextEncoder().encode(proof),
  ));
  return {
    product_key: "homi-grocery", device_id: deviceId, platform_key: "android",
    architecture_key: "universal", public_key: b64url(publicKey),
    key_fingerprint: fingerprint, trial_started_at: normalizedStart,
    signature: b64url(signature),
  };
}
async function register(body: Record<string, unknown>, env: Env) {
  return worker.fetch(new Request("https://api.homi.example/api/v1/public/trials/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
}
describe("Homi Platform local trial registration", () => {
  it("records a device-bound 14-day trial without creating a customer or license", async () => {
    const { env, getTrial } = testEnv();
    const body = await signedTrialBody();
    const response = await register(body, env);
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(result).toMatchObject({ registration_status: "registered", identity_match: "key_fingerprint", trial_started_at: body.trial_started_at });
    expect(Date.parse(String(result.trial_ends_at)) - Date.parse(body.trial_started_at)).toBe(14 * 24 * 60 * 60 * 1000);
    expect(getTrial()).not.toBeNull();
  });
  it("returns the original trial dates when the same device registers again", async () => {
    const { env, getTrial } = testEnv();
    const body = await signedTrialBody();
    const first = await register(body, env);
    const firstResult = await first.json() as Record<string, unknown>;
    const second = await register(body, env);
    const secondResult = await second.json() as Record<string, unknown>;
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondResult.registration_status).toBe("already_registered");
    expect(secondResult.trial_started_at).toBe(firstResult.trial_started_at);
    expect(secondResult.trial_ends_at).toBe(firstResult.trial_ends_at);
    expect(getTrial()).not.toBeNull();
  });
  it("rejects an invalid device signature", async () => {
    const { env } = testEnv();
    const body = await signedTrialBody();
    body.signature = b64url(new Uint8Array(64));
    const response = await register(body, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "DEVICE_PROOF_INVALID" } });
  });
  it("rejects a future local trial start", async () => {
    const { env } = testEnv();
    const body = await signedTrialBody(new Date(Date.now() + 60 * 60 * 1000));
    const response = await register(body, env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_TRIAL_START" } });
  });
});
