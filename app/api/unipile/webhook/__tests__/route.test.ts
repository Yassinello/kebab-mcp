/**
 * Phase 70 / Plan 01 / Task 2 — webhook route tests (TDD RED).
 *
 * Coverage (per plan <behavior>):
 *  - 503 + {error:"webhook_not_configured"} when UNIPILE_WEBHOOK_SECRET unset
 *  - 200 on valid Unipile-Auth static header (the empirical path D-76)
 *  - 401 on invalid Unipile-Auth header
 *  - 200 + deduped:true on second identical event within idempotency window;
 *    dispatcher NOT invoked the second time
 *  - 200 even when Content-Type is application/x-www-form-urlencoded (D-77);
 *    bodyParseStep already JSON-first parses regardless of content-type so
 *    this is regression-coverage for that contract
 *  - dispatcher fires via void+catch AFTER 200 returns (fire-and-forget
 *    semantics; we assert dispatcher was called, with the payload object)
 *
 * Module mocks:
 *  - @/core/config-facade → controllable UNIPILE_WEBHOOK_SECRET
 *  - @/core/kv-store → controllable setIfNotExists for dedup test
 *  - @/connectors/unipile/webhook/dispatcher → spy on dispatchEventAsync
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const configMap = new Map<string, string>();
  const getConfigMock = vi.fn((k: string) => configMap.get(k));
  // KV mock with controllable setIfNotExists
  const kvMock = {
    kind: "filesystem" as const,
    get: vi.fn(async (_k: string) => null),
    set: vi.fn(async (_k: string, _v: string) => {}),
    delete: vi.fn(async (_k: string) => {}),
    list: vi.fn(async (_p?: string) => [] as string[]),
    setIfNotExists: vi.fn(
      async (
        _k: string,
        _v: string,
        _o?: { ttlSeconds?: number }
      ): Promise<{ ok: true } | { ok: false; existing: string }> => ({ ok: true })
    ),
  };
  const dispatchEventAsyncMock = vi.fn(async (_p: unknown) => {});
  const getIdempotencyKeyMock = vi.fn((p: Record<string, unknown>): string | null => {
    if (p.event === "message_received" && typeof p.message_id === "string") return p.message_id;
    return null;
  });
  return {
    configMap,
    getConfigMock,
    kvMock,
    dispatchEventAsyncMock,
    getIdempotencyKeyMock,
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: hoist.getConfigMock,
  getConfigInt: (k: string, d: number) => {
    const v = hoist.configMap.get(k);
    return v ? parseInt(v, 10) : d;
  },
}));

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => hoist.kvMock,
  getTenantKVStore: () => hoist.kvMock,
}));

vi.mock("@/connectors/unipile/webhook/dispatcher", () => ({
  dispatchEventAsync: hoist.dispatchEventAsyncMock,
  getIdempotencyKey: hoist.getIdempotencyKeyMock,
  isIgnoredEvent: (p: Record<string, unknown>) =>
    p.event === "message_received" &&
    (p.is_sender === true || String(p.account_type ?? "").toUpperCase() === "WHATSAPP"),
}));

// Side-effect import target — handlers/index.ts is `export {};` placeholder.
// vi.mock to a clean no-op so the import never resolves the (not-yet-created)
// real handlers in Plan 02.
vi.mock("@/connectors/unipile/webhook/handlers", () => ({}));

import { POST } from "../route";

const SECRET = "test-webhook-secret-do-not-leak";
const VALID_BODY = JSON.stringify({
  event: "message_received",
  message_id: "msg-abc-123",
  account_id: "acct_1",
  is_sender: false,
});

beforeEach(() => {
  hoist.configMap.clear();
  hoist.getConfigMock.mockClear();
  hoist.kvMock.get.mockClear();
  hoist.kvMock.set.mockClear();
  hoist.kvMock.setIfNotExists.mockClear();
  hoist.kvMock.setIfNotExists.mockResolvedValue({ ok: true });
  hoist.dispatchEventAsyncMock.mockClear();
  hoist.dispatchEventAsyncMock.mockResolvedValue();
  hoist.getIdempotencyKeyMock.mockClear();
});

function unipileRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("https://test.local/api/unipile/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/unipile/webhook — secret unconfigured", () => {
  it("returns 503 with {error:'webhook_not_configured'} when UNIPILE_WEBHOOK_SECRET unset", async () => {
    // configMap is empty — secret absent
    const res = await POST(unipileRequest(VALID_BODY, { "unipile-auth": "anything" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("webhook_not_configured");
    // dispatcher MUST NOT fire when route is misconfigured
    expect(hoist.dispatchEventAsyncMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/unipile/webhook — signature verification", () => {
  beforeEach(() => {
    hoist.configMap.set("UNIPILE_WEBHOOK_SECRET", SECRET);
  });

  it("returns 200 on valid Unipile-Auth static header", async () => {
    const res = await POST(unipileRequest(VALID_BODY, { "unipile-auth": SECRET }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 401 + reason on invalid Unipile-Auth header", async () => {
    const res = await POST(unipileRequest(VALID_BODY, { "unipile-auth": "wrong-token" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("invalid_signature");
    expect(body.reason).toBe("static_mismatch");
    expect(hoist.dispatchEventAsyncMock).not.toHaveBeenCalled();
  });

  it("returns 401 when no signature/auth header is present", async () => {
    const res = await POST(unipileRequest(VALID_BODY, {}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("invalid_signature");
    expect(body.reason).toBe("no_signature_or_auth_header");
  });
});

describe("POST /api/unipile/webhook — content-type tolerance (D-77)", () => {
  beforeEach(() => {
    hoist.configMap.set("UNIPILE_WEBHOOK_SECRET", SECRET);
  });

  it("parses JSON body when Content-Type is application/x-www-form-urlencoded", async () => {
    const res = await POST(
      unipileRequest(VALID_BODY, {
        "content-type": "application/x-www-form-urlencoded",
        "unipile-auth": SECRET,
      })
    );
    expect(res.status).toBe(200);
    // Confirm the dispatcher received the parsed OBJECT (not the raw string)
    expect(hoist.dispatchEventAsyncMock).toHaveBeenCalledTimes(1);
    const dispatched = hoist.dispatchEventAsyncMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatched).toEqual(expect.objectContaining({ event: "message_received" }));
  });
});

describe("POST /api/unipile/webhook — idempotency dedup (D-54)", () => {
  beforeEach(() => {
    hoist.configMap.set("UNIPILE_WEBHOOK_SECRET", SECRET);
  });

  it("writes idempotency row via setIfNotExists with 24h TTL on first delivery", async () => {
    await POST(unipileRequest(VALID_BODY, { "unipile-auth": SECRET }));
    expect(hoist.kvMock.setIfNotExists).toHaveBeenCalledTimes(1);
    const [key, , opts] = hoist.kvMock.setIfNotExists.mock.calls[0]!;
    expect(key).toBe("unipile:webhook:event:msg-abc-123");
    expect(opts?.ttlSeconds).toBe(24 * 3600);
  });

  it("returns 200 + deduped:true on duplicate, does NOT call dispatcher", async () => {
    // Second delivery: setIfNotExists reports key already exists
    hoist.kvMock.setIfNotExists.mockResolvedValue({ ok: false, existing: "1" });
    const res = await POST(unipileRequest(VALID_BODY, { "unipile-auth": SECRET }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deduped?: boolean };
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(true);
    expect(hoist.dispatchEventAsyncMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/unipile/webhook — fire-and-forget dispatch", () => {
  beforeEach(() => {
    hoist.configMap.set("UNIPILE_WEBHOOK_SECRET", SECRET);
  });

  it("invokes dispatchEventAsync with the parsed payload after a successful auth", async () => {
    await POST(unipileRequest(VALID_BODY, { "unipile-auth": SECRET }));
    expect(hoist.dispatchEventAsyncMock).toHaveBeenCalledTimes(1);
    const arg = hoist.dispatchEventAsyncMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toEqual({
      event: "message_received",
      message_id: "msg-abc-123",
      account_id: "acct_1",
      is_sender: false,
    });
  });

  it("returns 200 even when dispatcher throws (fire-and-forget swallows the error)", async () => {
    hoist.dispatchEventAsyncMock.mockRejectedValueOnce(new Error("handler boom"));
    const res = await POST(unipileRequest(VALID_BODY, { "unipile-auth": SECRET }));
    // The void+catch happens AFTER the response is built; 200 must still ship.
    expect(res.status).toBe(200);
  });
});
