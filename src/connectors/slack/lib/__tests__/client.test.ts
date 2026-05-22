/**
 * Phase 50 / COV-04 — Slack client backfill.
 *
 * Uses global fetch mock. Covers happy path + the 3 error classifications
 * the slackFetch helper branches on (rate-limit, auth, generic API error).
 *
 * Phase 74 (MATL-01): the slack-api functions now take an explicit
 * `tokens: AccountTokenSet` as their first arg (resolved by the tool
 * handler) instead of reading `getConfig()`. These lib-level tests pass a
 * token set directly; the missing-token CONFIGURATION_ERROR path is now
 * driven by an empty token set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AccountTokenSet } from "@/core/connector-accounts";

const fetchSpy = vi.fn();

const BOT_TOKENS: AccountTokenSet = { SLACK_BOT_TOKEN: "xoxb-test" };

describe("Phase 50 / COV-04 — slack/lib/slack-api.ts", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function slackRes(body: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe("listChannels", () => {
    it("happy path — maps conversations.list payload to SlackChannel[]", async () => {
      fetchSpy.mockResolvedValueOnce(
        slackRes({
          ok: true,
          channels: [
            {
              id: "C1",
              name: "general",
              topic: { value: "All the things" },
              num_members: 42,
              is_private: false,
            },
          ],
        })
      );

      const { listChannels } = await import("../slack-api");
      const channels = await listChannels(BOT_TOKENS, 50);
      expect(channels).toHaveLength(1);
      expect(channels[0]!.id).toBe("C1");
      expect(channels[0]!.name).toBe("general");
      expect(channels[0]!.memberCount).toBe(42);
      expect(channels[0]!.isPrivate).toBe(false);
    });

    it("ratelimited error → SlackRateLimitError", async () => {
      fetchSpy.mockResolvedValueOnce(slackRes({ ok: false, error: "ratelimited" }));
      const { listChannels } = await import("../slack-api");
      await expect(listChannels(BOT_TOKENS)).rejects.toThrow(/rate/i);
    });

    it("invalid_auth error → SlackAuthError", async () => {
      fetchSpy.mockResolvedValueOnce(slackRes({ ok: false, error: "invalid_auth" }));
      const { listChannels } = await import("../slack-api");
      await expect(listChannels(BOT_TOKENS)).rejects.toThrow(/invalid_auth/);
    });

    it("token_revoked error → SlackAuthError", async () => {
      fetchSpy.mockResolvedValueOnce(slackRes({ ok: false, error: "token_revoked" }));
      const { listChannels } = await import("../slack-api");
      await expect(listChannels(BOT_TOKENS)).rejects.toThrow(/token_revoked/);
    });

    it("generic API error → McpToolError with EXTERNAL_API_ERROR code", async () => {
      fetchSpy.mockResolvedValueOnce(slackRes({ ok: false, error: "missing_scope" }));
      const { listChannels } = await import("../slack-api");
      await expect(listChannels(BOT_TOKENS)).rejects.toThrow(/missing_scope/);
    });
  });

  describe("sendMessage", () => {
    it("happy path — posts and returns ts", async () => {
      fetchSpy.mockResolvedValueOnce(
        slackRes({ ok: true, ts: "1234567890.123456", channel: "C1" })
      );
      const { sendMessage } = await import("../slack-api");
      const result = await sendMessage(BOT_TOKENS, "C1", "hi");
      expect(result.ts).toBe("1234567890.123456");
    });
  });

  it("missing SLACK_BOT_TOKEN → McpToolError CONFIGURATION_ERROR", async () => {
    const { listChannels } = await import("../slack-api");
    await expect(listChannels({})).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });
});
