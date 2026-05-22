/**
 * Phase 75 (MAUI-01): Notion testConnection() account-name derivation.
 *
 * The multi-account `/api/config/accounts` POST route reads the
 * `account_name` field this function returns to auto-name a newly
 * connected account. These tests pin:
 *   - the legacy `message` string stays UNCHANGED (other callers assert it),
 *   - `account_name` = the integration `name` (fallback "Notion integration"),
 *   - `account_id` = the bot `id` when present, omitted otherwise
 *     (exactOptionalPropertyTypes — never an explicit `undefined`).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { notionConnector } from "../manifest";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("notion testConnection() — account-name derivation (MAUI-01)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok=false with no fetch when api key is missing", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await notionConnector.testConnection!({});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/missing api key/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives account_name from name and account_id from id", async () => {
    mockFetchOnce({ id: "bot-1", name: "MyBot", type: "bot" });
    const res = await notionConnector.testConnection!({ NOTION_API_KEY: "secret_x" });
    expect(res.ok).toBe(true);
    // Legacy message unchanged — setup-test-dispatch asserts /MyBot/.
    expect(res.message).toBe("Connected as MyBot (bot)");
    expect(res.account_name).toBe("MyBot");
    expect(res.account_id).toBe("bot-1");
  });

  it("falls back to 'Notion integration' when name is absent", async () => {
    mockFetchOnce({ id: "bot-1", type: "bot" });
    const res = await notionConnector.testConnection!({ NOTION_API_KEY: "secret_x" });
    expect(res.ok).toBe(true);
    expect(res.account_name).toBe("Notion integration");
    expect(res.account_id).toBe("bot-1");
  });

  it("omits account_id when id is absent (no explicit undefined)", async () => {
    mockFetchOnce({ name: "MyBot", type: "bot" });
    const res = await notionConnector.testConnection!({ NOTION_API_KEY: "secret_x" });
    expect(res.ok).toBe(true);
    expect(res.account_name).toBe("MyBot");
    expect("account_id" in res).toBe(false);
  });

  it("returns ok=false with detail on auth failure (no account_name)", async () => {
    mockFetchOnce({ code: "unauthorized", message: "bad token" }, 401);
    const res = await notionConnector.testConnection!({ NOTION_API_KEY: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/bad token|unauthorized/);
    expect(res.account_name).toBeUndefined();
  });
});
