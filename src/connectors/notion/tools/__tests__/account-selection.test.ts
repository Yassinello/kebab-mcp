/**
 * Phase 74 (MATL-02/03/04) — Notion tool account selection.
 *
 * Proves the optional `account` param threads the SELECTED account's token
 * set down to the notion-api fetch layer:
 *   - notion_create(account:"work") vs (account:"perso") send with DIFFERENT
 *     NOTION_API_KEY Authorization headers.
 *   - omitting `account` with 2 accounts + no pinned default returns the
 *     error_account_required envelope listing the account names (NOT a throw).
 *   - error_no_account returns the "not configured" envelope.
 *
 * Mock strategy: stub `@/core/connector-accounts.resolveConnectorAccount`
 * (the resolver the handlers call). The notion-api layer is exercised for
 * real against a mocked global `fetch`, so the Authorization header on the
 * outbound request is the assertion target.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AccountResolution } from "@/core/connector-accounts";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("@/core/connector-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/connector-accounts")>();
  return { ...actual, resolveConnectorAccount: resolveMock };
});

import { handleNotionSearch } from "../notion-search";
import { handleNotionCreate } from "../notion-create";

const WORK: AccountResolution = {
  account: { slug: "work", name: "Work", tokens: { NOTION_API_KEY: "ntn-work" } },
};
const PERSO: AccountResolution = {
  account: { slug: "perso", name: "Perso", tokens: { NOTION_API_KEY: "ntn-perso" } },
};

const fetchSpy = vi.fn();

function jsonRes(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Pull the Authorization header off a fetch() call's RequestInit. */
function authHeaderOf(call: unknown[]): string | undefined {
  const init = call[1] as { headers: Record<string, string> };
  return init.headers.Authorization;
}

describe("Phase 74 — Notion account selection", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    resolveMock.mockReset();
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("notion_search(account:'work') vs (account:'perso') use different API keys", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ results: [] }));
    resolveMock.mockResolvedValueOnce(WORK);
    await handleNotionSearch({ query: "kebab", account: "work" });
    expect(authHeaderOf(fetchSpy.mock.calls[0]!)).toBe("Bearer ntn-work");

    fetchSpy.mockResolvedValueOnce(jsonRes({ results: [] }));
    resolveMock.mockResolvedValueOnce(PERSO);
    await handleNotionSearch({ query: "kebab", account: "perso" });
    expect(authHeaderOf(fetchSpy.mock.calls[1]!)).toBe("Bearer ntn-perso");

    expect(resolveMock).toHaveBeenNthCalledWith(1, "notion", { account: "work" });
    expect(resolveMock).toHaveBeenNthCalledWith(2, "notion", { account: "perso" });
  });

  it("notion_create threads the selected account's key into the create call", async () => {
    resolveMock.mockResolvedValueOnce(WORK);
    fetchSpy.mockResolvedValueOnce(jsonRes({ id: "p1", url: "https://notion.so/p1" }));

    await handleNotionCreate({ database_id: "db1", title: "Note", account: "work" });
    expect(authHeaderOf(fetchSpy.mock.calls[0]!)).toBe("Bearer ntn-work");
  });

  it("omitting account with 2 accounts + no default → error_account_required envelope listing names", async () => {
    resolveMock.mockResolvedValueOnce({
      error: "error_account_required",
      available_accounts: ["Work", "Perso"],
    } satisfies AccountResolution);

    const res = await handleNotionSearch({ query: "kebab" });

    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text;
    expect(text).toMatch(/account/i);
    expect(text).toContain("Work");
    expect(text).toContain("Perso");
    expect(resolveMock).toHaveBeenCalledWith("notion", {});
  });

  it("error_no_account → 'not configured' envelope, no fetch", async () => {
    resolveMock.mockResolvedValueOnce({ error: "error_no_account" } satisfies AccountResolution);

    const res = await handleNotionSearch({ query: "kebab" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/not configured/i);
  });
});
