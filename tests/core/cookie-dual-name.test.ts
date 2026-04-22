/**
 * Phase 50 / BRAND-02 — Admin cookie rename (dual-write, dual-read).
 *
 * Behavioral contract:
 *  - `extractToken(request)` accepts both `kebab_admin_token` and
 *    `mymcp_admin_token` cookies. When both present, `kebab_*` wins.
 *  - `setAdminCookies(response, token)` emits TWO Set-Cookie headers
 *    (one per name) with identical attributes (HttpOnly, SameSite=Strict,
 *    Secure, Path=/, Max-Age).
 *  - `clearAdminCookies(response)` emits TWO Set-Cookie headers with
 *    Max-Age=0, one per name.
 *  - Legacy-cookie read logs a single once-per-process deprecation notice
 *    (dedupe via the same brand-deprecation set).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractToken,
  setAdminCookies,
  clearAdminCookies,
  __resetAuthCookieWarnings,
} from "@/core/auth";

describe("Phase 50 / BRAND-02 — kebab_admin_token dual-write + dual-read", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetAuthCookieWarnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function reqWithCookie(cookieHeader: string): Request {
    return new Request("https://example.test/api/x", {
      headers: { cookie: cookieHeader },
    });
  }

  it("extractToken reads kebab_admin_token when only that cookie is present", () => {
    const token = extractToken(reqWithCookie("kebab_admin_token=abc123"));
    expect(token).toBe("abc123");
  });

  it("extractToken falls back to mymcp_admin_token (legacy) with warning", () => {
    const token = extractToken(reqWithCookie("mymcp_admin_token=legacy123"));
    expect(token).toBe("legacy123");

    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter(
        (arg: unknown) => typeof arg === "string" && /deprecated.*mymcp_admin_token/i.test(arg)
      );
    expect(deprecationWarnings).toHaveLength(1);
  });

  it("extractToken — kebab wins when both cookies present with different values", () => {
    const token = extractToken(reqWithCookie("mymcp_admin_token=old; kebab_admin_token=new"));
    expect(token).toBe("new");
  });

  it("extractToken — multiple legacy reads produce exactly one warning per process", () => {
    extractToken(reqWithCookie("mymcp_admin_token=t1"));
    extractToken(reqWithCookie("mymcp_admin_token=t2"));
    extractToken(reqWithCookie("mymcp_admin_token=t3"));

    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter(
        (arg: unknown) => typeof arg === "string" && /deprecated.*mymcp_admin_token/i.test(arg)
      );
    expect(deprecationWarnings).toHaveLength(1);
  });

  it("extractToken — URI-decodes cookie values", () => {
    const token = extractToken(reqWithCookie("kebab_admin_token=a%2Bb"));
    expect(token).toBe("a+b");
  });

  it("setAdminCookies emits TWO Set-Cookie headers with identical attributes", () => {
    const headers = new Headers();
    setAdminCookies(headers, "secret-token");

    const cookies = headers.getSetCookie();
    expect(cookies).toHaveLength(2);

    const kebab = cookies.find((c) => c.startsWith("kebab_admin_token="));
    const legacy = cookies.find((c) => c.startsWith("mymcp_admin_token="));

    expect(kebab).toBeDefined();
    expect(legacy).toBeDefined();

    // Both cookies carry the same value.
    expect(kebab).toContain("kebab_admin_token=secret-token");
    expect(legacy).toContain("mymcp_admin_token=secret-token");

    // Both cookies carry the same security attributes.
    for (const c of [kebab!, legacy!]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Strict/i);
      expect(c).toMatch(/Secure/i);
      expect(c).toMatch(/Path=\//);
      expect(c).toMatch(/Max-Age=\d+/);
    }
  });

  it("clearAdminCookies emits TWO Set-Cookie headers with Max-Age=0", () => {
    const headers = new Headers();
    clearAdminCookies(headers);

    const cookies = headers.getSetCookie();
    expect(cookies).toHaveLength(2);

    const kebab = cookies.find((c) => c.startsWith("kebab_admin_token="));
    const legacy = cookies.find((c) => c.startsWith("mymcp_admin_token="));

    expect(kebab).toMatch(/Max-Age=0/);
    expect(legacy).toMatch(/Max-Age=0/);
  });

  it("extractToken — no cookies at all returns null", () => {
    const req = new Request("https://example.test/api/x");
    expect(extractToken(req)).toBe(null);
  });

  it("extractToken — Authorization header still takes priority over cookies", () => {
    const req = new Request("https://example.test/api/x", {
      headers: {
        authorization: "Bearer header-token",
        cookie: "kebab_admin_token=cookie-token",
      },
    });
    expect(extractToken(req)).toBe("header-token");
  });
});
