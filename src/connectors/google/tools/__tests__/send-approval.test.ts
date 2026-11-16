/**
 * Audit 2026-11 (A4) — gmail_send, gmail_reply and google_chat_send_message
 * only send after the user approved the exact message out of band (approval
 * link), through the REAL manifest handlers, approval store and gate.
 *
 * Mocked: the Google API layer (send/read/create), account resolution, KV.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { kvStore, config, sendEmail, readEmail, replyToEmail, createMessage, fetchJSON } =
  vi.hoisted(() => ({
    kvStore: new Map<string, string>(),
    config: new Map<string, string>(),
    sendEmail: vi.fn(),
    readEmail: vi.fn(),
    replyToEmail: vi.fn(),
    createMessage: vi.fn(),
    fetchJSON: vi.fn(),
  }));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => ({
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: string) => void kvStore.set(k, v),
    delete: async (k: string) => void kvStore.delete(k),
    list: async () => [...kvStore.keys()],
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(k)) return { ok: false as const, existing: kvStore.get(k)! };
      kvStore.set(k, v);
      return { ok: true as const };
    },
  }),
  getCurrentTenantId: () => null,
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => config.get(k),
  getConfigInt: (_k: string, d: number) => d,
}));
vi.mock("@/core/signing-secret", () => ({
  getSigningSecret: async () => "test-signing-secret-0123456789abcdef",
}));
vi.mock("@/core/token-scope", () => ({
  getCallerMeta: () => ({ tokenId: "abcd1234", label: "Claude", profile: null }),
}));
vi.mock("@/core/connector-accounts", async (orig) => ({
  ...((await orig()) as object),
  resolveConnectorAccount: async (_id: string, args: { account?: string }) => ({
    account: {
      slug: args.account === "work" ? "work" : "perso",
      name: args.account === "work" ? "Work" : "Perso",
      tokens: { GOOGLE_REFRESH_TOKEN: "x" },
    },
  }),
}));
vi.mock("../../lib/gmail", async (orig) => ({
  ...((await orig()) as object),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  readEmail: (...a: unknown[]) => readEmail(...a),
  replyToEmail: (...a: unknown[]) => replyToEmail(...a),
}));
vi.mock("../../lib/chat", async (orig) => ({
  ...((await orig()) as object),
  createMessage: (...a: unknown[]) => createMessage(...a),
}));
vi.mock("../../lib/google-fetch", async (orig) => ({
  ...((await orig()) as object),
  googleFetchJSON: (...a: unknown[]) => fetchJSON(...a),
}));

import { googleConnector } from "../../manifest";
import { decide } from "@/core/approvals";

type Env = Record<string, unknown> & {
  executed?: boolean;
  error?: string;
  preview_id?: string;
  approval_url?: string;
  approval_required?: boolean;
  preview?: Record<string, unknown>;
  approval?: { ignored_arguments?: string[] };
};

function tool(name: string) {
  const t = googleConnector.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function parse(res: { content: { text: string }[] }, i = 0): Env {
  return JSON.parse(res.content[i]!.text) as Env;
}

beforeEach(() => {
  kvStore.clear();
  config.clear();
  sendEmail.mockReset().mockResolvedValue({ id: "m1", threadId: "t1" });
  replyToEmail.mockReset().mockResolvedValue({ id: "m2", threadId: "t9" });
  readEmail.mockReset().mockResolvedValue({
    id: "orig",
    threadId: "t9",
    from: "Sam <sam@example.org>",
    to: "me@example.com",
    subject: "Lunch on Friday?",
    date: "Fri, 13 Nov 2026",
    messageId: "<orig@example.org>",
    body: "Are you free?",
  });
  createMessage.mockReset().mockResolvedValue({
    sender: { displayName: "Me" },
    createTime: "2026-11-15T10:00:00Z",
    text: "Hello team",
  });
  fetchJSON.mockReset().mockImplementation(async (_ctx: unknown, url: string) => {
    if (url.endsWith("/users/me/profile")) return { emailAddress: "me@example.com" };
    if (url.includes("chat.googleapis.com")) return { displayName: "Team room" };
    return {};
  });
});

describe("gmail_send approval (A4)", () => {
  const args = { to: "ana@example.org", subject: "Report", body: "Here is the report." };

  it("previews with sender, recipients and exact subject + body; sends nothing", async () => {
    const env = parse(await tool("gmail_send").handler({ ...args, cc: "bo@example.org" }));
    expect(env.approval_required).toBe(true);
    expect(env.executed).toBe(false);
    expect(env.preview_id).toMatch(/^[a-f0-9]{32}$/);
    expect(env.approval_url).toContain(`/approve/${env.preview_id}`);
    expect(env.preview).toMatchObject({
      from: "me@example.com",
      to: "ana@example.org",
      cc: "bo@example.org",
      subject: "Report",
      text: "Here is the report.",
    });
    expect(sendEmail).not.toHaveBeenCalled();
    // The approval page shows the same summary.
    const rec = JSON.parse(kvStore.get(`approvals:${env.preview_id}`)!);
    expect(rec.summary).toMatchObject({
      account: "me@example.com",
      recipient: "ana@example.org · cc: bo@example.org",
      text: "Here is the report.",
      details: { subject: "Report", cc: "bo@example.org" },
    });
  });

  it("refuses without the user's approval (pending, confirm:true, unknown id)", async () => {
    const env = parse(await tool("gmail_send").handler(args));
    const pending = parse(
      await tool("gmail_send").handler({ ...args, preview_id: env.preview_id })
    );
    expect(pending.error).toBe("error_approval_pending");
    const confirmOnly = parse(await tool("gmail_send").handler({ ...args, confirm: true }));
    expect(confirmOnly.error).toBe("error_approval_required");
    const unknown = parse(
      await tool("gmail_send").handler({ ...args, preview_id: "0".repeat(32) })
    );
    expect(unknown.error).toBe("error_approval_not_found");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("executes the STORED message once, not the arguments of the executing call", async () => {
    const env = parse(await tool("gmail_send").handler(args));
    await decide(env.preview_id!, "approve");
    const res = await tool("gmail_send").handler({
      to: "attacker@example.net",
      subject: "Report",
      body: "Changed text",
      preview_id: env.preview_id,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [ctx, sent] = sendEmail.mock.calls[0]! as [{ slug: string }, Record<string, unknown>];
    expect(sent).toMatchObject({
      to: "ana@example.org",
      subject: "Report",
      body: "Here is the report.",
    });
    expect(ctx.slug).toBe("perso"); // the account pinned at preview time
    expect(res.content[0]!.text).toContain("Email sent to ana@example.org");
    const approval = JSON.parse(res.content[1]!.text) as { ignored_arguments: string[] };
    expect(approval.ignored_arguments).toEqual(["body", "to"]);
    // Single use.
    const again = parse(await tool("gmail_send").handler({ ...args, preview_id: env.preview_id }));
    expect(again.error).toBe("error_approval_already_used");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("KEBAB_APPROVAL_MODE=confirm keeps the legacy direct send", async () => {
    config.set("KEBAB_APPROVAL_MODE", "confirm");
    const res = await tool("gmail_send").handler(args);
    expect(res.content[0]!.text).toContain("Email sent to ana@example.org");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("carries the approve view and a description that says approval is needed", () => {
    const t = tool("gmail_send");
    expect(t.meta).toMatchObject({ ui: { resourceUri: expect.stringContaining("approve") } });
    expect(t.description).toMatch(/approval_url/);
    expect(t.schema.preview_id).toBeDefined();
  });
});

describe("gmail_reply approval (A4)", () => {
  it("previews the real recipient and subject of the thread, then sends the stored reply", async () => {
    const env = parse(
      await tool("gmail_reply").handler({ message_id: "orig", body: "Yes, see you then." })
    );
    expect(env.preview).toMatchObject({
      from: "me@example.com",
      to: "Sam <sam@example.org>",
      subject: "Re: Lunch on Friday?",
      text: "Yes, see you then.",
    });
    const pending = parse(
      await tool("gmail_reply").handler({
        message_id: "orig",
        body: "x",
        preview_id: env.preview_id,
      })
    );
    expect(pending.error).toBe("error_approval_pending");
    expect(replyToEmail).not.toHaveBeenCalled();

    await decide(env.preview_id!, "approve");
    await tool("gmail_reply").handler({
      message_id: "other",
      body: "Injected text",
      preview_id: env.preview_id,
    });
    // The stored reply (same thread, same text) is what leaves.
    expect(replyToEmail).toHaveBeenCalledTimes(1);
    expect(replyToEmail.mock.calls[0]![1]).toMatchObject({
      messageId: "orig",
      body: "Yes, see you then.",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses to preview when the original email cannot be read", async () => {
    readEmail.mockRejectedValueOnce(new Error("404"));
    const env = parse(await tool("gmail_reply").handler({ message_id: "nope", body: "Hi" }));
    expect(env.error).toBe("error_preview_failed");
    expect(env.preview_id).toBeUndefined();
  });
});

describe("google_chat_send_message approval (A4)", () => {
  it("previews the space and exact text, refuses unapproved, sends the stored message", async () => {
    const env = parse(
      await tool("google_chat_send_message").handler({
        space_name: "spaces/AAAA",
        text: "Hello team",
      })
    );
    expect(env.preview).toMatchObject({
      from: "me@example.com",
      to: "Team room (spaces/AAAA)",
      text: "Hello team",
    });
    const pending = parse(
      await tool("google_chat_send_message").handler({
        space_name: "spaces/AAAA",
        text: "Hello team",
        preview_id: env.preview_id,
      })
    );
    expect(pending.error).toBe("error_approval_pending");
    expect(createMessage).not.toHaveBeenCalled();

    await decide(env.preview_id!, "approve");
    await tool("google_chat_send_message").handler({
      space_name: "spaces/BBBB",
      text: "Other text",
      preview_id: env.preview_id,
    });
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]!.slice(1)).toEqual(["spaces/AAAA", "Hello team"]);
  });
});
