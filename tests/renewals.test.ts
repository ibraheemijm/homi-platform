import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const authenticateAdmin = vi.hoisted(() => vi.fn());
vi.mock("../src/security/access", () => ({ authenticateAdmin }));

import { handleSubscriptionRenewal } from "../src/admin/renewals";

type FakeDb = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      first: () => Promise<unknown>;
      all: () => Promise<{ results: unknown[] }>;
    };
  };
  batch: (statements: unknown[]) => Promise<Array<{ meta: { changes: number } }>>;
};

function makeEnv(options: {
  first?: (sql: string, values: unknown[]) => unknown;
  all?: (sql: string, values: unknown[]) => unknown[];
  batchChanges?: number[];
} = {}): { env: Env; batchCalls: number[]; sqlCalls: string[] } {
  const batchCalls: number[] = [];
  const sqlCalls: string[] = [];
  const db: FakeDb = {
    prepare(sql) {
      sqlCalls.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => options.first?.(sql, values) ?? null,
            all: async () => ({ results: options.all?.(sql, values) ?? [] }),
          };
        },
      };
    },
    async batch(statements) {
      batchCalls.push(statements.length);
      return (options.batchChanges ?? statements.map(() => 1))
        .map(changes => ({ meta: { changes } }));
    },
  };
  return { env: { DB: db } as unknown as Env, batchCalls, sqlCalls };
}

function renewalRequest(body: Record<string, unknown>, key = "7b7c2e44-1c3a-4d66-a8f7-2c2c6b4f55c1") {
  return new Request("https://platform.example/api/v1/admin/subscriptions/11111111-1111-4111-8111-111111111111/renew", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

const validPayment = {
  payment_method: "cash",
  amount_minor: 250000,
  currency: "SDG",
  received_at: "2026-01-01T10:00:00.000Z",
  reference_note: "دفعة تجديد",
};

describe("manual subscription renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    authenticateAdmin.mockReset().mockResolvedValue({
      actor: { id: "admin-1", email: "admin@example.test", displayName: "Admin", roleKey: "owner" },
    });
  });

  it("requires a UUID idempotency key before reading or changing subscription data", async () => {
    const { env, batchCalls, sqlCalls } = makeEnv();
    const response = await handleSubscriptionRenewal(
      renewalRequest(validPayment, "invalid-key"),
      env,
      "/admin/subscriptions/11111111-1111-4111-8111-111111111111/renew",
    );

    expect(response?.status).toBe(422);
    expect(batchCalls).toEqual([]);
    expect(sqlCalls).toEqual([]);
  });

  it("rejects lifetime and suspended subscriptions without recording a payment", async () => {
    const { env, batchCalls } = makeEnv({
      first: sql => sql.includes("idempotency_keys")
        ? null
        : { id: "sub-1", customer_id: "customer-1", product_id: "product-1",
            plan_key: "lifetime", status: "suspended", starts_at: null,
            ends_at: null, max_devices: 1 },
    });
    const response = await handleSubscriptionRenewal(
      renewalRequest(validPayment),
      env,
      "/admin/subscriptions/11111111-1111-4111-8111-111111111111/renew",
    );

    expect(response?.status).toBe(409);
    expect(batchCalls).toEqual([]);
  });

  it("extends an active monthly subscription from its future expiry by exactly 30 days", async () => {
    const { env, batchCalls } = makeEnv({
      first: sql => sql.includes("idempotency_keys")
        ? null
        : { id: "sub-1", customer_id: "customer-1", product_id: "product-1",
            plan_key: "monthly", status: "active", starts_at: "2025-12-01T00:00:00.000Z",
            ends_at: "2026-01-15T00:00:00.000Z", max_devices: 2 },
      all: () => [],
    });
    const response = await handleSubscriptionRenewal(
      renewalRequest(validPayment),
      env,
      "/admin/subscriptions/11111111-1111-4111-8111-111111111111/renew",
    );
    const payload = await response?.json() as Record<string, unknown>;

    expect(authenticateAdmin).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      ["payments.confirm", "subscriptions.renew", "licenses.renew"],
    );
    expect(response?.status).toBe(201);
    expect(payload.ends_at).toBe("2026-02-14T00:00:00.000Z");
    expect(payload.payment_status).toBe("confirmed");
    expect(payload.renewed_license_count).toBe(0);
    expect(batchCalls).toEqual([4]);
  });

  it("returns the saved response for an idempotent replay without a second batch", async () => {
    const saved = { subscription_id: "sub-1", status: "active", ends_at: "2026-02-14T00:00:00.000Z" };
    const { env, batchCalls } = makeEnv({
      first: () => ({ operation_key: "subscription.renew:11111111-1111-4111-8111-111111111111",
        response_json: JSON.stringify(saved) }),
    });
    const response = await handleSubscriptionRenewal(
      renewalRequest(validPayment),
      env,
      "/admin/subscriptions/11111111-1111-4111-8111-111111111111/renew",
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(saved);
    expect(batchCalls).toEqual([]);
  });
});
