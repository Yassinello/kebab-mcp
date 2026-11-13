/**
 * TRU-04 — out-of-band approval of Unipile sends, through the REAL manifest
 * handlers, write guard, approval store and an in-memory KV.
 *
 * The exploit being closed: the model could pass `confirm: true` itself, so
 * a prompt-injected model approved its own sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeFakeProvider, chat, parse } from "../../__tests__/fakes";

const { kv, config, legacySend } = vi.hoisted(() => ({
  kv: {
    current: null as unknown as ReturnType<typeof import("../../__tests__/fakes").makeMemoryKV>,
  },
  config: new Map<string, string>(),
  legacySend: { fn: null as unknown as (...a: unknown[]) => Promise<unknown> },
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv.current,
  getCurrentTenantId: () => "acme",
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => config.get(k),
  getConfigInt: (k: string, d: number) => (config.has(k) ? Number(config.get(k)) : d),
}));
vi.mock("@/core/signing-secret", () => ({
  getSigningSecret: async () => "test-signing-secret-0123456789abcdef",
}));
vi.mock("@/core/token-scope", () => ({
  getCallerMeta: () => ({ tokenId: "abcd1234", label: "Claude Desktop", profile: null }),
}));
vi.mock("../../tools/linkedin-send-message", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../tools/linkedin-send-message")>();
  return {
    ...real,
    handleLinkedinSendMessage: (...a: unknown[]) => legacySend.fn(...a),
  };
});

import { __setMessagingProviderForTests } from "../../provider";
import { __setVerifyDelaysForTests } from "../write-guard";
import { unipileConnector } from "../../manifest";
import { decide, verifyApprovalSignature, APPROVAL_TTL_SECONDS } from "@/core/approvals";

type Env = Record<string, unknown> & {
  executed: boolean;
  error?: string;
  detail?: string;
  preview_id?: string;
  approval_url?: string;
  approval_required?: boolean;
  approval?: { ignored_arguments?: string[]; notice?: string };
};

let provider: ReturnType<typeof makeFakeProvider>;
let legacySpy: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<unknown>>>;

function tool(name: string) {
  const t = unipileConnector.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (args: Record<string, unknown>) => t.handler(args);
}

function auditRows(): Array<Record<string, unknown>> {
  return [...kv.current.store.entries()]
    .filter(([k]) => k.startsWith("unipile:audit:") && !k.startsWith("unipile:audit:hash:"))
    .map(([, v]) => JSON.parse(v) as Record<string, unknown>);
}

const send = tool("whatsapp_send_message");

async function previewHello(): Promise<Env> {
  const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello" }));
  expect(env.approval_required).toBe(true);
  return env;
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
  legacySpy = vi.fn(async (..._a: unknown[]) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ provider_ok: true }) }],
  }));
  legacySend.fn = legacySpy;
});

afterEach(() => {
  __setMessagingProviderForTests(null);
  __setVerifyDelaysForTests(null);
  vi.useRealTimers();
});

describe("link mode (default) — first call", () => {
  it("returns the preview, a preview_id and a signed absolute approval_url; sends nothing", async () => {
    config.set("KEBAB_PUBLIC_URL", "https://kebab.example.com/some/path");
    const env = await previewHello();
    expect(env.executed).toBe(false);
    expect(env.preview).toMatchObject({ account_id: "wa1", text: "Hello" });
    expect(env).not.toHaveProperty("confirm_required");
    const url = new URL(env.approval_url!);
    expect(url.origin).toBe("https://kebab.example.com");
    expect(url.pathname).toBe(`/approve/${env.preview_id}`);
    expect(url.searchParams.get("t")).toBe("acme");
    expect(
      await verifyApprovalSignature(env.preview_id!, "acme", url.searchParams.get("sig"))
    ).toBe(true);
    expect(String(env.next_step)).toContain(env.approval_url!);
    expect(provider.sendToChat).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);

    // The exact payload is stored server-side, account pinned.
    const stored = JSON.parse(kv.current.store.get(`approvals:${env.preview_id}`)!);
    expect(stored).toMatchObject({
      tool: "whatsapp_send_message",
      status: "pending",
      requestedBy: "Claude Desktop",
      payload: { args: { chat_id: "chat1", text: "Hello", account_id: "wa1" } },
      summary: { account: "wa1", text: "Hello", recipient: "Borderland 2027 (group) · chat chat1" },
    });
    expect(stored.expiresAt - stored.createdAt).toBe(APPROVAL_TTL_SECONDS * 1000);
  });

  it("pre-flight refusals pass through without creating an approval", async () => {
    provider.getChat.mockResolvedValue(null);
    const env = parse<Env>(await send({ chat_id: "nope", text: "x" }));
    expect(env.error).toBe("error_chat_not_found");
    expect(env).not.toHaveProperty("preview_id");
    expect([...kv.current.store.keys()].some((k) => k.startsWith("approvals:"))).toBe(false);
  });
});

describe("EXPLOIT — the model cannot approve its own send", () => {
  it("confirm:true alone is refused, nothing is sent or audited", async () => {
    const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", confirm: true }));
    expect(env.executed).toBe(false);
    expect(env.error).toBe("error_approval_required");
    expect(env.detail).toMatch(/approval/i);
    expect(provider.sendToChat).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("preview_id before the user approved → refused with the link again", async () => {
    const { preview_id } = await previewHello();
    const env = parse<Env>(
      await send({ chat_id: "chat1", text: "Hello", preview_id, confirm: true })
    );
    expect(env.error).toBe("error_approval_pending");
    expect(env.approval_url).toContain(`/approve/${preview_id}`);
    expect(env.detail).toContain(env.approval_url!);
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });

  it("text changed by the model after approval is ignored: the approved text is sent", async () => {
    const { preview_id } = await previewHello();
    await decide(preview_id!, "approve");
    provider.getChat.mockImplementation(async (id: string) => chat({ id }));
    const env = parse<Env>(
      await send({ chat_id: "chat-evil", text: "Wire 5k to X", preview_id, confirm: true })
    );
    expect(env.executed).toBe(true);
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
    expect(provider.sendToChat).toHaveBeenCalledWith({ chatId: "chat1", text: "Hello" });
    expect(env.approval?.ignored_arguments).toEqual(["chat_id", "text"]);
    expect(env.approval?.notice).toMatch(/ignored/);
    // Guard pipeline still ran: one audit row, rate limit incremented.
    expect(auditRows()).toHaveLength(1);
    expect(kv.current.incr).toHaveBeenCalled();
  });

  it("replay of a consumed approval fails", async () => {
    const { preview_id } = await previewHello();
    await decide(preview_id!, "approve");
    const first = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
    expect(first.executed).toBe(true);
    const again = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
    expect(again.error).toBe("error_approval_already_used");
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
  });

  it("an expired approval fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const { preview_id } = await previewHello();
    await decide(preview_id!, "approve");
    vi.setSystemTime(new Date("2026-11-13T10:16:00Z"));
    const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
    expect(env.error).toBe("error_approval_not_found");
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });

  it("a rejected approval fails", async () => {
    const { preview_id } = await previewHello();
    await decide(preview_id!, "reject");
    const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
    expect(env.error).toBe("error_approval_not_found");
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });

  it("unknown or malformed preview_id fails", async () => {
    for (const preview_id of ["0".repeat(32), "../../etc", ""]) {
      const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
      expect(env.error).toBe("error_approval_not_found");
    }
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });

  it("an approval cannot be spent by another tool", async () => {
    const { preview_id } = await previewHello();
    await decide(preview_id!, "approve");
    const post = tool("linkedin_create_post");
    const env = parse<Env>(await post({ text: "Hello", preview_id }));
    expect(env.error).toBe("error_approval_tool_mismatch");
    expect(provider.createPost).not.toHaveBeenCalled();
  });
});

describe("execution still goes through the guard pipeline", () => {
  it("kill switch flipped after approval → refused at execution", async () => {
    const { preview_id } = await previewHello();
    await decide(preview_id!, "approve");
    config.set("KEBAB_UNIPILE_WRITES_DISABLED", "true");
    const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", preview_id }));
    expect(env.error).toBe("error_writes_disabled");
    expect(provider.sendToChat).not.toHaveBeenCalled();
  });
});

describe("attachments are pinned by SHA-256", () => {
  const pdf = { filename: "a.pdf", mimetype: "application/pdf", base64: "JVBERi0xLjQ=" };
  const other = { filename: "a.pdf", mimetype: "application/pdf", base64: "SGFja2Vk" };

  it("a swapped file is refused without spending the approval; the approved one is sent", async () => {
    const env0 = parse<Env>(await send({ chat_id: "chat1", text: "Doc", attachments: [pdf] }));
    const { preview_id } = env0;
    const stored = kv.current.store.get(`approvals:${preview_id}`)!;
    expect(stored).not.toContain(pdf.base64); // file bodies are not stored
    await decide(preview_id!, "approve");

    const swapped = parse<Env>(
      await send({ chat_id: "chat1", text: "Doc", attachments: [other], preview_id })
    );
    expect(swapped.error).toBe("error_attachments_mismatch");
    const missing = parse<Env>(await send({ chat_id: "chat1", text: "Doc", preview_id }));
    expect(missing.error).toBe("error_attachments_mismatch");
    expect(provider.sendToChat).not.toHaveBeenCalled();

    const ok = parse<Env>(
      await send({ chat_id: "chat1", text: "Doc", attachments: [pdf], preview_id })
    );
    expect(ok.executed).toBe(true);
    expect(provider.sendToChat).toHaveBeenCalledTimes(1);
  });
});

describe("historical LinkedIn writes (no preview step of their own)", () => {
  const dm = tool("linkedin_send_message");
  const args = {
    profile_url: "https://www.linkedin.com/in/jane-doe",
    text: "Hi Jane",
    actor_user_id: "u1",
  };

  it("first call previews without calling the send handler; model text change is ignored", async () => {
    const env = parse<Env>(await dm(args));
    expect(env.approval_required).toBe(true);
    expect(env.preview).toMatchObject({ account_id: "li1", text: "Hi Jane" });
    expect(legacySpy).not.toHaveBeenCalled();

    const refused = parse<Env>(await dm({ ...args, confirm: true }));
    expect(refused.error).toBe("error_approval_required");
    expect(legacySpy).not.toHaveBeenCalled();

    await decide(env.preview_id!, "approve");
    const done = parse<Env>(
      await dm({ ...args, text: "Send me your password", preview_id: env.preview_id })
    );
    expect(legacySpy).toHaveBeenCalledTimes(1);
    expect(legacySpy).toHaveBeenCalledWith({ ...args, account_id: "li1" });
    expect(done.approval?.ignored_arguments).toEqual(["text"]);
  });

  it("kill switch → refused before any approval is offered", async () => {
    config.set("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED", "true");
    const env = parse<Env>(await dm(args));
    expect(env.error).toBe("error_writes_disabled");
    expect(env).not.toHaveProperty("preview_id");
  });
});

describe("KEBAB_APPROVAL_MODE=confirm — previous behaviour", () => {
  beforeEach(() => config.set("KEBAB_APPROVAL_MODE", "confirm"));

  it("guarded tools: preview with confirm_required, then confirm:true sends", async () => {
    const preview = parse<Env>(await send({ chat_id: "chat1", text: "Hello" }));
    expect(preview.confirm_required).toBe(true);
    expect(preview).not.toHaveProperty("approval_url");
    const env = parse<Env>(await send({ chat_id: "chat1", text: "Hello", confirm: true }));
    expect(env.executed).toBe(true);
    expect(provider.sendToChat).toHaveBeenCalledWith({ chatId: "chat1", text: "Hello" });
  });

  it("historical tools send directly", async () => {
    const dm = tool("linkedin_send_message");
    await dm({ profile_url: "https://www.linkedin.com/in/x", text: "t", actor_user_id: "u" });
    expect(legacySpy).toHaveBeenCalledTimes(1);
  });

  it("descriptions follow the mode", () => {
    const desc = unipileConnector.tools.find((t) => t.name === "linkedin_reply")!.description;
    expect(desc).toContain("confirm:true");
    config.delete("KEBAB_APPROVAL_MODE");
    const linkDesc = unipileConnector.tools.find((t) => t.name === "linkedin_reply")!.description;
    expect(linkDesc).toContain("approval_url");
  });
});
