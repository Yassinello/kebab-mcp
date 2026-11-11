/**
 * Shared test doubles for the spec-v2 suites: an in-memory tenant KV (with
 * atomic incr, so the REAL rate limiter + audit + dedup run) and a fully
 * vi.fn()-backed provider.
 */
import { vi, type Mocked } from "vitest";
import type { FullProvider, ProviderChat } from "../provider";

export function makeMemoryKV() {
  const store = new Map<string, string>();
  return {
    store,
    kind: "filesystem" as const,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async (prefix?: string) =>
      [...store.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true))
    ),
    incr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? "0") + 1;
      store.set(k, String(n));
      return n;
    }),
  };
}

export function chat(over: Partial<ProviderChat> = {}): ProviderChat {
  return {
    id: "chat1",
    accountId: "wa1",
    accountType: "WHATSAPP",
    name: "Borderland 2027",
    conversationType: "group",
    providerId: "120363000000@g.us",
    attendeeProviderId: null,
    unreadCount: 0,
    lastMessageAt: "2026-11-01T10:00:00.000Z",
    folder: [],
    ...over,
  };
}

export function makeFakeProvider(): Mocked<FullProvider> {
  return {
    id: "fake",
    listAccounts: vi.fn(async () => [
      { id: "li1", name: "Yass LI", type: "LINKEDIN" },
      { id: "wa1", name: "Yass WA", type: "WHATSAPP" },
    ]),
    listChats: vi.fn(async () => []),
    getChat: vi.fn(async () => null),
    listChatMessages: vi.fn(async () => []),
    listAccountMessages: vi.fn(async () => []),
    listContacts: vi.fn(async () => []),
    sendToChat: vi.fn(async () => ({ messageId: "m-new" })),
    startChat: vi.fn(async () => ({ chatId: "chat-new", messageId: "m-new" })),
    getProfile: vi.fn(),
    getCompany: vi.fn(),
    listConnections: vi.fn(async () => []),
    search: vi.fn(async () => []),
    listPosts: vi.fn(async () => []),
    resolvePostId: vi.fn(async () => "urn:li:activity:7000000000000000001"),
    createPost: vi.fn(async () => ({ postId: "p1" })),
    commentPost: vi.fn(async () => undefined),
    reactPost: vi.fn(async () => undefined),
    cancelInvitation: vi.fn(async () => undefined),
  } as unknown as Mocked<FullProvider>;
}

export function parse<T = Record<string, unknown>>(r: { content: Array<{ text: string }> }): T {
  return JSON.parse(r.content[0]!.text) as T;
}
