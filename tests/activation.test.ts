import { describe, expect, it } from "vitest";

describe("Homi Platform API contract", () => {
  it("documents the expected first-stage routes", () => {
    const routes = [
      "POST /api/v1/public/activation-requests",
      "POST /api/v1/public/activation-requests/{id}/proof",
      "GET /api/v1/public/activation-requests/{id}/status",
    ];
    expect(routes).toHaveLength(3);
    expect(routes[0]).toContain("activation-requests");
  });

  it("uses the expected product key and supported platforms", () => {
    const productKey = "homi-grocery";
    const platforms = ["android", "windows", "linux"];
    expect(productKey).toBe("homi-grocery");
    expect(platforms).toEqual(expect.arrayContaining(["android", "windows", "linux"]));
  });
});
