/**
 * Phase 75 (MAUI-02): PUT /api/config/accounts/default route tests.
 *
 * Coverage:
 *   1. PUT pins the default → setDefaultAccount called, ok:true
 *   2. PUT unsupported connector → 400
 *   3. PUT missing slug → 400, no store write
 *
 * Store is mocked; withAdminAuth bypassed; storage mode = healthy kv.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => ({ setDefaultAccount: vi.fn() }));

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

vi.mock("@/core/storage-mode", () => ({
  detectStorageMode: vi.fn(async () => ({ mode: "kv", ephemeral: false })),
}));

vi.mock("@/core/connector-accounts", () => ({
  setDefaultAccount: hoist.setDefaultAccount,
}));

import { PUT } from "../route";

type Handler = (ctx: { request: Request }) => Promise<Response>;

function ctxFor(body: unknown): { request: Request } {
  return {
    request: new Request("http://x/api/config/accounts/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/config/accounts/default", () => {
  it("pins the default account and returns ok", async () => {
    hoist.setDefaultAccount.mockResolvedValue(undefined);
    const res = await (PUT as unknown as Handler)(ctxFor({ connector: "notion", slug: "acme" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(hoist.setDefaultAccount).toHaveBeenCalledWith("notion", "acme");
  });

  it("rejects an unsupported connector with 400", async () => {
    const res = await (PUT as unknown as Handler)(ctxFor({ connector: "gmail", slug: "acme" }));
    expect(res.status).toBe(400);
    expect(hoist.setDefaultAccount).not.toHaveBeenCalled();
  });

  it("rejects a missing slug with 400", async () => {
    const res = await (PUT as unknown as Handler)(ctxFor({ connector: "slack" }));
    expect(res.status).toBe(400);
    expect(hoist.setDefaultAccount).not.toHaveBeenCalled();
  });
});
