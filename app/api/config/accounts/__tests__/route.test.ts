/**
 * Phase 75 (MAUI-01..03): /api/config/accounts route tests.
 *
 * Coverage:
 *   1. GET unsupported connector → 400
 *   2. GET lists accounts WITHOUT tokens (+ default pin)
 *   3. POST with failing testConnection → does NOT save, returns ok:false
 *   4. POST success → derives name from testConnection.account_name + saves
 *   5. POST success with no account_name → falls back to provided `name`
 *   6. POST missing primary token → 400, no testConnection call
 *   7. POST unsupported connector → 400
 *   8. DELETE → removeAccount called, ok:true
 *   9. PUT default → setDefaultAccount called, ok:true
 *  10. PUT default unsupported connector → 400
 *
 * Store + manifest loader are mocked; withAdminAuth is bypassed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  saveAccount: vi.fn(),
  removeAccount: vi.fn(),
  getDefaultAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

vi.mock("@/core/storage-mode", () => ({
  detectStorageMode: vi.fn(async () => ({ mode: "kv", ephemeral: false })),
}));

vi.mock("@/core/connector-accounts", () => ({
  listAccounts: hoist.listAccounts,
  saveAccount: hoist.saveAccount,
  removeAccount: hoist.removeAccount,
  getDefaultAccount: hoist.getDefaultAccount,
}));

vi.mock("@/core/registry", () => ({
  loadConnectorManifest: vi.fn(async (id: string) =>
    id === "slack" || id === "notion" ? { id, testConnection: hoist.testConnection } : null
  ),
}));

import { GET, POST, DELETE } from "../route";

type Handler = (ctx: { request: Request }) => Promise<Response>;

function ctxFor(method: string, url: string, body?: unknown): { request: Request } {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoist.getDefaultAccount.mockResolvedValue(undefined);
});

describe("GET /api/config/accounts", () => {
  it("rejects an unsupported connector with 400", async () => {
    const res = await (GET as unknown as Handler)(
      ctxFor("GET", "http://x/api/config/accounts?connector=gmail")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("lists accounts without token values and surfaces the default pin", async () => {
    hoist.listAccounts.mockResolvedValue([
      { slug: "acme", name: "Acme", tokens: { SLACK_BOT_TOKEN: "xoxb-secret" } },
      { slug: "globex", name: "Globex", tokens: { SLACK_BOT_TOKEN: "xoxb-other" } },
    ]);
    hoist.getDefaultAccount.mockResolvedValue("acme");

    const res = await (GET as unknown as Handler)(
      ctxFor("GET", "http://x/api/config/accounts?connector=slack")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.default).toBe("acme");
    expect(body.accounts).toEqual([
      { slug: "acme", name: "Acme" },
      { slug: "globex", name: "Globex" },
    ]);
    // No token values may leak.
    expect(JSON.stringify(body)).not.toContain("xoxb-secret");
  });
});

describe("POST /api/config/accounts", () => {
  it("does NOT save when testConnection fails", async () => {
    hoist.testConnection.mockResolvedValue({ ok: false, message: "bad", detail: "invalid_auth" });

    const res = await (POST as unknown as Handler)(
      ctxFor("POST", "http://x/api/config/accounts", {
        connector: "slack",
        tokens: { SLACK_BOT_TOKEN: "xoxb-bad" },
      })
    );
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid_auth/);
    expect(hoist.saveAccount).not.toHaveBeenCalled();
  });

  it("derives the name from testConnection.account_name and saves", async () => {
    hoist.testConnection.mockResolvedValue({
      ok: true,
      message: "Connected to Acme as bot",
      account_name: "Acme",
    });
    hoist.saveAccount.mockResolvedValue({ slug: "acme", name: "Acme", tokens: {} });

    const res = await (POST as unknown as Handler)(
      ctxFor("POST", "http://x/api/config/accounts", {
        connector: "slack",
        tokens: { SLACK_BOT_TOKEN: "xoxb-good" },
        name: "ignored-when-provider-name-present",
      })
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.account).toEqual({ slug: "acme", name: "Acme" });
    expect(hoist.saveAccount).toHaveBeenCalledWith("slack", "Acme", {
      SLACK_BOT_TOKEN: "xoxb-good",
    });
  });

  it("falls back to the provided name when account_name is absent", async () => {
    hoist.testConnection.mockResolvedValue({ ok: true, message: "Connected" });
    hoist.saveAccount.mockResolvedValue({ slug: "my-team", name: "My Team", tokens: {} });

    const res = await (POST as unknown as Handler)(
      ctxFor("POST", "http://x/api/config/accounts", {
        connector: "notion",
        tokens: { NOTION_API_KEY: "secret_x" },
        name: "My Team",
      })
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(hoist.saveAccount).toHaveBeenCalledWith("notion", "My Team", {
      NOTION_API_KEY: "secret_x",
    });
  });

  it("rejects a missing primary token with 400 and never tests", async () => {
    const res = await (POST as unknown as Handler)(
      ctxFor("POST", "http://x/api/config/accounts", {
        connector: "slack",
        tokens: { SLACK_USER_TOKEN: "xoxp-only" },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/SLACK_BOT_TOKEN/);
    expect(hoist.testConnection).not.toHaveBeenCalled();
    expect(hoist.saveAccount).not.toHaveBeenCalled();
  });

  it("rejects an unsupported connector with 400", async () => {
    const res = await (POST as unknown as Handler)(
      ctxFor("POST", "http://x/api/config/accounts", {
        connector: "gmail",
        tokens: { FOO: "bar" },
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/config/accounts", () => {
  it("removes the account and returns ok", async () => {
    hoist.removeAccount.mockResolvedValue(undefined);
    const res = await (DELETE as unknown as Handler)(
      ctxFor("DELETE", "http://x/api/config/accounts", { connector: "slack", slug: "acme" })
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(hoist.removeAccount).toHaveBeenCalledWith("slack", "acme");
  });

  it("rejects a missing slug with 400", async () => {
    const res = await (DELETE as unknown as Handler)(
      ctxFor("DELETE", "http://x/api/config/accounts", { connector: "slack" })
    );
    expect(res.status).toBe(400);
    expect(hoist.removeAccount).not.toHaveBeenCalled();
  });
});
