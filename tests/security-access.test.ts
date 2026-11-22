import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { authenticateAdmin } from "../src/security/access";

describe("Cloudflare Access admin authentication", () => {
  it("fails closed when Access issuer or audience is not configured", async () => {
    const env = {} as Env;
    const request = new Request("https://api.homi.example/api/v1/admin/me");

    const result = await authenticateAdmin(request, env);

    expect(result.actor).toBeUndefined();
    expect(result.response?.status).toBe(503);
    expect(result.response?.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects requests without an Access JWT even if an email header is supplied", async () => {
    const env = {
      CF_ACCESS_TEAM_DOMAIN: "https://homi-team.cloudflareaccess.com",
      CF_ACCESS_AUD: "expected-audience",
    } as unknown as Env;
    const request = new Request("https://api.homi.example/api/v1/admin/me", {
      headers: { "Cf-Access-Authenticated-User-Email": "owner@example.test" },
    });

    const result = await authenticateAdmin(request, env);

    expect(result.actor).toBeUndefined();
    expect(result.response?.status).toBe(401);
  });

  it("rejects a non-Cloudflare Access issuer configuration", async () => {
    const env = {
      CF_ACCESS_TEAM_DOMAIN: "https://attacker.example",
      CF_ACCESS_AUD: "expected-audience",
    } as unknown as Env;
    const request = new Request("https://api.homi.example/api/v1/admin/me", {
      headers: { "cf-access-jwt-assertion": "untrusted-token" },
    });

    const result = await authenticateAdmin(request, env);

    expect(result.actor).toBeUndefined();
    expect(result.response?.status).toBe(503);
  });
});
