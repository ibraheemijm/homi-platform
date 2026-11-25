import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import worker from "../src/index";

function preflight(origin: string): Request {
  return new Request("https://api.homi.example/api/v1/public/activation-requests/import", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

describe("Homi Platform CORS policy", () => {
  const env = {
    ADMIN_SITE_ORIGIN: "https://foundation-platform-api-v1.homi-admin-console-preview.pages.dev",
    PUBLIC_SITE_ORIGIN: "https://foundation-public-site-v1.homi-public-preview.pages.dev",
  } as unknown as Env;

  it("allows the configured admin origin to preflight PATCH requests", async () => {
    const origin = env.ADMIN_SITE_ORIGIN;
    const request = new Request("https://api.homi.example/api/v1/admin/customers/customer-id", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("allows the actual Cloudflare Pages deployment hostname for the public site", async () => {
    const origin = "https://a5716bdc.homi-public-preview.pages.dev";
    const response = await worker.fetch(preflight(origin), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("allows the actual Cloudflare Pages deployment hostname for the admin console", async () => {
    const origin = "https://08a6c382.homi-admin-console-preview.pages.dev";
    const response = await worker.fetch(preflight(origin), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("does not grant CORS access to lookalike or nested origins", async () => {
    for (const origin of [
      "https://attacker.example",
      "https://a5716bdc.homi-public-preview.pages.dev.attacker.example",
      "https://nested.a5716bdc.homi-public-preview.pages.dev",
      "http://a5716bdc.homi-public-preview.pages.dev",
    ]) {
      const response = await worker.fetch(preflight(origin), env);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("");
    }
  });
});
