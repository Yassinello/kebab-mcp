/**
 * Anonymous "latest upstream release" check (UPD-10..13,
 * docs/specs/cdc-instances-testeurs.md).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchLatestUpstreamRelease,
  parseCachedRelease,
  tokenlessUpdateFields,
  versionFromTag,
} from "@/core/upstream-release";

const API_URL = "https://api.github.com/repos/Yassinello/kebab-mcp/releases/latest";
const WEB_URL = "https://github.com/Yassinello/kebab-mcp/releases/latest";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("versionFromTag", () => {
  it("accepts release-please tags with or without the v", () => {
    expect(versionFromTag("v0.1.19")).toBe("0.1.19");
    expect(versionFromTag("1.2.3")).toBe("1.2.3");
  });
  it("rejects anything else", () => {
    expect(versionFromTag("v0.1.19-rc.1")).toBeNull();
    expect(versionFromTag("latest")).toBeNull();
    expect(versionFromTag("")).toBeNull();
  });
});

describe("fetchLatestUpstreamRelease", () => {
  it("reads the REST API anonymously (no Authorization header)", async () => {
    fetchMock.mockResolvedValueOnce(json({ tag_name: "v0.1.19", draft: false, prerelease: false }));
    const rel = await fetchLatestUpstreamRelease();
    expect(rel).toMatchObject({
      version: "0.1.19",
      tag: "v0.1.19",
      url: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.19",
      source: "api",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(API_URL);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("falls back to the github.com redirect when the API is rate limited", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: "API rate limit exceeded" }, 403))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.20" },
        })
      );
    const rel = await fetchLatestUpstreamRelease();
    expect(rel).toMatchObject({ version: "0.1.20", source: "redirect" });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(WEB_URL);
    expect(init.redirect).toBe("manual");
  });

  it("falls back when the API throws (network error, timeout)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.21" },
      })
    );
    expect((await fetchLatestUpstreamRelease())?.version).toBe("0.1.21");
  });

  it("ignores a draft or pre-release answer", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ tag_name: "v0.2.0", prerelease: true }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await fetchLatestUpstreamRelease()).toBeNull();
  });

  it("returns null, never throws, when both sources fail", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(fetchLatestUpstreamRelease()).resolves.toBeNull();
  });

  it("returns null when the redirect does not point at a release tag", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://github.com/login" } })
      );
    expect(await fetchLatestUpstreamRelease()).toBeNull();
  });
});

describe("tokenlessUpdateFields", () => {
  const latest = {
    version: "0.1.19",
    tag: "v0.1.19",
    url: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.19",
    source: "api" as const,
    checkedAt: "2026-11-21T08:00:00.000Z",
  };

  it("flags a newer release", () => {
    expect(tokenlessUpdateFields("0.1.18", latest)).toEqual({
      available: true,
      installedVersion: "0.1.18",
      latestVersion: "0.1.19",
      releaseUrl: latest.url,
      checkedAt: latest.checkedAt,
    });
  });

  it("is not available when equal or ahead (never offers a downgrade)", () => {
    expect(tokenlessUpdateFields("0.1.19", latest).available).toBe(false);
    expect(tokenlessUpdateFields("0.2.0", latest).available).toBe(false);
  });

  it("says nothing when the release is unknown", () => {
    expect(tokenlessUpdateFields("0.1.18", null)).toEqual({
      available: false,
      installedVersion: "0.1.18",
    });
  });
});

describe("parseCachedRelease", () => {
  it("round-trips a cached release", () => {
    const raw = JSON.stringify({
      version: "0.1.19",
      tag: "v0.1.19",
      url: "https://x",
      source: "redirect",
      checkedAt: "2026-11-21T08:00:00.000Z",
    });
    expect(parseCachedRelease(raw)).toMatchObject({ version: "0.1.19", source: "redirect" });
  });

  it("treats corrupt or partial values as a miss", () => {
    expect(parseCachedRelease(null)).toBeNull();
    expect(parseCachedRelease("{not json")).toBeNull();
    expect(
      parseCachedRelease(JSON.stringify({ version: "x", url: "u", checkedAt: "t" }))
    ).toBeNull();
    expect(parseCachedRelease(JSON.stringify({ version: "0.1.19" }))).toBeNull();
  });
});
