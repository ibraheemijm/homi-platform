import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import worker from "../src/index";

describe("Homi Platform CORS policy", () => {
  it("allows the configured admin origin to preflight PATCH requests", async () => {
    const origin = "https://admin.homi.example";
    const env = {
      ADMIN_SITE_ORIGIN: origin,
      PUBLIC_SITE_ORIGIN: "https://homi.example",
    } as unknown as Env;
    const request = new Request("https://api.homi.example/api/v1/admin/customers/customer-id", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const env = {
      ADMIN_SITE_ORIGIN: "https://admin.homi.example",
      PUBLIC_SITE_ORIGIN: "https://homi.example",
    } as unknown as Env;
    const request = new Request("https://api.homi.example/api/v1/admin/customers/customer-id", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("");
  });
});
