/**
 * Spec v2 — read tools: whatsapp_find_chat, whatsapp/linkedin_search_messages,
 * linkedin_get_profile, linkedin_list_connections, linkedin_search,
 * linkedin_list_posts. Read-only invariant: no KV writes, no rate limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeFakeProvider, chat, parse } from "../../__tests__/fakes";

const { kv } = vi.hoisted(() => ({
  kv: {
    current: null as unknown as ReturnType<typeof import("../../__tests__/fakes").makeMemoryKV>,
  },
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv.current,
  getCurrentTenantId: () => "t1",
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: () => undefined,
  getConfigInt: (_k: string, d: number) => d,
}));

import { __setMessagingProviderForTests, type ProviderMessage } from "../../provider";
import { handleWhatsappFindChat } from "../whatsapp-find-chat";
import {
  handleWhatsappSearchMessages,
  handleLinkedinSearchMessages,
  MAX_SCAN,
} from "../search-messages";
import {
  handleLinkedinGetProfile,
  handleLinkedinListConnections,
  handleLinkedinSearch,
  handleLinkedinListPosts,
} from "../linkedin-network";

let provider: ReturnType<typeof makeFakeProvider>;

function msg(over: Partial<ProviderMessage>): ProviderMessage {
  return {
    id: "m1",
    chatId: "chat1",
    direction: "in",
    senderId: "boris",
    text: "",
    sentAt: "2026-11-02T10:00:00.000Z",
    hasAttachments: false,
    ...over,
  };
}

beforeEach(() => {
  kv.current = makeMemoryKV();
  provider = makeFakeProvider();
  __setMessagingProviderForTests(provider);
});
afterEach(() => {
  __setMessagingProviderForTests(null);
  // read-only invariant
  expect(kv.current.set).not.toHaveBeenCalled();
  expect(kv.current.incr).not.toHaveBeenCalled();
});

describe("whatsapp_find_chat", () => {
  beforeEach(() => {
    provider.listChats.mockResolvedValue([
      chat({ id: "g1", name: "Réunion Borderland 🔥", lastMessageAt: "2026-11-01T00:00:00Z" }),
      chat({ id: "g2", name: "Borderland vans", lastMessageAt: "2026-11-03T00:00:00Z" }),
      chat({
        id: "d1",
        name: "Boris",
        conversationType: "single",
        providerId: "33611112222@s.whatsapp.net",
        attendeeProviderId: "33611112222@s.whatsapp.net",
      }),
    ]);
    provider.listContacts.mockResolvedValue([
      {
        id: "c1",
        name: "Borderland Bob",
        providerId: "33699998888@s.whatsapp.net",
        isSelf: false,
        profileUrl: null,
      },
      {
        id: "c2",
        name: "Me Borderland",
        providerId: "33600000000@s.whatsapp.net",
        isSelf: true,
        profileUrl: null,
      },
    ]);
  });

  it("accent/case-insensitive name match, most recent first, contacts exclude self", async () => {
    const env = parse<{
      chats: Array<{ chat_id: string }>;
      contacts: Array<{ contact_id: string; phone: string }>;
    }>(await handleWhatsappFindChat({ query: "BORDERLAND" }));
    expect(env.chats.map((c) => c.chat_id)).toEqual(["g2", "g1"]);
    expect(env.contacts).toEqual([
      expect.objectContaining({ contact_id: "c1", phone: "+33699998888" }),
    ]);
  });

  it("multi-term + accents: 'reunion border' only matches the first group", async () => {
    const env = parse<{ chats: Array<{ chat_id: string }> }>(
      await handleWhatsappFindChat({ query: "reunion border", include_contacts: false })
    );
    expect(env.chats.map((c) => c.chat_id)).toEqual(["g1"]);
    expect(provider.listContacts).not.toHaveBeenCalled();
  });

  it("phone query matches on digits", async () => {
    const env = parse<{ chats: Array<{ chat_id: string; phone: string }> }>(
      await handleWhatsappFindChat({ query: "+33 6 11 11 22 22" })
    );
    expect(env.chats).toEqual([expect.objectContaining({ chat_id: "d1", phone: "+33611112222" })]);
  });

  it("contact listing failure is non-fatal", async () => {
    provider.listContacts.mockRejectedValue(new Error("x"));
    const env = parse<{ chats: unknown[]; contacts: unknown[] }>(
      await handleWhatsappFindChat({ query: "borderland" })
    );
    expect(env.chats).toHaveLength(2);
    expect(env.contacts).toEqual([]);
  });

  it("provider failure → {error} envelope, never throws", async () => {
    provider.listChats.mockRejectedValue(new Error("down"));
    const env = parse<{ error: string }>(await handleWhatsappFindChat({ query: "borderland" }));
    expect(env.error).toBe("error_unipile_5xx");
  });
});

describe("search_messages", () => {
  it("account-wide WhatsApp search: all terms must match, newest first, chat names resolved", async () => {
    provider.listAccountMessages.mockResolvedValue([
      msg({
        id: "a",
        text: "Les vans arrivent sur la playa mardi",
        sentAt: "2026-11-02T10:00:00Z",
      }),
      msg({ id: "b", text: "Vans OK", sentAt: "2026-11-03T10:00:00Z" }),
      msg({
        id: "c",
        text: "La PLAYA et les VANS, c'est réglé",
        sentAt: "2026-11-04T10:00:00Z",
        chatId: "g2",
      }),
    ]);
    provider.listChats.mockResolvedValue([
      chat({ id: "chat1", name: "Borderland" }),
      chat({ id: "g2", name: "Vans" }),
    ]);
    const env = parse<{
      matches: Array<{ message_id: string; chat_name: string }>;
      scanned: number;
      truncated: boolean;
    }>(await handleWhatsappSearchMessages({ query: "vans playa", since_days: 7 }));
    expect(env.matches.map((m) => m.message_id)).toEqual(["c", "a"]);
    expect(env.matches.map((m) => m.chat_name)).toEqual(["Vans", "Borderland"]);
    expect(env.scanned).toBe(3);
    expect(env.truncated).toBe(false);
    const q = provider.listAccountMessages.mock.calls[0]![0] as {
      accountId: string;
      limit: number;
      afterIso: string;
    };
    expect(q.accountId).toBe("wa1");
    expect(q.limit).toBe(MAX_SCAN);
    expect(Date.now() - new Date(q.afterIso).getTime()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it("chat-scoped search uses listChatMessages", async () => {
    provider.listChatMessages.mockResolvedValue([msg({ text: "rdv à 18h" })]);
    const env = parse<{ matches: unknown[] }>(
      await handleWhatsappSearchMessages({ query: "rdv", chat_id: "chat1" })
    );
    expect(env.matches).toHaveLength(1);
    expect(provider.listChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat1" })
    );
    expect(provider.listAccountMessages).not.toHaveBeenCalled();
  });

  it("LinkedIn variant resolves the LinkedIn account and flags truncation", async () => {
    provider.listAccountMessages.mockResolvedValue(
      Array.from({ length: MAX_SCAN }, (_, i) =>
        msg({ id: `m${i}`, text: i === 5 ? "pricing deck" : "hi" })
      )
    );
    const env = parse<{ matches: unknown[]; truncated: boolean }>(
      await handleLinkedinSearchMessages({ query: "pricing" })
    );
    expect(provider.listAccountMessages.mock.calls[0]![0]).toMatchObject({ accountId: "li1" });
    expect(env.matches).toHaveLength(1);
    expect(env.truncated).toBe(true);
  });

  it("long messages are returned as a snippet around the hit", async () => {
    const long = `${"x".repeat(500)} BORDERLAND ${"y".repeat(500)}`;
    provider.listAccountMessages.mockResolvedValue([msg({ text: long })]);
    const env = parse<{ matches: Array<{ text: string }> }>(
      await handleWhatsappSearchMessages({ query: "borderland" })
    );
    expect(env.matches[0]!.text.length).toBeLessThan(300);
    expect(env.matches[0]!.text).toContain("BORDERLAND");
  });
});

describe("LinkedIn reads", () => {
  it("get_profile routes person vs company URLs", async () => {
    provider.getProfile.mockResolvedValue({ kind: "person", firstName: "Jane" } as never);
    provider.getCompany.mockResolvedValue({ kind: "company", name: "Acme" } as never);
    const p = parse<{ profile: { kind: string } }>(
      await handleLinkedinGetProfile({ identifier: "https://www.linkedin.com/in/jane-doe/" })
    );
    expect(p.profile.kind).toBe("person");
    const c = parse<{ profile: { kind: string } }>(
      await handleLinkedinGetProfile({ identifier: "https://www.linkedin.com/company/acme/" })
    );
    expect(c.profile.kind).toBe("company");
    expect(provider.getProfile).toHaveBeenCalledWith({
      accountId: "li1",
      identifier: "https://www.linkedin.com/in/jane-doe/",
    });
  });

  it("list_connections: query filters on name + headline over scan_limit", async () => {
    provider.listConnections.mockResolvedValue([
      {
        firstName: "Ana",
        lastName: "Lopez",
        headline: "CTO @ fintech",
        providerId: "a",
        publicIdentifier: null,
        profileUrl: null,
        connectedAt: null,
      },
      {
        firstName: "Bob",
        lastName: "Martin",
        headline: "Sales",
        providerId: "b",
        publicIdentifier: null,
        profileUrl: null,
        connectedAt: null,
      },
    ]);
    const env = parse<{ count: number; items: Array<{ providerId: string }> }>(
      await handleLinkedinListConnections({ query: "cto fintech", scan_limit: 300 })
    );
    expect(env.items.map((i) => i.providerId)).toEqual(["a"]);
    expect(provider.listConnections).toHaveBeenCalledWith({ accountId: "li1", limit: 300 });
  });

  it("search requires keywords or url", async () => {
    const env = parse<{ error: string }>(await handleLinkedinSearch({}));
    expect(env.error).toBe("error_invalid_request");
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("search forwards keywords + category", async () => {
    provider.search.mockResolvedValue([{ type: "person", name: "Jane" }] as never);
    const env = parse<{ count: number }>(
      await handleLinkedinSearch({ keywords: "ops director", category: "people", limit: 5 })
    );
    expect(env.count).toBe(1);
    expect(provider.search).toHaveBeenCalledWith({
      accountId: "li1",
      category: "people",
      limit: 5,
      keywords: "ops director",
    });
  });

  it("list_posts detects company URLs", async () => {
    await handleLinkedinListPosts({ identifier: "https://linkedin.com/company/acme" });
    expect(provider.listPosts).toHaveBeenCalledWith(
      expect.objectContaining({ isCompany: true, limit: 10 })
    );
  });

  it("no LinkedIn account → error_no_account", async () => {
    provider.listAccounts.mockResolvedValue([{ id: "wa1", name: "x", type: "WHATSAPP" }]);
    const env = parse<{ error: string }>(await handleLinkedinGetProfile({ identifier: "jane" }));
    expect(env.error).toBe("error_no_account");
  });
});
