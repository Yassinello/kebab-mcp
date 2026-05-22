/**
 * Phase 75 (MAUI-01): Slack testConnection() account-name derivation.
 *
 * The multi-account `/api/config/accounts` POST route reads the
 * `account_name` field this function returns to auto-name a newly
 * connected account. These tests pin:
 *   - the legacy `message` string stays UNCHANGED (other callers assert it),
 *   - `account_name` = the workspace `team`,
 *   - `account_id` = `team_id` when present, omitted otherwise
 *     (exactOptionalPropertyTypes — never an explicit `undefined`).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { slackConnector } from "../manifest";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("slack testConnection() — account-name derivation (MAUI-01)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok=false with no fetch when token is missing", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await slackConnector.testConnection!({});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing token/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives account_name from team and account_id from team_id", async () => {
    mockFetchOnce({ ok: true, team: "Acme", team_id: "T123", user: "kebabbot" });
    const res = await slackConnector.testConnection!({ SLACK_BOT_TOKEN: "xoxb-abc" });
    expect(res.ok).toBe(true);
    // Legacy message unchanged — setup-test-dispatch asserts /Acme/.
    expect(res.message).toBe("Connected to Acme as kebabbot");
    expect(res.account_name).toBe("Acme");
    expect(res.account_id).toBe("T123");
  });

  it("omits account_id when team_id is absent (no explicit undefined)", async () => {
    mockFetchOnce({ ok: true, team: "Acme", user: "kebabbot" });
    const res = await slackConnector.testConnection!({ SLACK_BOT_TOKEN: "xoxb-abc" });
    expect(res.ok).toBe(true);
    expect(res.account_name).toBe("Acme");
    expect("account_id" in res).toBe(false);
  });

  it("falls back to a generic account_name when team is missing", async () => {
    mockFetchOnce({ ok: true, user: "kebabbot" });
    const res = await slackConnector.testConnection!({ SLACK_BOT_TOKEN: "xoxb-abc" });
    expect(res.ok).toBe(true);
    expect(res.account_name).toBe("Slack workspace");
  });

  it("returns ok=false with detail on auth failure (no account_name)", async () => {
    mockFetchOnce({ ok: false, error: "invalid_auth" });
    const res = await slackConnector.testConnection!({ SLACK_BOT_TOKEN: "xoxb-bad" });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/invalid_auth/);
    expect(res.account_name).toBeUndefined();
  });
});
