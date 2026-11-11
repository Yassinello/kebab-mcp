/**
 * Phase 69 / Plan 04 / Task 2 — linkedin_send_inmail coverage.
 *
 * Covers the locked envelope (D-13/D-14), 13-step handler order (D-49 +
 * WARNING-6), allow_inmail-literal gate (D-26), credit bracketing via
 * `request.send` escape hatch (D-48), premium-tier gate (D-29), cap-gate
 * (D-27), post-send balance fallback (D-28), and the D-50 startNewChat
 * `options.linkedin.inmail = true` SDK call shape.
 *
 * NEW vs send-message mock surface: `requestSendMock` — the escape hatch
 * for `/linkedin/inmail_balance`. Tests stack two `.mockResolvedValueOnce`
 * calls for the bracket (before + after); pre-flight-refusal tests assert
 * the second call was NEVER made.
 *
 * Mocks (all hoisted via vi.hoisted — vitest 4.x mock-factory hoisting):
 *  - SDK methods: messaging.startNewChat + users.getProfile + account.getAll
 *    + request.send (NEW — escape hatch for inmail_balance)
 *  - request-context KV store (kvMock — dedup + URN cache read-through)
 *  - rate-limiter (rateLimitMock — assert `not.toHaveBeenCalled` for
 *    pre-flight refusals per WARNING-6)
 *  - unipile-node-sdk UnsuccessfulRequestError (FakeUnsuccessful — same
 *    class identity the retry helper checks via `instanceof`)
 *
 * WARNING-6 assertions: tests for pre-flight refusal paths (allow_inmail,
 * dedup, premium-gate, cap-gate) explicitly assert
 * `rateLimitMock.not.toHaveBeenCalled()` — runtime guards proving the
 * 13-step handler order in PLAN.md is respected (RESEARCH §4.7).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ───── hoisted mock surface (closes over vi.hoisted spies) ─────
const {
  sendChatMock,
  requestSendMock,
  getProfileMock,
  accountGetAllMock,
  kvMock,
  rateLimitMock,
  haltFlagMock,
  killSwitchMock,
  FakeUnsuccessful,
} = vi.hoisted(() => {
  const sendChatMock = vi.fn();
  const requestSendMock = vi.fn(); // NEW — escape hatch for inmail_balance
  const getProfileMock = vi.fn();
  const accountGetAllMock = vi.fn();
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
    incr: vi.fn<(k: string, opts?: { ttlSeconds?: number }) => Promise<number>>(),
  };
  const rateLimitMock = vi.fn();
  // Phase 70 plan 70-03 retrofit (D-65/D-66) — readHaltFlag mock.
  const haltFlagMock = vi.fn();
  // Phase 71 plan 71-01 retrofit (D-86/D-88/D-89) — isWritesDisabled kill-switch mock.
  const killSwitchMock = vi.fn();

  class FakeUnsuccessful extends Error {
    body: { status?: number; type?: string };
    constructor(body: { status?: number; type?: string }) {
      super(`unipile ${JSON.stringify(body)}`);
      this.body = body;
      this.name = "UnsuccessfulRequestError";
    }
  }

  return {
    sendChatMock,
    requestSendMock,
    getProfileMock,
    accountGetAllMock,
    kvMock,
    rateLimitMock,
    haltFlagMock,
    killSwitchMock,
    FakeUnsuccessful,
  };
});

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    messaging: {
      startNewChat: sendChatMock,
      getAllMessagesFromChat: vi.fn(),
      sendMessage: vi.fn(),
    },
    users: {
      getProfile: getProfileMock,
      getAllInvitationsSent: vi.fn(),
      sendInvitation: vi.fn(),
    },
    account: { getAll: accountGetAllMock },
    request: { send: requestSendMock }, // KEY ADD vs send-message mocks
  }),
  __resetUnipileClientForTests: () => {},
  sanitizeUnipileText: (s: string) => s,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("../../lib/rate-limiter", () => ({
  checkUnipileRateLimit: rateLimitMock,
}));

// Phase 70 plan 70-03 retrofit (D-65/D-66) — halt-flag mock wires readHaltFlag.
vi.mock("../../webhook/halt-flag", () => ({
  readHaltFlag: haltFlagMock,
}));

// Phase 71 plan 71-01 retrofit (D-86/D-88/D-89) — kill-switch mock wires
// isWritesDisabled so tests can drive the Step -1 global refusal.
vi.mock("../../lib/kill-switch", () => ({
  isWritesDisabled: killSwitchMock,
}));

vi.mock("unipile-node-sdk", () => ({
  // The retry helper does `err instanceof UnsuccessfulRequestError`; our fake
  // class must be the SAME reference the helper sees — vi.mock hoists this
  // factory above the retry import, so they share class identity.
  UnsuccessfulRequestError: FakeUnsuccessful,
}));

import { handleLinkedinSendInmail } from "../linkedin-send-inmail";

interface ParsedEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: string;
  dedup_hit: boolean;
  audit_id: string;
  credits_used: number | null;
  credits_remaining: number | null;
  message_id?: string;
  chat_id?: string;
  error?: string;
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  retry_after?: string;
  available_accounts?: string[];
  // Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope fields
  reason?: string;
  halted_at?: string;
}

function parseEnvelope(result: { content: Array<{ text: string }> }): ParsedEnvelope {
  return JSON.parse(result.content[0]!.text) as ParsedEnvelope;
}

const BASE_ARGS = {
  profile_url: "https://linkedin.com/in/some-prospect",
  text: "InMail body",
  subject: "Quick question",
  allow_inmail: true as const,
  actor_user_id: "yass",
};

function resetMocks() {
  sendChatMock.mockReset();
  requestSendMock.mockReset();
  getProfileMock.mockReset();
  accountGetAllMock.mockReset();
  kvMock.get.mockReset();
  kvMock.set.mockReset();
  kvMock.delete.mockReset();
  kvMock.incr.mockReset();
  rateLimitMock.mockReset();
  // Phase 70 plan 70-03 retrofit (D-65/D-66) — reset readHaltFlag spy.
  haltFlagMock.mockReset();
  // Phase 71 plan 71-01 retrofit (D-86/D-88/D-89) — reset kill-switch spy.
  killSwitchMock.mockReset();

  // Sane defaults — each test overrides as needed.
  kvMock.get.mockResolvedValue(null); // no dedup hit; no URN cache hit
  kvMock.set.mockResolvedValue(undefined);
  kvMock.incr.mockResolvedValue(1);
  accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_li_1", type: "LINKEDIN" }] });
  getProfileMock.mockResolvedValue({
    provider_id: "urn:li:prospect",
    network_distance: "OUT_OF_NETWORK",
  });
  rateLimitMock.mockResolvedValue({ blocked: false, daily_used: 1, daily_limit: 15 });
  // Phase 70 retrofit default: account NOT halted.
  haltFlagMock.mockResolvedValue(null);
  // Phase 71 retrofit default: writes NOT disabled. Only the explicit
  // kill-switch test overrides to true.
  killSwitchMock.mockReturnValue(false);
}

// ───────────────────────────────────────────────────────────────────────
describe("happy path: credit bracketing (D-48 — balance before + after)", () => {
  beforeEach(resetMocks);

  it("Test 1 — happy path: credits_used=1, credits_remaining=149, provider_ok=true", async () => {
    requestSendMock
      .mockResolvedValueOnce({
        object: "LinkedinInmailBalance",
        premium: null,
        recruiter: null,
        sales_navigator: 150,
      }) // before
      .mockResolvedValueOnce({
        object: "LinkedinInmailBalance",
        premium: null,
        recruiter: null,
        sales_navigator: 149,
      }); // after
    sendChatMock.mockResolvedValueOnce({ chat_id: "chat_1", message_id: "msg_1" });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(true);
    expect(typeof env.verified).toBe("boolean"); // D-13/D-14 STRICT — never 'pending'
    expect(env.verified as unknown).not.toBe("pending");
    expect(env.crm_sync).toBe("pending");
    expect(env.dedup_hit).toBe(false);
    expect(env.credits_used).toBe(1);
    expect(env.credits_remaining).toBe(149);
    expect(env.message_id).toBe("msg_1");
    expect(env.chat_id).toBe("chat_1");
    expect(env.error).toBeUndefined();
    // D-48 critical assertion: balance bracketed = called EXACTLY twice.
    expect(requestSendMock).toHaveBeenCalledTimes(2);
  });

  it("Test 1b — request.send call shape (path + method + parameters) matches D-48 escape hatch contract", async () => {
    requestSendMock
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 100 })
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 99 });
    sendChatMock.mockResolvedValueOnce({ chat_id: "c", message_id: "m" });

    await handleLinkedinSendInmail(BASE_ARGS);

    expect(requestSendMock).toHaveBeenCalledWith({
      path: ["linkedin", "inmail_balance"],
      method: "GET",
      parameters: { account_id: "acct_li_1" },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-29 premium gate (all-null tiers OR zero credits)", () => {
  beforeEach(resetMocks);

  it("Test 2 — all-null balance returns error_inmail_requires_premium BEFORE rate-limit (pre-flight per RESEARCH §4.7)", async () => {
    requestSendMock.mockResolvedValueOnce({
      object: "LinkedinInmailBalance",
      premium: null,
      recruiter: null,
      sales_navigator: null,
    });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_inmail_requires_premium");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(env.credits_remaining).toBe(0);
    expect(env.credits_used).toBeNull();
    // WARNING-6 + D-49 runtime guards: pre-flight refusal MUST NOT burn rate-limit quota.
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(sendChatMock).not.toHaveBeenCalled();
    // Single balance call (NO post-send call — we never sent).
    expect(requestSendMock).toHaveBeenCalledTimes(1);
  });

  it("Test 3 — zero credits with non-null tier returns error_inmail_requires_premium", async () => {
    // Account HAS a premium tier active but credits are exhausted (0).
    // Distinct envelope semantics from all-null: credits_used=0, credits_remaining=0.
    requestSendMock.mockResolvedValueOnce({
      object: "LinkedinInmailBalance",
      premium: 0,
      recruiter: null,
      sales_navigator: 0,
    });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_inmail_requires_premium");
    expect(env.credits_used).toBe(0);
    expect(env.credits_remaining).toBe(0);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(sendChatMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-27 max_inmail_credits cap (pre-flight refusal — no rate-limit burn)", () => {
  beforeEach(resetMocks);

  it("Test 4 — cap_exceeded BEFORE rate-limit (pre-flight refusal does NOT count per RESEARCH §4.7)", async () => {
    requestSendMock.mockResolvedValueOnce({
      object: "LinkedinInmailBalance",
      premium: null,
      recruiter: null,
      sales_navigator: 5,
    });

    const env = parseEnvelope(
      await handleLinkedinSendInmail({ ...BASE_ARGS, max_inmail_credits: 10 })
    );

    expect(env.error).toBe("error_inmail_cap_exceeded");
    expect(env.credits_used).toBe(0);
    expect(env.credits_remaining).toBe(5);
    expect(sendChatMock).not.toHaveBeenCalled();
    // WARNING-6 critical guard: cap-exceeded is a pre-flight refusal — rate-limiter MUST NOT be touched.
    expect(rateLimitMock).not.toHaveBeenCalled();
    // Single balance call (no post-send — we never sent).
    expect(requestSendMock).toHaveBeenCalledTimes(1);
  });

  it("Test 4b — cap satisfied: with cap=5 and totalAvailable=150, send proceeds normally", async () => {
    requestSendMock
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 150 })
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 149 });
    sendChatMock.mockResolvedValueOnce({ chat_id: "c", message_id: "m" });

    const env = parseEnvelope(
      await handleLinkedinSendInmail({ ...BASE_ARGS, max_inmail_credits: 5 })
    );

    expect(env.provider_ok).toBe(true);
    expect(env.credits_used).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-28 post-send balance failure (credits collapse to null — send is still ok)", () => {
  beforeEach(resetMocks);

  it("Test 5 — post-send balance fetch failure → credits_used: null, credits_remaining: null (send still ok)", async () => {
    requestSendMock
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 150 }) // before OK
      .mockRejectedValueOnce(new FakeUnsuccessful({ status: 503 })); // after fails
    sendChatMock.mockResolvedValueOnce({ chat_id: "chat_1", message_id: "msg_1" });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    // Send was successful — credit was consumed regardless of measurability.
    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(true);
    expect(env.error).toBeUndefined();
    // D-28 fallback: credits collapse to null because we can't measure them.
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    expect(env.message_id).toBe("msg_1");
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-26 allow_inmail-literal gate (defense-in-depth at handler level)", () => {
  beforeEach(resetMocks);

  it("Test 6 — handler-level check returns error_inmail_not_authorized if allow_inmail is not true", async () => {
    // Bypass Zod by feeding a raw `false` through the handler directly.
    // The defense-in-depth check at Step 1 must catch this BEFORE any balance call.
    const env = parseEnvelope(
      await handleLinkedinSendInmail({ ...BASE_ARGS, allow_inmail: false as unknown as true })
    );

    expect(env.error).toBe("error_inmail_not_authorized");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    // No balance fetch, no send, no rate-limit, no account-resolve — Step 1 = fastest exit.
    expect(requestSendMock).not.toHaveBeenCalled();
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(accountGetAllMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-43 rate-limit block (AFTER premium gate per Step 7)", () => {
  beforeEach(resetMocks);

  it("Test 7 — rate-limit block AFTER premium gate (balanceBefore called, sendChat not)", async () => {
    requestSendMock.mockResolvedValueOnce({
      premium: null,
      recruiter: null,
      sales_navigator: 150,
    });
    rateLimitMock.mockResolvedValueOnce({
      blocked: true,
      daily_used: 15,
      daily_limit: 15,
      reason: "daily_cap",
      retry_after: "2026-05-19T00:00:00.000Z",
    });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_rate_limit_kebab");
    expect(env.blocked_by_rate_limit).toBe(true);
    expect(env.daily_used).toBe(15);
    expect(env.daily_limit).toBe(15);
    expect(env.retry_after).toBe("2026-05-19T00:00:00.000Z");
    // We measured balance before the block, so credits_remaining reflects what we saw.
    expect(env.credits_remaining).toBe(150);
    expect(env.credits_used).toBe(0);
    expect(sendChatMock).not.toHaveBeenCalled();
    // Single balance call (no post-send — we never sent).
    expect(requestSendMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-49 dedup hit (FIRST step — no balance fetch, no SDK send, no rate-limit)", () => {
  beforeEach(resetMocks);

  it("Test 8 — dedup hit returns early WITHOUT balance fetch or SDK send or rate-limit", async () => {
    kvMock.get.mockImplementation((key: string) => {
      if (key.startsWith("unipile:audit:hash:")) {
        return Promise.resolve(
          JSON.stringify({
            audit_id: "prior-uuid",
            actor_user_id: "yass",
            tool: "linkedin_send_inmail",
            account_id: "acct_li_1",
            params_hash: "hashval",
            result: "success",
            verified: true,
            dedup_hit: false,
            timestamp: "2026-05-01T00:00:00Z",
          })
        );
      }
      return Promise.resolve(null);
    });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.dedup_hit).toBe(true);
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(true); // mirrors prior cached result
    expect(env.crm_sync).toBe("pending");
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    // WARNING-6 + D-49 runtime guards: dedup means none of these were touched.
    // Phase 70 Plan 70-03 (D-66) reorder note: accountGetAllMock IS now called
    // (account-resolve moved BEFORE dedup so halt-check has an accountId).
    // The meaningful "no provider cost" guarantees remain: NO balance-fetch
    // (requestSendMock — the costly escape-hatch GET), NO SDK send, NO rate-limit.
    expect(requestSendMock).not.toHaveBeenCalled();
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("SDK error classification (Plan 01 classifier integration)", () => {
  beforeEach(resetMocks);

  it("Test 9 — SDK 403 with type=inmail_requires_premium classifies to error_inmail_requires_premium", async () => {
    requestSendMock.mockResolvedValueOnce({
      premium: null,
      recruiter: null,
      sales_navigator: 150,
    });
    sendChatMock.mockRejectedValueOnce(
      new FakeUnsuccessful({ status: 403, type: "inmail_requires_premium" })
    );

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_inmail_requires_premium");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    // Send failed — credits_used=0 (we didn't spend; LinkedIn rejected at the door).
    expect(env.credits_used).toBe(0);
    expect(env.credits_remaining).toBe(150);
  });

  it("Test 9b — balanceBefore network 503 → error_unipile_5xx, NO SDK send call", async () => {
    // withRetry retries 3 times on 5xx — reject EVERY call so all retries exhaust.
    requestSendMock.mockRejectedValue(new FakeUnsuccessful({ status: 503 }));

    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendInmail(BASE_ARGS);
      // withRetry sleeps ~200/400/800ms on 5xx — advance well past.
      await vi.advanceTimersByTimeAsync(5_000);
      const env = parseEnvelope(await p);

      expect(env.error).toBe("error_unipile_5xx");
      expect(env.provider_ok).toBe(false);
      expect(env.verified).toBe(false);
      expect(env.credits_used).toBeNull();
      expect(env.credits_remaining).toBeNull();
      expect(sendChatMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("D-50 SDK call shape (startNewChat with options.linkedin.inmail=true)", () => {
  beforeEach(resetMocks);

  it("Test 10 — SDK called with options.linkedin.inmail=true (NOT a separate users.sendInmail method)", async () => {
    requestSendMock
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 150 })
      .mockResolvedValueOnce({ premium: null, recruiter: null, sales_navigator: 149 });
    sendChatMock.mockResolvedValueOnce({ chat_id: "c1", message_id: "m1" });

    await handleLinkedinSendInmail(BASE_ARGS);

    expect(sendChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct_li_1",
        attendees_ids: ["urn:li:prospect"],
        subject: "Quick question",
        text: "InMail body",
        options: { linkedin: { api: "classic", inmail: true } },
      })
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("account_id resolution (D-20)", () => {
  beforeEach(resetMocks);

  it("Test 11 — ≥2 LinkedIn accounts → error_account_id_required with available_accounts list", async () => {
    accountGetAllMock.mockResolvedValue({
      items: [
        { id: "acct1", type: "LINKEDIN" },
        { id: "acct2", type: "LINKEDIN" },
      ],
    });

    const env = parseEnvelope(await handleLinkedinSendInmail({ ...BASE_ARGS }));

    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["acct1", "acct2"]);
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(requestSendMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 70 / Plan 70-03 retrofit — halt-check Step 0 (D-65 / D-66)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 70 Plan 70-03 — halt-check Step 0 (D-65 / D-66)", () => {
  beforeEach(resetMocks);

  it("refuses immediately when account is halted, NO dedup / SDK / rate-limit / balance-fetch calls; credits_used=null + credits_remaining=null; single audit row with result=error_account_halted", async () => {
    haltFlagMock.mockResolvedValueOnce({
      reason: "credentials_expired",
      halted_at: "2026-05-18T12:00:00.000Z",
      status: "credentials_expired",
    });

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_account_halted");
    expect(env.verified).toBe(false);
    expect(env.provider_ok).toBe(false);
    expect(env.dedup_hit).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.reason).toBe("credentials_expired");
    expect(env.halted_at).toBe("2026-05-18T12:00:00.000Z");
    // CRITICAL inmail envelope contract: credits MUST be null (we never fetched).
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    expect(env.audit_id).toBeTruthy();

    // Halt-check is the ONLY gate that fired — nothing downstream ran.
    expect(sendChatMock).not.toHaveBeenCalled();
    // The escape-hatch balance fetch MUST NOT fire — this is the cost saver.
    expect(requestSendMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    // Dedup uses kvMock.get — assert it was never asked.
    expect(kvMock.get).not.toHaveBeenCalled();

    // Exactly ONE audit row written, with result error_account_halted.
    const auditSetCalls = kvMock.set.mock.calls.filter(
      ([k]) => typeof k === "string" && k.startsWith("unipile:audit:")
    );
    expect(auditSetCalls.length).toBeGreaterThan(0);
    const distinctResults = new Set(
      auditSetCalls
        .map(([, v]) => {
          if (typeof v !== "string") return undefined;
          try {
            return (JSON.parse(v) as { result?: string }).result;
          } catch {
            return undefined;
          }
        })
        .filter(Boolean)
    );
    expect(distinctResults).toEqual(new Set(["error_account_halted"]));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 71 / Plan 71-01 retrofit — kill-switch Step -1 (D-86 / D-88 / D-89)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 71 Plan 71-01 — kill-switch Step -1 (D-86 / D-88 / D-89)", () => {
  beforeEach(resetMocks);

  it("Step -1: refuses with error_writes_disabled when kill switch is set, NO allow_inmail/account-resolve/halt/dedup/balance/SDK calls; single audit row; credits null", async () => {
    killSwitchMock.mockReturnValue(true);

    const env = parseEnvelope(await handleLinkedinSendInmail(BASE_ARGS));

    expect(env.error).toBe("error_writes_disabled");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(env.dedup_hit).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.credits_used).toBeNull();
    expect(env.credits_remaining).toBeNull();
    expect(env.audit_id).toBeTruthy();

    // Step -1 fires BEFORE everything else.
    expect(accountGetAllMock).not.toHaveBeenCalled();
    expect(haltFlagMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(requestSendMock).not.toHaveBeenCalled(); // no balance fetch (escape hatch)
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(getProfileMock).not.toHaveBeenCalled();
    expect(kvMock.get).not.toHaveBeenCalled();

    // Exactly ONE audit row (writeAuditRow does 2 kv.set calls: row + hash pointer).
    const auditSetCalls = kvMock.set.mock.calls.filter(
      ([k]) => typeof k === "string" && k.startsWith("unipile:audit:")
    );
    expect(auditSetCalls.length).toBeGreaterThan(0);
    const distinctResults = new Set(
      auditSetCalls
        .map(([, v]) => {
          if (typeof v !== "string") return undefined;
          try {
            return (JSON.parse(v) as { result?: string }).result;
          } catch {
            return undefined;
          }
        })
        .filter(Boolean)
    );
    expect(distinctResults).toEqual(new Set(["error_writes_disabled"]));

    // Step -1 fires BEFORE account-resolve — account_id field on the audit
    // row is the empty string per D-20 precedent.
    const firstCall = auditSetCalls[0]!;
    const row = JSON.parse(firstCall[1] as string) as { account_id?: string };
    expect(row.account_id).toBe("");
  });
});
