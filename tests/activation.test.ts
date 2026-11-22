import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function testEnv(): Env {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ request_count: 1 }),
      }),
    }),
  };
  return {
    DB: db,
    SUPPORT_PHONE: "+249900000000",
    PUBLIC_SITE_ORIGIN: "https://homi.example",
    ADMIN_SITE_ORIGIN: "https://admin.homi.example",
  } as unknown as Env;
}

describe("Homi Platform activation API routes", () => {
  it("routes direct activation requests through the real worker and validates required fields", async () => {
    const response = await worker.fetch(
      new Request("https://api.homi.example/api/v1/public/activation-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      testEnv(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_ACTIVATION_REQUEST" },
    });
  });

  it("rejects an invalid activation proof request ID before database access", async () => {
    const response = await worker.fetch(
      new Request("https://api.homi.example/api/v1/public/activation-requests/not-a-uuid/proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: "x", signature: "y" }),
      }),
      testEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("rejects an invalid activation status request ID before database access", async () => {
    const response = await worker.fetch(
      new Request("https://api.homi.example/api/v1/public/activation-requests/not-a-uuid/status"),
      testEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("requires configured Backblaze storage before accepting an HREQ upload", async () => {
    const response = await worker.fetch(
      new Request("https://api.homi.example/api/v1/public/activation-requests/import", {
        method: "POST",
        body: new FormData(),
      }),
      testEnv(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "FILE_STORAGE_UNAVAILABLE" },
    });
  });
});
