/**
 * Phase 74 (MATL-01/03/04/05) — Slack tool account selection.
 *
 * Proves the optional `account` param threads the SELECTED account's token
 * set down to the slack-api fetch layer:
 *   - slack_send(account:"work") vs slack_send(account:"perso") send with
 *     DIFFERENT bot-token Authorization headers.
 *   - omitting `account` with 2 accounts + no pinned default returns the
 *     error_account_required envelope listing the account names (NOT a throw).
 *   - slack_search uses the selected account's SLACK_USER_TOKEN (MATL-05).
 *
 * Mock strategy: stub `@/core/connector-accounts.resolveConnectorAccount`
 * (the resolver the handlers call). The slack-api layer is exercised for
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

import { handleSlackSend } from "../slack-send";
import { handleSlackSearch } from "../slack-search";

const WORK: AccountResolution = {
  account: {
    slug: "work",
    name: "Work",
    tokens: { SLACK_BOT_TOKEN: "xoxb-work" },
  },
};
const PERSO: AccountResolution = {
  account: {
    slug: "perso",
    name: "Perso",
    tokens: { SLACK_BOT_TOKEN: "xoxb-perso" },
  },
};

const fetchSpy = vi.fn();

function slackRes(body: Record<string, unknown>): Response {
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

describe("Phase 74 — Slack account selection", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    resolveMock.mockReset();
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("slack_send(account:'work') vs (account:'perso') use different bot tokens", async () => {
    // Fresh Response per call — a Response body can only be read once.
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, ts: "1.1", channel: "C1" }));
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, ts: "1.2", channel: "C1" }));

    resolveMock.mockResolvedValueOnce(WORK);
    await handleSlackSend({ channel: "C1", text: "hi", account: "work" });
    expect(authHeaderOf(fetchSpy.mock.calls[0]!)).toBe("Bearer xoxb-work");

    resolveMock.mockResolvedValueOnce(PERSO);
    await handleSlackSend({ channel: "C1", text: "hi", account: "perso" });
    expect(authHeaderOf(fetchSpy.mock.calls[1]!)).toBe("Bearer xoxb-perso");

    // The selector was forwarded to the resolver verbatim.
    expect(resolveMock).toHaveBeenNthCalledWith(1, "slack", { account: "work" });
    expect(resolveMock).toHaveBeenNthCalledWith(2, "slack", { account: "perso" });
  });

  it("omitting account with 2 accounts + no default → error_account_required envelope listing names", async () => {
    resolveMock.mockResolvedValueOnce({
      error: "error_account_required",
      available_accounts: ["Work", "Perso"],
    } satisfies AccountResolution);

    const res = await handleSlackSend({ channel: "C1", text: "hi" });

    // Structured-content error response, NOT a thrown error, NOT an outbound call.
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text;
    expect(text).toMatch(/account/i);
    expect(text).toContain("Work");
    expect(text).toContain("Perso");
    // No explicit selector → resolver called with empty args.
    expect(resolveMock).toHaveBeenCalledWith("slack", {});
  });

  it("error_no_account → 'not configured' envelope, no fetch", async () => {
    resolveMock.mockResolvedValueOnce({
      error: "error_no_account",
    } satisfies AccountResolution);

    const res = await handleSlackSend({ channel: "C1", text: "hi" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toMatch(/not configured/i);
  });

  it("slack_search uses the SELECTED account's SLACK_USER_TOKEN (MATL-05)", async () => {
    resolveMock.mockResolvedValueOnce({
      account: {
        slug: "work",
        name: "Work",
        tokens: { SLACK_BOT_TOKEN: "xoxb-work", SLACK_USER_TOKEN: "xoxp-work-user" },
      },
    } satisfies AccountResolution);
    fetchSpy.mockResolvedValue(slackRes({ ok: true, messages: { matches: [] } }));

    await handleSlackSearch({ query: "kebab", account: "work" });

    // search.messages must use the user token, not the bot token (MATL-05).
    expect(authHeaderOf(fetchSpy.mock.calls[0]!)).toBe("Bearer xoxp-work-user");
  });

  it("slack_search falls back to SLACK_BOT_TOKEN when the account has no user token", async () => {
    resolveMock.mockResolvedValueOnce(WORK);
    fetchSpy.mockResolvedValue(slackRes({ ok: true, messages: { matches: [] } }));

    await handleSlackSearch({ query: "kebab", account: "work" });
    expect(authHeaderOf(fetchSpy.mock.calls[0]!)).toBe("Bearer xoxb-work");
  });
});
