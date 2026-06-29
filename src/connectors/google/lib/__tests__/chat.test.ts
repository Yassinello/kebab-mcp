/**
 * Google Chat lib smoke tests.
 *
 * Mocks ../google-fetch at the module boundary to cover response-shape
 * mapping (spaceType vs legacy type, sender/text/createTime defaults,
 * page-size clamping) without requiring live OAuth.
 * Exercises listSpaces + listMessages + createMessage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const googleFetchJSONMock = vi.fn();
const googleFetchMock = vi.fn();

vi.mock("../google-fetch", () => ({
  googleFetchJSON: (...a: unknown[]) => googleFetchJSONMock(...a),
  googleFetch: (...a: unknown[]) => googleFetchMock(...a),
}));

describe("google/lib/chat.ts", () => {
  beforeEach(() => {
    googleFetchJSONMock.mockReset();
    googleFetchMock.mockReset();
    vi.resetModules();
  });

  describe("listSpaces", () => {
    it("maps spaceType + legacy type to normalized SPACE/DM", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({
        spaces: [
          { name: "spaces/AAA", spaceType: "SPACE", displayName: "Eng" },
          { name: "spaces/BBB", type: "DM" },
          { name: "spaces/CCC", spaceType: "DIRECT_MESSAGE" },
        ],
        nextPageToken: "tok",
      });

      const { listSpaces } = await import("../chat");
      const res = await listSpaces();
      expect(res.spaces).toHaveLength(3);
      expect(res.spaces[0]!.type).toBe("SPACE");
      expect(res.spaces[1]!.type).toBe("DM");
      expect(res.spaces[2]!.type).toBe("DM");
      expect(res.nextPageToken).toBe("tok");
    });

    it("clamps page_size to the API max of 100", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({ spaces: [] });
      const { listSpaces } = await import("../chat");
      await listSpaces({ pageSize: 5000 });
      const url = googleFetchJSONMock.mock.calls[0]![0] as string;
      expect(url).toContain("pageSize=100");
    });

    it("empty spaces → empty array", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({});
      const { listSpaces } = await import("../chat");
      const res = await listSpaces();
      expect(res.spaces).toEqual([]);
    });
  });

  describe("listMessages", () => {
    it("normalizes missing sender/text/createTime to safe defaults", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({
        messages: [
          {
            name: "spaces/AAA/messages/1",
            sender: { name: "users/1", displayName: "Yass" },
            text: "hi",
            createTime: "2026-06-29T10:00:00Z",
          },
          { name: "spaces/AAA/messages/2" },
        ],
      });

      const { listMessages } = await import("../chat");
      const res = await listMessages("spaces/AAA");
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0]!.sender.displayName).toBe("Yass");
      expect(res.messages[1]!.text).toBe("");
      expect(res.messages[1]!.sender.name).toBe("");
      expect(res.messages[1]!.createTime).toBe("");
    });

    it("propagates fetch errors", async () => {
      googleFetchJSONMock.mockRejectedValueOnce(new Error("403 insufficient scopes"));
      const { listMessages } = await import("../chat");
      await expect(listMessages("spaces/AAA")).rejects.toThrow(/insufficient scopes/);
    });
  });

  describe("createMessage", () => {
    it("POSTs the text and normalizes the response", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({
        name: "spaces/AAA/messages/9",
        sender: { name: "users/bot", displayName: "Kebab Bot" },
        text: "sent",
        createTime: "2026-06-29T11:00:00Z",
      });

      const { createMessage } = await import("../chat");
      const msg = await createMessage("spaces/AAA", "sent");
      expect(msg.text).toBe("sent");
      expect(msg.sender.displayName).toBe("Kebab Bot");

      const [, opts] = googleFetchJSONMock.mock.calls[0]! as [
        string,
        { method: string; body: string },
      ];
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ text: "sent" });
    });
  });
});
