import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchMock = vi.fn();
const runActorMock = vi.fn();

vi.mock("@/core/fetch-utils", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("../../lib/client", () => ({
  runActor: (...args: unknown[]) => runActorMock(...args),
}));

import { handleApifyLinkedinPost, resolveLinkedinShortlink } from "../linkedin-post";

const POST = "https://www.linkedin.com/posts/someone_activity-123";

describe("apify_linkedin_post", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    runActorMock.mockReset().mockResolvedValue([{ ok: true }]);
  });

  it("sends the URL as `urls` (actor input contract)", async () => {
    await handleApifyLinkedinPost({ url: POST });
    expect(runActorMock).toHaveBeenCalledWith("supreme_coder/linkedin-post", { urls: [POST] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves lnkd.in via redirect before calling the actor", async () => {
    const res = new Response("", { status: 200 });
    Object.defineProperty(res, "url", { value: POST });
    fetchMock.mockResolvedValueOnce(res);
    await handleApifyLinkedinPost({ url: "https://lnkd.in/abc123" });
    expect(runActorMock).toHaveBeenCalledWith("supreme_coder/linkedin-post", { urls: [POST] });
  });

  it("resolves lnkd.in interstitial HTML", async () => {
    const res = new Response(`<a href="${POST}?a=1&amp;b=2">go</a>`, { status: 200 });
    Object.defineProperty(res, "url", { value: "https://lnkd.in/abc123" });
    fetchMock.mockResolvedValueOnce(res);
    expect(await resolveLinkedinShortlink("https://lnkd.in/abc123")).toBe(`${POST}?a=1&b=2`);
  });

  it("falls back to the original URL when resolution fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect(await resolveLinkedinShortlink("https://lnkd.in/x")).toBe("https://lnkd.in/x");
  });
});
