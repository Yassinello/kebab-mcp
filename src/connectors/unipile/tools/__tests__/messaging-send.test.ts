/**
 * Spec v2 — whatsapp_send_message + linkedin_reply, exercising the REAL
 * write guard (kill switch, confirm gate, halt flag, short dedup, rate
 * limiter, audit) over an in-memory KV and a fake provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeFakeProvider, chat, parse } from "../../__tests__/fakes";

const { kv, config } = vi.hoisted(() => ({
  kv: {
    current: null as unknown as ReturnType<typeof import("../../__tests__/fakes").makeMemoryKV>,
  },
  config: new Map<string, string>(),
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv.current,
  getCurrentTenantId: () => "t1",
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => config.get(k),
  getConfigInt: (k: string, d: number) => (config.has(k) ? Number(config.get(k)) : d),
}));

import { __setMessagingProviderForTests } from "../../provider";
import { __setVerifyDelaysForTests, SHORT_DEDUP_WINDOW_SECONDS } from "../../lib/write-guard";
import { handleWhatsappSendMessage, handleLinkedinReply, normalizePhone } from "../messaging-send";

type Env = Record<string, unknown> & {
  executed: boolean;
  provider_ok: boolean;
  verified: boolean;
  dedup_hit: boolean;
  error?: string;
  preview?: Record<string, unknown>;
  audit_id?: string;
};

let provider: ReturnType<typeof makeFakeProvider>;

function auditRows(): Array<Record<string, unknown>> {
  return [...kv.current.store.entries()]
    .filter(([k]) => k.startsWith("unipile:audit:") && !k.startsWith("unipile:audit:hash:"))
    .map(([, v]) => JSON.parse(v) as Record<string, unknown>);
}

beforeEach(() => {
  kv.current = makeMemoryKV();
  config.clear();
  provider = makeFakeProvider();
  provider.getChat.mockResolvedValue(chat());
  provider.listChatMessages.mockResolvedValue([
    {
      id: "m-new",
      chatId: "chat1",
      direction: "out",
      senderId: "me",
      text: "x",
      sentAt: new Date().toISOString(),
      hasAttachments: false,
    },
  ]);
  __setMessagingProviderForTests(provider);
  __setVerifyDelaysForTests([0, 0]);
});

afterEach(() => {
  __setMessagingProviderForTests(null);
  __setVerifyDelaysForTests(null);
});

describe("normalizePhone", () => {
  it.each([
    ["+33 6 12 34 56 78", "33612345678"],
    ["0033612345678", "33612345678"],
    ["+1 (415) 555-0100", "14155550100"],
  ])("%s → %s", (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it.each(["06 12 34 56 78", "+33 12", "+1234567890123456"])("rejects %s", (raw) =>
    expect(normalizePhone(raw)).toBeNull()
  );
});

describe("whatsapp_send_message — confirm gate (R1)", () => {
  it("without confirm: preview with resolved chat name, NO send, NO audit, NO rate-limit", async () => {
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "Hello" }));
    expect(env.executed).toBe(false);
    expect(env.confirm_required).toBe(true);
    expect(env.preview).toMatchObject({
      account_id: "wa1",
      to: { chat_id: "chat1", name: "Borderland 2027", conversation_type: "group" },
      text: "Hello",
    });
    expect(provider.sendToChat).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
    expect(kv.current.incr).not.toHaveBeenCalled();
  });

  it("confirm:true sends once, verifies, audits hash-only, increments the cap", async () => {
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "Secret plan", confirm: true })
    );
    expect(env).toMatchObject({
      executed: true,
      provider_ok: true,
      verified: true,
      chat_id: "chat1",
      message_id: "m-new",
    });
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
    expect(provider.sendToChat).toHaveBeenCalledWith({ chatId: "chat1", text: "Secret plan" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "whatsapp_send_message",
      result: "success",
      account_id: "wa1",
    });
    // D-07: the text never lands in KV
    expect(JSON.stringify([...kv.current.store.values()])).not.toContain("Secret plan");
    expect(kv.current.incr).toHaveBeenCalledWith(
      expect.stringContaining("unipile:ratelimit:wa1:whatsapp_send:"),
      expect.anything()
    );
  });
});

describe("whatsapp_send_message — targets & pre-flight", () => {
  it("rejects both chat_id and phone", async () => {
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "c", phone: "+33612345678", text: "x" })
    );
    expect(env.error).toBe("error_invalid_request");
  });

  it("rejects neither chat_id nor phone", async () => {
    const env = parse<Env>(await handleWhatsappSendMessage({ text: "x" }));
    expect(env.error).toBe("error_invalid_request");
  });

  it("phone target: starts a 1:1 chat with <digits>@s.whatsapp.net", async () => {
    provider.listChatMessages.mockResolvedValue([
      {
        id: "m-new",
        chatId: "chat-new",
        direction: "out",
        senderId: "me",
        text: "x",
        sentAt: new Date().toISOString(),
        hasAttachments: false,
      },
    ]);
    const env = parse<Env>(
      await handleWhatsappSendMessage({ phone: "+33 6 12 34 56 78", text: "Salut", confirm: true })
    );
    expect(provider.startChat).toHaveBeenCalledWith({
      accountId: "wa1",
      recipientIds: ["33612345678@s.whatsapp.net"],
      text: "Salut",
    });
    expect(env).toMatchObject({
      executed: true,
      verified: true,
      chat_id: "chat-new",
      phone: "+33612345678",
    });
  });

  it("national-format phone → error_invalid_phone before any send", async () => {
    const env = parse<Env>(
      await handleWhatsappSendMessage({ phone: "06 12 34 56 78", text: "x", confirm: true })
    );
    expect(env.error).toBe("error_invalid_phone");
    expect(provider.startChat).not.toHaveBeenCalled();
  });

  it("unknown chat → error_chat_not_found", async () => {
    provider.getChat.mockResolvedValue(null);
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "nope", text: "x" }));
    expect(env.error).toBe("error_chat_not_found");
  });

  it("LinkedIn chat id → error_wrong_channel", async () => {
    provider.getChat.mockResolvedValue(chat({ accountType: "LINKEDIN", accountId: "li1" }));
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_wrong_channel");
  });

  it("chat of another account → error_chat_account_mismatch", async () => {
    provider.getChat.mockResolvedValue(chat({ accountId: "wa-other" }));
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_chat_account_mismatch");
    expect(String(env.detail)).toContain("wa-other");
  });

  it("broadcast channel → error_read_only_chat", async () => {
    provider.getChat.mockResolvedValue(chat({ conversationType: "channel" }));
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_read_only_chat");
  });

  it("oversized attachment refused pre-flight (no send, no audit)", async () => {
    const big = "A".repeat(21 * 1024 * 1024); // ~15.75 MB decoded
    const env = parse<Env>(
      await handleWhatsappSendMessage({
        chat_id: "chat1",
        text: "x",
        attachments: [{ filename: "big.pdf", mimetype: "application/pdf", base64: big }],
        confirm: true,
      })
    );
    expect(env.error).toBe("error_attachment_too_large");
    expect(provider.sendToChat).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("attachments are decoded to [filename, Buffer] tuples", async () => {
    await handleWhatsappSendMessage({
      chat_id: "chat1",
      text: "doc",
      attachments: [
        { filename: "a.txt", mimetype: "text/plain", base64: Buffer.from("hi").toString("base64") },
      ],
      confirm: true,
    });
    const call = provider.sendToChat.mock.calls[0]![0] as { attachments: Array<[string, Buffer]> };
    expect(call.attachments[0]![0]).toBe("a.txt");
    expect(call.attachments[0]![1].toString()).toBe("hi");
  });
});

describe("whatsapp_send_message — guards", () => {
  it("KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED → refused before account resolve, even for preview", async () => {
    config.set("KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED", "true");
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_writes_disabled");
    expect(provider.listAccounts).not.toHaveBeenCalled();
  });

  it("global KEBAB_UNIPILE_WRITES_DISABLED also stops WhatsApp", async () => {
    config.set("KEBAB_UNIPILE_WRITES_DISABLED", "1");
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env.error).toBe("error_writes_disabled");
  });

  it("LinkedIn kill switch does NOT stop WhatsApp", async () => {
    config.set("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED", "true");
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env.executed).toBe(true);
  });

  it("no WhatsApp account → error_no_account", async () => {
    provider.listAccounts.mockResolvedValue([{ id: "li1", name: "x", type: "LINKEDIN" }]);
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_no_account");
  });

  it("≥2 WhatsApp accounts → error_account_id_required + list", async () => {
    provider.listAccounts.mockResolvedValue([
      { id: "wa1", name: "a", type: "WHATSAPP" },
      { id: "wa2", name: "b", type: "WHATSAPP" },
    ]);
    const env = parse<Env>(await handleWhatsappSendMessage({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["wa1", "wa2"]);
  });

  it("halt flag → error_account_halted, audited, no send", async () => {
    await kv.current.set(
      "unipile:halt:wa1",
      JSON.stringify({
        reason: "credentials_expired",
        halted_at: "2026-11-01T00:00:00Z",
        status: "CREDENTIALS",
      })
    );
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env.error).toBe("error_account_halted");
    expect(env.reason).toBe("credentials_expired");
    expect(provider.sendToChat).not.toHaveBeenCalled();
    expect(auditRows()[0]).toMatchObject({ result: "error_account_halted" });
  });

  it("R4: identical send within 10 min → dedup_hit, not re-sent; different text goes through", async () => {
    await handleWhatsappSendMessage({ chat_id: "chat1", text: "Merci !", confirm: true });
    const second = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "Merci !", confirm: true })
    );
    expect(second.dedup_hit).toBe(true);
    expect(second.executed).toBe(false);
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
    await handleWhatsappSendMessage({ chat_id: "chat1", text: "Merci encore !", confirm: true });
    expect(provider.sendToChat).toHaveBeenCalledTimes(2);
  });

  it("R4: dedup expires after the window (age checked, not only TTL)", async () => {
    await handleWhatsappSendMessage({ chat_id: "chat1", text: "Merci !", confirm: true });
    const realNow = Date.now();
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + (SHORT_DEDUP_WINDOW_SECONDS + 5) * 1000);
    try {
      const env = parse<Env>(
        await handleWhatsappSendMessage({ chat_id: "chat1", text: "Merci !", confirm: true })
      );
      expect(env.dedup_hit).toBe(false);
      expect(provider.sendToChat).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("R5: daily cap reached → error_rate_limit_kebab, no send", async () => {
    config.set("KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP", "1");
    await handleWhatsappSendMessage({ chat_id: "chat1", text: "one", confirm: true });
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "two", confirm: true })
    );
    expect(env).toMatchObject({
      error: "error_rate_limit_kebab",
      blocked_by_rate_limit: true,
      daily_limit: 1,
    });
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
  });

  it("provider failure → executed:true, provider_ok:false, classified + audited, no dedup pointer", async () => {
    provider.sendToChat.mockRejectedValueOnce(new Error("boom"));
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env).toMatchObject({ executed: true, provider_ok: false, error: "error_unipile_5xx" });
    expect(auditRows()[0]).toMatchObject({ result: "error_unipile_5xx" });
    // a retry is allowed (no dedup pointer written on failure)
    provider.sendToChat.mockResolvedValueOnce({ messageId: "m-new" });
    const retry = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(retry.executed).toBe(true);
    expect(retry.dedup_hit).toBe(false);
  });

  it("R7: message never seen → verified:false + unverified_timeout", async () => {
    provider.listChatMessages.mockResolvedValue([]);
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env).toMatchObject({
      executed: true,
      provider_ok: true,
      verified: false,
      error: "unverified_timeout",
    });
    expect(auditRows()[0]).toMatchObject({ result: "unverified_timeout", verified: false });
  });

  it("R7: poll errors are non-fatal", async () => {
    provider.listChatMessages.mockRejectedValueOnce(new Error("blip"));
    const env = parse<Env>(
      await handleWhatsappSendMessage({ chat_id: "chat1", text: "x", confirm: true })
    );
    expect(env.verified).toBe(true);
  });
});

describe("linkedin_reply", () => {
  beforeEach(() => {
    provider.getChat.mockResolvedValue(
      chat({
        id: "lchat",
        accountId: "li1",
        accountType: "LINKEDIN",
        name: "Jane Doe",
        conversationType: "single",
        attendeeProviderId: "ACoJane",
      })
    );
  });

  it("preview without confirm", async () => {
    const env = parse<Env>(await handleLinkedinReply({ chat_id: "lchat", text: "Thanks Jane" }));
    expect(env.preview).toMatchObject({
      channel: "linkedin",
      to: { chat_id: "lchat", name: "Jane Doe" },
    });
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });

  it("confirm → sends into the chat, shares the LinkedIn DM cap, records recipient provider id", async () => {
    const env = parse<Env>(
      await handleLinkedinReply({ chat_id: "lchat", text: "Thanks Jane", confirm: true })
    );
    expect(env).toMatchObject({ executed: true, verified: true, chat_id: "lchat" });
    expect(kv.current.incr).toHaveBeenCalledWith(
      expect.stringContaining("unipile:ratelimit:li1:send_message:"),
      expect.anything()
    );
    expect(auditRows()[0]).toMatchObject({
      tool: "linkedin_reply",
      recipient_provider_id: "ACoJane",
    });
  });

  it("LinkedIn kill switch stops replies", async () => {
    config.set("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED", "true");
    const env = parse<Env>(
      await handleLinkedinReply({ chat_id: "lchat", text: "x", confirm: true })
    );
    expect(env.error).toBe("error_writes_disabled");
  });

  it("WhatsApp chat id → error_wrong_channel", async () => {
    provider.getChat.mockResolvedValue(chat());
    const env = parse<Env>(await handleLinkedinReply({ chat_id: "chat1", text: "x" }));
    expect(env.error).toBe("error_wrong_channel");
  });
});
