import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const authenticateAdmin = vi.hoisted(() => vi.fn());
vi.mock("../src/security/access", () => ({ authenticateAdmin }));

import { handleCustomerAdmin } from "../src/admin/customers";

function fakeEnv(options: {
  first?: (sql: string, values: unknown[]) => unknown;
  batchChanges?: number[];
} = {}) {
  const batchCalls: string[][] = [];
  const sqlCalls: string[] = [];
  const DB = {
    prepare(sql: string) {
      sqlCalls.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => options.first?.(sql, values) ?? null,
            all: async () => ({ results: [] }),
          };
        },
      };
    },
    async batch(statements: Array<{ sql?: string }>) {
      batchCalls.push(sqlCalls.slice(-statements.length));
      return (options.batchChanges ?? statements.map(() => 1))
        .map(changes => ({ meta: { changes } }));
    },
  };
  return { env: { DB } as unknown as Env, batchCalls, sqlCalls };
}

describe("customer and subscription administration", () => {
  beforeEach(() => {
    authenticateAdmin.mockReset().mockResolvedValue({
      actor: { id: "admin-1", email: "admin@example.test", displayName: "Admin", roleKey: "owner" },
    });
  });

  it("updates customer contact details and writes an audit record in the same batch", async () => {
    const { env, batchCalls } = fakeEnv({
      first: () => ({
        display_name: "متجر النور",
        phone_e164: "+249900000001",
        notes: "قديم",
      }),
    });
    const request = new Request("https://platform.example/api/v1/admin/customers/11111111-1111-4111-8111-111111111111", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "متجر النور الجديد",
        phone_e164: "+249900000002",
        notes: "تحديث بيانات التواصل",
      }),
    });

    const response = await handleCustomerAdmin(
      request,
      env,
      "/admin/customers/11111111-1111-4111-8111-111111111111",
      new URL(request.url),
    );
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toEqual({
      customer_id: "11111111-1111-4111-8111-111111111111",
      updated: true,
    });
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);
    expect(batchCalls[0][1]).toContain("INSERT INTO audit_logs");
  });

  it("rejects reducing seats below active license usage without changing the subscription", async () => {
    const { env, batchCalls } = fakeEnv({
      first: sql => sql.includes("SELECT max_devices")
        ? { max_devices: 4, status: "active" }
        : { count: 3 },
    });
    const request = new Request("https://platform.example/api/v1/admin/subscriptions/22222222-2222-4222-8222-222222222222", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_devices: 2 }),
    });

    const response = await handleCustomerAdmin(
      request,
      env,
      "/admin/subscriptions/22222222-2222-4222-8222-222222222222",
      new URL(request.url),
    );
    const payload = await response?.json() as Record<string, unknown>;

    expect(response?.status).toBe(409);
    expect(payload.error).toMatchObject({ code: "SEAT_LIMIT_BELOW_USAGE" });
    expect(batchCalls).toEqual([]);
  });

  it("rejects an invalid international phone number without writing customer data", async () => {
    const { env, batchCalls } = fakeEnv({
      first: () => ({
        display_name: "متجر النور",
        phone_e164: "+249900000001",
        notes: null,
      }),
    });
    const request = new Request("https://platform.example/api/v1/admin/customers/11111111-1111-4111-8111-111111111111", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_e164: "0900000001" }),
    });

    const response = await handleCustomerAdmin(
      request,
      env,
      "/admin/customers/11111111-1111-4111-8111-111111111111",
      new URL(request.url),
    );

    expect(response?.status).toBe(422);
    expect(batchCalls).toEqual([]);
  });
});
