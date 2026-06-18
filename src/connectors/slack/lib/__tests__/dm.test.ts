/**
 * resolveUserId + openDmAndSend — slack_send_dm's resolution + send path.
 *
 * resolveUserId accepts a user id (passthrough), an email
 * (users.lookupByEmail), or a name (users.list, must be unambiguous).
 * openDmAndSend opens a DM (conversations.open) then posts (chat.postMessage).
 * The slack-api layer runs for real against a mocked global fetch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveUserId, openDmAndSend } from "../slack-api";

const TOKENS = { SLACK_BOT_TOKEN: "xoxb-test" };

function slackRes(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function methodOf(call: unknown[]): string {
  return String(call[0]).split("/api/")[1] ?? "";
}

function paramsOf(call: unknown[]): URLSearchParams {
  const init = call[1] as RequestInit;
  return new URLSearchParams(init.body as string);
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe("resolveUserId", () => {
  it("passes a user id through without an API call", async () => {
    expect(await resolveUserId(TOKENS, "U012ABCDEF")).toBe("U012ABCDEF");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves an email via users.lookupByEmail", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, user: { id: "U999" } }));
    expect(await resolveUserId(TOKENS, "yass@example.com")).toBe("U999");
    expect(methodOf(fetchSpy.mock.calls[0]!)).toBe("users.lookupByEmail");
    expect(paramsOf(fetchSpy.mock.calls[0]!).get("email")).toBe("yass@example.com");
  });

  it("throws when no user matches an email", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: false, error: "users_not_found" }));
    await expect(resolveUserId(TOKENS, "ghost@example.com")).rejects.toThrow();
  });

  it("resolves a unique name via users.list", async () => {
    fetchSpy.mockResolvedValueOnce(
      slackRes({
        ok: true,
        members: [
          { id: "U1", real_name: "Alice Smith" },
          { id: "U2", real_name: "Bob Jones", profile: { display_name: "bobby" } },
        ],
      })
    );
    expect(await resolveUserId(TOKENS, "bob jones")).toBe("U2");
  });

  it("throws listing candidates when a name is ambiguous", async () => {
    fetchSpy.mockResolvedValueOnce(
      slackRes({
        ok: true,
        members: [
          { id: "U1", real_name: "Alex Doe" },
          { id: "U2", real_name: "Alex Doe" },
        ],
      })
    );
    await expect(resolveUserId(TOKENS, "Alex Doe")).rejects.toThrow(/ambiguous/i);
  });

  it("skips deleted and bot members when matching a name", async () => {
    fetchSpy.mockResolvedValueOnce(
      slackRes({
        ok: true,
        members: [
          { id: "U1", real_name: "Sam", deleted: true },
          { id: "U2", real_name: "Sam", is_bot: true },
          { id: "U3", real_name: "Sam" },
        ],
      })
    );
    expect(await resolveUserId(TOKENS, "sam")).toBe("U3");
  });

  it("throws when a name matches nobody", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true, members: [{ id: "U1", real_name: "X" }] }));
    await expect(resolveUserId(TOKENS, "nobody")).rejects.toThrow();
  });
});

describe("openDmAndSend", () => {
  it("opens a DM then posts to the returned channel", async () => {
    fetchSpy
      .mockResolvedValueOnce(slackRes({ ok: true, channel: { id: "D123" } })) // conversations.open
      .mockResolvedValueOnce(slackRes({ ok: true, ts: "1.2", channel: "D123" })); // chat.postMessage

    const res = await openDmAndSend(TOKENS, "U999", "hi");
    expect(methodOf(fetchSpy.mock.calls[0]!)).toBe("conversations.open");
    expect(paramsOf(fetchSpy.mock.calls[0]!).get("users")).toBe("U999");
    expect(methodOf(fetchSpy.mock.calls[1]!)).toBe("chat.postMessage");
    expect(paramsOf(fetchSpy.mock.calls[1]!).get("channel")).toBe("D123");
    expect(paramsOf(fetchSpy.mock.calls[1]!).get("text")).toBe("hi");
    expect(res).toEqual({ ts: "1.2", channel: "D123" });
  });

  it("throws if conversations.open returns no channel", async () => {
    fetchSpy.mockResolvedValueOnce(slackRes({ ok: true }));
    await expect(openDmAndSend(TOKENS, "U999", "hi")).rejects.toThrow(/no channel/i);
  });
});
