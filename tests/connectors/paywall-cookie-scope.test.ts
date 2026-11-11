/**
 * SEC-10 (2026-11 audit): session cookies must never follow a redirect to
 * a foreign origin, and Medium detection must use the parsed hostname.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/core/url-safety", () => ({
  isPublicUrl: async () => ({ ok: true }),
}));

import { fetchHtmlWithCookie } from "@/connectors/paywall/lib/fetch-html";
import { isMediumHost } from "@/connectors/vault/tools/save-article";

describe("fetchHtmlWithCookie — cookie scope", () => {
  const seen: Array<{ url: string; cookie: string | null }> = [];

  beforeEach(() => {
    seen.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seen.push({ url, cookie: headers.get("cookie") });
        if (url.startsWith("https://medium.com/")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/steal" },
          });
        }
        return new Response("<html><body>ok</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("EXPLOIT: does not forward the session cookie to a cross-origin redirect target", async () => {
    await fetchHtmlWithCookie("https://medium.com/p/abc", "sid=SECRET");
    expect(seen).toHaveLength(2);
    expect(seen[0]?.cookie).toBe("sid=SECRET");
    expect(seen[1]?.url).toBe("https://attacker.example/steal");
    expect(seen[1]?.cookie).toBeNull();
  });

  it("keeps the cookie for subdomains of the original host", async () => {
    await fetchHtmlWithCookie("https://blog.example.com/a", "sid=S", (u) =>
      u.hostname.endsWith("example.com")
    );
    expect(seen[0]?.cookie).toBe("sid=S");
  });
});

describe("isMediumHost", () => {
  it("matches Medium hosts and subdomains", () => {
    expect(isMediumHost("https://medium.com/@a/b")).toBe(true);
    expect(isMediumHost("https://foo.medium.com/b")).toBe(true);
    expect(isMediumHost("https://towardsdatascience.com/x")).toBe(true);
  });

  it("EXPLOIT: rejects look-alikes that merely contain the string", () => {
    expect(isMediumHost("https://evil.example/medium.com")).toBe(false);
    expect(isMediumHost("https://medium.com.evil.example/")).toBe(false);
    expect(isMediumHost("https://notmedium.com/")).toBe(false);
    expect(isMediumHost("javascript:medium.com")).toBe(false);
  });
});
