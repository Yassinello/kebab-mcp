/**
 * Phase 69 / Plan 01 — resolveAccountId D-20 contract tests.
 * Phase 72 — D-72 pinned-default (UNIPILE_<TYPE>_ACCOUNT_ID) tests.
 *
 * Coverage (D-20, 4 locked cases):
 *  1. Explicit account_id pass-through (NO account.getAll call)
 *  2. Single LinkedIn account → silent use
 *  3. Zero LinkedIn accounts → error_no_linkedin_account
 *  4. ≥2 LinkedIn accounts → error_account_id_required + available_accounts list
 *
 * Coverage (D-72, pinned default):
 *  5. ≥2 accounts + valid pinned id → use pinned (no error)
 *  6. ≥2 accounts + pinned id absent from list → fall through to safety net
 *  7. Explicit account_id still wins over a pinned default (no getAll)
 *  8. Single account + pinned id pointing elsewhere → fall through to single
 *  9. resolveAccountIdForType honours UNIPILE_WHATSAPP_ACCOUNT_ID
 *
 * Mocks: getUnipileClient via the canonical vi.hoisted pattern (matches
 * identifiers.test.ts and audit.test.ts). getConfig mocked so env-var reads
 * are deterministic (default: undefined → D-20 behavior unchanged).
 * UnsuccessfulRequestError shim supplied for `withRetry`'s `instanceof` check.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const getAllMock = vi.fn();
  const getConfigMock = vi.fn<(key: string) => string | undefined>(() => undefined);
  class FakeUnsuccessful extends Error {
    body: { status?: number };
    constructor(status?: number) {
      super(`Unipile ${status ?? "?"}`);
      this.name = "UnsuccessfulRequestError";
      this.body = status === undefined ? {} : { status };
    }
  }
  return { getAllMock, getConfigMock, FakeUnsuccessful };
});

vi.mock("../client", () => ({
  getUnipileClient: () => ({ account: { getAll: hoist.getAllMock } }),
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: hoist.getConfigMock,
}));

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: hoist.FakeUnsuccessful,
}));

import { resolveAccountId, resolveAccountIdForType } from "../account";

/** Helper: make getConfig return `value` for one specific env key. */
function pinEnv(key: string, value: string) {
  hoist.getConfigMock.mockImplementation((k: string) => (k === key ? value : undefined));
}

describe("resolveAccountId (D-20)", () => {
  beforeEach(() => {
    hoist.getAllMock.mockReset();
    hoist.getConfigMock.mockReset();
    hoist.getConfigMock.mockReturnValue(undefined);
  });

  it("explicit account_id → silent pass-through, NO account.getAll call", async () => {
    const r = await resolveAccountId({ account_id: "acct_xyz" });
    expect(r).toEqual({ accountId: "acct_xyz" });
    expect(hoist.getAllMock).not.toHaveBeenCalled();
  });

  it("single LinkedIn account → silent use", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [{ id: "acct_only", type: "LINKEDIN" }],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ accountId: "acct_only" });
    expect(hoist.getAllMock).toHaveBeenCalledTimes(1);
  });

  it("zero LinkedIn accounts → error_no_linkedin_account (other types present but ignored)", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "acct_g", type: "GOOGLE" },
        { id: "acct_w", type: "WHATSAPP" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ error: "error_no_linkedin_account" });
  });

  it("≥2 LinkedIn accounts → error_account_id_required + available_accounts list (insertion order preserved)", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "g", type: "GOOGLE" }, // non-LinkedIn filtered out
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["a", "b"],
    });
  });

  it("empty items array → error_no_linkedin_account (defensive default)", async () => {
    hoist.getAllMock.mockResolvedValue({ items: [] });
    expect(await resolveAccountId({})).toEqual({ error: "error_no_linkedin_account" });
  });

  it("missing items field → error_no_linkedin_account (shape-defensive)", async () => {
    hoist.getAllMock.mockResolvedValue({});
    expect(await resolveAccountId({})).toEqual({ error: "error_no_linkedin_account" });
  });
});

describe("resolveAccountId (D-72 pinned default)", () => {
  beforeEach(() => {
    hoist.getAllMock.mockReset();
    hoist.getConfigMock.mockReset();
    hoist.getConfigMock.mockReturnValue(undefined);
  });

  it("≥2 accounts + valid UNIPILE_LINKEDIN_ACCOUNT_ID → uses pinned, no error", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "b");
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
        { id: "c", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ accountId: "b" });
  });

  it("≥2 accounts + pinned id absent from list → falls through to safety net", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "ghost");
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["a", "b"],
    });
  });

  it("explicit account_id still wins over a pinned default (NO getAll)", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "b");
    const r = await resolveAccountId({ account_id: "explicit" });
    expect(r).toEqual({ accountId: "explicit" });
    expect(hoist.getAllMock).not.toHaveBeenCalled();
  });

  it("single account + pinned id pointing elsewhere → falls through to the single account", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "ghost");
    hoist.getAllMock.mockResolvedValue({
      items: [{ id: "only", type: "LINKEDIN" }],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ accountId: "only" });
  });

  it("whitespace-only pinned id is ignored (treated as unset)", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "   ");
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["a", "b"],
    });
  });
});

describe("resolveAccountIdForType (D-72 pinned default — WhatsApp)", () => {
  beforeEach(() => {
    hoist.getAllMock.mockReset();
    hoist.getConfigMock.mockReset();
    hoist.getConfigMock.mockReturnValue(undefined);
  });

  it("≥2 WhatsApp accounts + valid UNIPILE_WHATSAPP_ACCOUNT_ID → uses pinned", async () => {
    pinEnv("UNIPILE_WHATSAPP_ACCOUNT_ID", "wb");
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "wa", type: "WHATSAPP" },
        { id: "wb", type: "WHATSAPP" },
        { id: "li", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountIdForType("WHATSAPP", {});
    expect(r).toEqual({ accountId: "wb" });
  });

  it("≥2 WhatsApp accounts + no pinned default → error_account_id_required", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "wa", type: "WHATSAPP" },
        { id: "wb", type: "WHATSAPP" },
      ],
    });
    const r = await resolveAccountIdForType("WHATSAPP", {});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["wa", "wb"],
    });
  });

  it("LinkedIn pin does NOT leak into WhatsApp resolution", async () => {
    pinEnv("UNIPILE_LINKEDIN_ACCOUNT_ID", "wb");
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "wa", type: "WHATSAPP" },
        { id: "wb", type: "WHATSAPP" },
      ],
    });
    // UNIPILE_WHATSAPP_ACCOUNT_ID is unset → must NOT pick up the LinkedIn pin.
    const r = await resolveAccountIdForType("WHATSAPP", {});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["wa", "wb"],
    });
  });
});
