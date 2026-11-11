/**
 * UnipileMessagingProvider — SDK payload → normalized shapes, pagination,
 * retry policy (reads retry 5xx; sends retry only 429 — no double-send).
 * Also the template for any future adapter's contract test (ADR 0002 §7).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnsuccessfulRequestError } from "unipile-node-sdk";

const sdk = vi.hoisted(() => ({
  account: { getAll: vi.fn() },
  messaging: {
    getAllChats: vi.fn(),
    getChat: vi.fn(),
    getAllMessagesFromChat: vi.fn(),
    getAllMessages: vi.fn(),
    getAllAttendees: vi.fn(),
    sendMessage: vi.fn(),
    startNewChat: vi.fn(),
  },
  users: {
    getProfile: vi.fn(),
    getCompanyProfile: vi.fn(),
    getAllRelations: vi.fn(),
    getAllPosts: vi.fn(),
    getPost: vi.fn(),
    createPost: vi.fn(),
    sendPostComment: vi.fn(),
    sendPostReaction: vi.fn(),
    cancelInvitationSent: vi.fn(),
  },
  request: { send: vi.fn() },
}));

vi.mock("../../lib/client", () => ({ getUnipileClient: () => sdk }));
vi.mock("../../lib/retry", async (orig) => {
  const real = await orig<typeof import("../../lib/retry")>();
  // zero backoff so retry tests are instant
  return {
    ...real,
    withRetry: <T>(fn: () => Promise<T>, opts: Parameters<typeof real.withRetry>[1] = {}) =>
      real.withRetry(fn, { ...opts, baseMs: 0 }),
  };
});

import {
  UnipileMessagingProvider,
  parsePostReference,
  profileIdentifier,
  companyIdentifier,
  isCompanyUrl,
  distanceToDegree,
} from "../unipile";

function httpError(status: number, type = ""): UnsuccessfulRequestError {
  return new UnsuccessfulRequestError({ status, type } as never);
}

const p = new UnipileMessagingProvider();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("identifier helpers", () => {
  it.each([
    ["https://www.linkedin.com/in/jane-doe/", "jane-doe"],
    ["https://linkedin.com/in/j%C3%A9r%C3%B4me?trk=x", "jérôme"],
    ["ACoAAAxyz", "ACoAAAxyz"],
  ])("profileIdentifier(%s) = %s", (i, o) => expect(profileIdentifier(i)).toBe(o));

  it("companyIdentifier + isCompanyUrl", () => {
    expect(companyIdentifier("https://www.linkedin.com/company/beeperhq/insights/")).toBe(
      "beeperhq"
    );
    expect(isCompanyUrl("https://www.linkedin.com/company/acme")).toBe(true);
    expect(isCompanyUrl("https://www.linkedin.com/in/jane")).toBe(false);
  });

  it.each([
    ["urn:li:activity:7123456789012345678", "urn:li:activity:7123456789012345678"],
    ["urn:li:ugcPost:7123456789012345678", "urn:li:ugcPost:7123456789012345678"],
    [
      "https://www.linkedin.com/posts/jane_topic-activity-7123456789012345678-AbCd",
      "urn:li:activity:7123456789012345678",
    ],
    [
      "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7123456789012345678/",
      "urn:li:activity:7123456789012345678",
    ],
    ["7123456789012345678", "urn:li:activity:7123456789012345678"],
  ])("parsePostReference(%s)", (i, o) => expect(parsePostReference(i)).toBe(o));

  it("parsePostReference returns null on garbage", () =>
    expect(parsePostReference("hello")).toBeNull());

  it("distanceToDegree", () => {
    expect(distanceToDegree("FIRST_DEGREE")).toBe(1);
    expect(distanceToDegree("DISTANCE_2")).toBe(2);
    expect(distanceToDegree("OUT_OF_NETWORK")).toBeNull();
  });
});

describe("messaging", () => {
  it("listAccounts drops items without id/type", async () => {
    sdk.account.getAll.mockResolvedValue({
      items: [
        { id: "a", type: "WHATSAPP", name: "Me" },
        { type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
      ],
    });
    expect(await p.listAccounts()).toEqual([
      { id: "a", name: "Me", type: "WHATSAPP" },
      { id: "b", name: "b", type: "LINKEDIN" },
    ]);
  });

  it("listChats paginates with cursor, maps fields, forwards filters", async () => {
    sdk.messaging.getAllChats
      .mockResolvedValueOnce({
        items: [
          {
            id: "c1",
            name: "G",
            type: 1,
            unread_count: 2,
            timestamp: "t",
            account_id: "wa",
            account_type: "WHATSAPP",
            provider_id: "x@g.us",
          },
        ],
        cursor: "next",
      })
      .mockResolvedValueOnce({ items: [{ id: "c2", type: 2 }, { name: "no id" }], cursor: null });
    const chats = await p.listChats({
      accountId: "wa",
      channel: "WHATSAPP",
      limit: 50,
      unreadOnly: true,
      afterIso: "2026-01-01",
    });
    expect(chats.map((c) => [c.id, c.conversationType])).toEqual([
      ["c1", "group"],
      ["c2", "channel"],
    ]);
    expect(chats[0]).toMatchObject({
      accountId: "wa",
      accountType: "WHATSAPP",
      unreadCount: 2,
      providerId: "x@g.us",
    });
    expect(sdk.messaging.getAllChats).toHaveBeenNthCalledWith(1, {
      account_id: "wa",
      account_type: "WHATSAPP",
      limit: 50,
      unread: true,
      after: "2026-01-01",
    });
    expect(sdk.messaging.getAllChats.mock.calls[1]![0]).toMatchObject({
      cursor: "next",
      limit: 49,
    });
  });

  it("listChats returns gathered items on a late-page failure, throws on first-page failure", async () => {
    sdk.messaging.getAllChats
      .mockResolvedValueOnce({ items: [{ id: "c1" }], cursor: "n" })
      .mockRejectedValueOnce(httpError(400));
    expect((await p.listChats({ accountId: "a", channel: "WHATSAPP", limit: 10 })).length).toBe(1);
    sdk.messaging.getAllChats.mockRejectedValueOnce(httpError(400));
    await expect(
      p.listChats({ accountId: "a", channel: "WHATSAPP", limit: 10 })
    ).rejects.toBeInstanceOf(UnsuccessfulRequestError);
  });

  it("getChat → null on 404", async () => {
    sdk.messaging.getChat.mockRejectedValue(httpError(404));
    expect(await p.getChat("x")).toBeNull();
  });

  it("message mapping: is_sender → out, attachments flag", async () => {
    sdk.messaging.getAllMessages.mockResolvedValue({
      items: [
        { id: "m", chat_id: "c", is_sender: 1, text: "hi", timestamp: "t", attachments: [{}] },
      ],
    });
    expect(await p.listAccountMessages({ accountId: "a", limit: 5 })).toEqual([
      {
        id: "m",
        chatId: "c",
        direction: "out",
        senderId: null,
        text: "hi",
        sentAt: "t",
        hasAttachments: true,
      },
    ]);
  });

  it("reads retry on 503", async () => {
    sdk.messaging.getAllMessagesFromChat
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ items: [{ id: "m" }] });
    expect(await p.listChatMessages({ chatId: "c", limit: 5 })).toHaveLength(1);
    expect(sdk.messaging.getAllMessagesFromChat).toHaveBeenCalledTimes(2);
  });

  it("sendToChat is NOT retried on 503 (no double-send)", async () => {
    sdk.messaging.sendMessage.mockRejectedValue(httpError(503));
    await expect(p.sendToChat({ chatId: "c", text: "x" })).rejects.toBeInstanceOf(
      UnsuccessfulRequestError
    );
    expect(sdk.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sendToChat IS retried on 429 and returns the message id", async () => {
    sdk.messaging.sendMessage
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ message_id: "m1" });
    expect(await p.sendToChat({ chatId: "c", text: "x" })).toEqual({ messageId: "m1" });
    expect(sdk.messaging.sendMessage).toHaveBeenCalledWith({ chat_id: "c", text: "x" });
  });

  it("startChat passes attendees + attachments and maps ids", async () => {
    sdk.messaging.startNewChat.mockResolvedValue({ chat_id: "c9", message_id: "m9" });
    const buf = Buffer.from("x");
    expect(
      await p.startChat({
        accountId: "wa",
        recipientIds: ["336@s.whatsapp.net"],
        text: "hi",
        attachments: [["f.txt", buf]],
      })
    ).toEqual({ chatId: "c9", messageId: "m9" });
    expect(sdk.messaging.startNewChat).toHaveBeenCalledWith({
      account_id: "wa",
      attendees_ids: ["336@s.whatsapp.net"],
      text: "hi",
      attachments: [["f.txt", buf]],
    });
  });

  it("startChat is NOT retried on 502", async () => {
    sdk.messaging.startNewChat.mockRejectedValue(httpError(502));
    await expect(
      p.startChat({ accountId: "wa", recipientIds: ["x"], text: "t" })
    ).rejects.toBeDefined();
    expect(sdk.messaging.startNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("LinkedIn network", () => {
  it("getProfile asks for experience + about and maps positions/degree", async () => {
    sdk.users.getProfile.mockResolvedValue({
      provider_id: "ACo1",
      public_identifier: "jane",
      first_name: "Jane",
      last_name: "Doe",
      headline: "COO",
      network_distance: "SECOND_DEGREE",
      connections_count: 500,
      work_experience: [{ position: "COO", company: "Acme", start: "2020" }],
    });
    const prof = await p.getProfile({
      accountId: "li",
      identifier: "https://www.linkedin.com/in/jane/",
    });
    expect(sdk.users.getProfile).toHaveBeenCalledWith({
      account_id: "li",
      identifier: "jane",
      linkedin_sections: ["experience", "about"],
    });
    expect(prof).toMatchObject({
      kind: "person",
      degree: 2,
      profileUrl: "https://www.linkedin.com/in/jane",
      positions: [{ title: "COO", company: "Acme", start: "2020", end: null }],
    });
  });

  it("getCompany uses the company slug", async () => {
    sdk.users.getCompanyProfile.mockResolvedValue({
      id: "123",
      name: "Acme",
      industry: ["Software", "AI"],
    });
    const c = await p.getCompany({
      accountId: "li",
      identifier: "https://linkedin.com/company/acme/about",
    });
    expect(sdk.users.getCompanyProfile).toHaveBeenCalledWith({
      account_id: "li",
      identifier: "acme",
    });
    expect(c).toMatchObject({ kind: "company", id: "123", industry: "Software, AI" });
  });

  it("search posts the raw /linkedin/search request with a string[] path", async () => {
    sdk.request.send.mockResolvedValue({
      items: [
        {
          type: "PEOPLE",
          name: "Jane",
          id: "ACo1",
          network_distance: "DISTANCE_1",
          public_profile_url: "u",
        },
      ],
    });
    const res = await p.search({ accountId: "li", category: "people", keywords: "coo", limit: 5 });
    expect(sdk.request.send).toHaveBeenCalledWith({
      method: "POST",
      path: ["linkedin", "search"],
      parameters: { account_id: "li", limit: "5" },
      body: { api: "classic", category: "people", keywords: "coo" },
      headers: { "Content-Type": "application/json" },
    });
    expect(res).toEqual([
      expect.objectContaining({ type: "person", degree: 1, providerId: "ACo1", profileUrl: "u" }),
    ]);
  });

  it("search with url sends the url body", async () => {
    sdk.request.send.mockResolvedValue({ items: [] });
    await p.search({
      accountId: "li",
      category: "people",
      url: "https://www.linkedin.com/search/results/people/?k=x",
      limit: 5,
    });
    expect(sdk.request.send.mock.calls[0]![0].body).toEqual({
      url: "https://www.linkedin.com/search/results/people/?k=x",
    });
  });

  it("listPosts resolves the person's provider id first", async () => {
    sdk.users.getProfile.mockResolvedValue({ provider_id: "ACo1" });
    sdk.users.getAllPosts.mockResolvedValue({
      items: [{ social_id: "urn:li:activity:1", text: "hello", reaction_counter: 3 }],
    });
    const posts = await p.listPosts({
      accountId: "li",
      identifier: "jane",
      isCompany: false,
      limit: 5,
    });
    expect(sdk.users.getAllPosts).toHaveBeenCalledWith({
      account_id: "li",
      identifier: "ACo1",
      limit: 5,
      is_company: false,
    });
    expect(posts[0]).toMatchObject({ postId: "urn:li:activity:1", reactions: 3 });
  });

  it("resolvePostId normalizes the reference then returns getPost's social_id", async () => {
    sdk.users.getPost.mockResolvedValue({ social_id: "urn:li:activity:999" });
    expect(
      await p.resolvePostId({
        accountId: "li",
        post: "https://www.linkedin.com/posts/x-activity-1234567-ab",
      })
    ).toBe("urn:li:activity:999");
    expect(sdk.users.getPost).toHaveBeenCalledWith({
      account_id: "li",
      post_id: "urn:li:activity:1234567",
    });
  });

  it("comment / react / cancel invitation forward the right payloads", async () => {
    await p.commentPost({ accountId: "li", postId: "urn:li:activity:1", text: "Nice" });
    await p.reactPost({ accountId: "li", postId: "urn:li:activity:1", reaction: "insightful" });
    await p.cancelInvitation({ accountId: "li", invitationId: "inv" });
    expect(sdk.users.sendPostComment).toHaveBeenCalledWith({
      account_id: "li",
      post_id: "urn:li:activity:1",
      text: "Nice",
    });
    expect(sdk.users.sendPostReaction).toHaveBeenCalledWith({
      account_id: "li",
      post_id: "urn:li:activity:1",
      reaction_type: "insightful",
    });
    expect(sdk.users.cancelInvitationSent).toHaveBeenCalledWith({
      account_id: "li",
      invitation_id: "inv",
    });
  });

  it("createPost is not retried on 5xx", async () => {
    sdk.users.createPost.mockRejectedValue(httpError(500));
    await expect(p.createPost({ accountId: "li", text: "x" })).rejects.toBeDefined();
    expect(sdk.users.createPost).toHaveBeenCalledTimes(1);
  });
});
