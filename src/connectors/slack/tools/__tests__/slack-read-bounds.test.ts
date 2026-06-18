/**
 * slack_read time bounds — toSlackTs normalization + oldest/latest threading
 * into conversations.history.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountResolution } from "@/core/connector-accounts";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock("@/core/connector-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/connector-accounts")>();
  return { ...actual, resolveConnectorAccount: resolveMock };
});

import { handleSlackRead, toSlackTs } from "../slack-read";

const ACCT: AccountResolution = {
  account: { slug: "w", name: "W", tokens: { SLACK_BOT_TOKEN: "xoxb-w" } },
};

function slackRes(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function paramsOf(call: unknown[]): URLSearchParams {
  return new URLSearchParams((call[1] as RequestInit).body as string);
}

describe("toSlackTs", () => {
  it("passes a Unix-seconds string through", () => {
    expect(toSlackTs("1750000000")).toBe("1750000000");
    expect(toSlackTs("1750000000.0001")).toBe("1750000000.0001");
  });
  it("converts an ISO timestamp to Unix seconds", () => {
    expect(toSlackTs("2026-01-01T00:00:00Z")).toBe(
      String(Date.parse("2026-01-01T00:00:00Z") / 1000)
    );
  });
  it("returns undefined for blank or invalid input", () => {
    expect(toSlackTs(undefined)).toBeUndefined();
    expect(toSlackTs("  ")).toBeUndefined();
    expect(toSlackTs("not a date")).toBeUndefined();
  });
});

describe("handleSlackRead with bounds", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    resolveMock.mockResolvedValue(ACCT);
  });

  it("threads oldest/latest (ISO normalized) into conversations.history", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, messages: [] }));
    await handleSlackRead({
      channel: "C1",
      oldest: "2026-01-01T00:00:00Z",
      latest: "1750000000",
    });
    const p = paramsOf(fetchSpy.mock.calls[0]!);
    expect(p.get("channel")).toBe("C1");
    expect(p.get("oldest")).toBe(String(Date.parse("2026-01-01T00:00:00Z") / 1000));
    expect(p.get("latest")).toBe("1750000000");
  });

  it("omits bounds when not provided", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, messages: [] }));
    await handleSlackRead({ channel: "C1" });
    const p = paramsOf(fetchSpy.mock.calls[0]!);
    expect(p.has("oldest")).toBe(false);
    expect(p.has("latest")).toBe(false);
  });
});
