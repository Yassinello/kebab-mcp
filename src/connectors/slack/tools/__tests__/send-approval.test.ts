/**
 * Audit 2026-11 (A4) — slack_send and slack_send_dm only send after the user
 * approved the exact message out of band (approval link), through the REAL
 * manifest handlers, approval store and gate. The Slack API layer and the
 * account resolution are mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { kvStore, config, sendMessage, openDmAndSend, resolveUserId } = vi.hoisted(() => ({
  kvStore: new Map<string, string>(),
  config: new Map<string, string>(),
  sendMessage: vi.fn(),
  openDmAndSend: vi.fn(),
  resolveUserId: vi.fn(),
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
  resolveConnectorAccount: async () => ({
    account: { slug: "acme", name: "Acme", tokens: { SLACK_BOT_TOKEN: "xoxb-test" } },
  }),
}));
vi.mock("../../lib/slack-api", async (orig) => ({
  ...((await orig()) as object),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  openDmAndSend: (...a: unknown[]) => openDmAndSend(...a),
  resolveUserId: (...a: unknown[]) => resolveUserId(...a),
}));

import { slackConnector } from "../../manifest";
import { decide } from "@/core/approvals";

type Env = Record<string, unknown> & {
  executed?: boolean;
  error?: string;
  preview_id?: string;
  approval_required?: boolean;
  preview?: Record<string, unknown>;
};

function tool(name: string) {
  const t = slackConnector.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const parse = (res: { content: { text: string }[] }): Env => JSON.parse(res.content[0]!.text);

beforeEach(() => {
  kvStore.clear();
  config.clear();
  sendMessage.mockReset().mockResolvedValue({ channel: "C0123ABCD", ts: "1.2" });
  openDmAndSend.mockReset().mockResolvedValue({ channel: "D0001", ts: "3.4" });
  resolveUserId
    .mockReset()
    .mockImplementation(async (_t: unknown, to: string) => (to.startsWith("U") ? to : "U0AAAAAAA"));
});

describe("slack_send approval (A4)", () => {
  const args = { channel: "C0123ABCD", text: "Deploy is done." };

  it("previews workspace, channel and exact text; sends nothing", async () => {
    const env = parse(await tool("slack_send").handler(args));
    expect(env.approval_required).toBe(true);
    expect(env.preview).toMatchObject({
      from: "Slack: Acme",
      to: "C0123ABCD",
      text: "Deploy is done.",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses without approval, then sends the stored message once", async () => {
    const env = parse(await tool("slack_send").handler(args));
    expect(
      parse(await tool("slack_send").handler({ ...args, preview_id: env.preview_id })).error
    ).toBe("error_approval_pending");
    expect(parse(await tool("slack_send").handler({ ...args, confirm: true })).error).toBe(
      "error_approval_required"
    );
    expect(sendMessage).not.toHaveBeenCalled();

    await decide(env.preview_id!, "approve");
    await tool("slack_send").handler({
      channel: "C9999EVIL",
      text: "Something else",
      preview_id: env.preview_id,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]!.slice(1, 3)).toEqual(["C0123ABCD", "Deploy is done."]);
    expect(
      parse(await tool("slack_send").handler({ ...args, preview_id: env.preview_id })).error
    ).toBe("error_approval_already_used");
  });

  it("KEBAB_APPROVAL_MODE=confirm keeps the legacy direct send", async () => {
    config.set("KEBAB_APPROVAL_MODE", "confirm");
    await tool("slack_send").handler(args);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("slack_send_dm approval (A4)", () => {
  it("resolves and pins the recipient at preview time", async () => {
    const env = parse(
      await tool("slack_send_dm").handler({ to: "ana@example.org", text: "Are you around?" })
    );
    expect(env.preview).toMatchObject({
      to: "ana@example.org (U0AAAAAAA)",
      text: "Are you around?",
    });
    expect(openDmAndSend).not.toHaveBeenCalled();
    await decide(env.preview_id!, "approve");
    await tool("slack_send_dm").handler({
      to: "UEVIL0000",
      text: "Different",
      preview_id: env.preview_id,
    });
    expect(openDmAndSend).toHaveBeenCalledTimes(1);
    expect(openDmAndSend.mock.calls[0]!.slice(1)).toEqual(["U0AAAAAAA", "Are you around?"]);
  });

  it("refuses to preview an unknown person", async () => {
    resolveUserId.mockRejectedValueOnce(new Error("users_not_found"));
    const env = parse(await tool("slack_send_dm").handler({ to: "nobody", text: "Hi" }));
    expect(env.error).toBe("error_recipient_not_found");
    expect(env.preview_id).toBeUndefined();
  });
});
