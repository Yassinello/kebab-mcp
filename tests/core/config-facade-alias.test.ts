/**
 * Phase 50 / BRAND-01 — KEBAB_* / MYMCP_* alias mechanics.
 *
 * Behavioral contract:
 *  - KEBAB_* reads win with zero deprecation warnings.
 *  - MYMCP_* fallback works, but emits EXACTLY ONE boot-time warning per
 *    variable per process (dedupe via module-level Set<string>).
 *  - Unprefixed keys (e.g. MCP_AUTH_TOKEN) are unchanged (no alias step).
 *  - Test helper `__resetBrandDeprecationWarnings()` clears the dedupe set.
 *
 * The alias step is the 4th resolution position in getConfig():
 *   1) request-context override
 *   2) process.env[KEBAB_*] — NEW priority lookup
 *   3) process.env[MYMCP_*] — NEW fallback (with warning)
 *   4) process.env[key]     — verbatim (non-prefixed keys)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getConfig,
  __resetBrandDeprecationWarnings,
  __getBrandDeprecationWarnings,
} from "@/core/config-facade";

describe("Phase 50 / BRAND-01 — KEBAB_* priority + MYMCP_* fallback", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetBrandDeprecationWarnings();
    delete process.env.KEBAB_TIMEZONE;
    delete process.env.MYMCP_TIMEZONE;
    delete process.env.KEBAB_LOCALE;
    delete process.env.MYMCP_LOCALE;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.KEBAB_TIMEZONE;
    delete process.env.MYMCP_TIMEZONE;
    delete process.env.KEBAB_LOCALE;
    delete process.env.MYMCP_LOCALE;
  });

  it("KEBAB_TIMEZONE takes priority over MYMCP_TIMEZONE, no warning", () => {
    process.env.KEBAB_TIMEZONE = "Europe/Paris";
    process.env.MYMCP_TIMEZONE = "UTC";

    expect(getConfig("MYMCP_TIMEZONE")).toBe("Europe/Paris");
    expect(getConfig("KEBAB_TIMEZONE")).toBe("Europe/Paris");

    // No warning should be logged — KEBAB_* is present.
    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter((arg) => typeof arg === "string" && /deprecated/i.test(arg));
    expect(deprecationWarnings).toHaveLength(0);
  });

  it("KEBAB_TIMEZONE alone — returns value, no warning", () => {
    process.env.KEBAB_TIMEZONE = "UTC";

    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");
    expect(getConfig("KEBAB_TIMEZONE")).toBe("UTC");

    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter((arg) => typeof arg === "string" && /deprecated/i.test(arg));
    expect(deprecationWarnings).toHaveLength(0);
  });

  it("MYMCP_TIMEZONE alone — returns value, warns ONCE per process", () => {
    process.env.MYMCP_TIMEZONE = "UTC";

    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");
    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");
    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");

    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter(
        (arg) => typeof arg === "string" && /deprecated.*MYMCP_TIMEZONE.*KEBAB_TIMEZONE/i.test(arg)
      );
    expect(deprecationWarnings).toHaveLength(1);
    expect(__getBrandDeprecationWarnings().has("MYMCP_TIMEZONE")).toBe(true);
  });

  it("Requesting KEBAB_TIMEZONE with only MYMCP_* set — returns value, still warns once", () => {
    process.env.MYMCP_TIMEZONE = "UTC";

    expect(getConfig("KEBAB_TIMEZONE")).toBe("UTC");

    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter(
        (arg) => typeof arg === "string" && /deprecated.*MYMCP_TIMEZONE.*KEBAB_TIMEZONE/i.test(arg)
      );
    expect(deprecationWarnings).toHaveLength(1);
  });

  it("Multiple variables — each warns independently, once per process", () => {
    process.env.MYMCP_TIMEZONE = "UTC";
    process.env.MYMCP_LOCALE = "en-US";

    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");
    expect(getConfig("MYMCP_LOCALE")).toBe("en-US");
    expect(getConfig("MYMCP_TIMEZONE")).toBe("UTC");
    expect(getConfig("MYMCP_LOCALE")).toBe("en-US");

    const warnings = __getBrandDeprecationWarnings();
    expect(warnings.has("MYMCP_TIMEZONE")).toBe(true);
    expect(warnings.has("MYMCP_LOCALE")).toBe(true);
    expect(warnings.size).toBe(2);

    const deprecationCalls = warnSpy.mock.calls
      .flat()
      .filter((arg) => typeof arg === "string" && /deprecated/i.test(arg));
    // Exactly 2 — one per variable.
    expect(deprecationCalls).toHaveLength(2);
  });

  it("Non-branded keys (MCP_AUTH_TOKEN, ADMIN_AUTH_TOKEN) — unchanged behavior", () => {
    process.env.ADMIN_AUTH_TOKEN = "secret-token";
    try {
      expect(getConfig("ADMIN_AUTH_TOKEN")).toBe("secret-token");
      const deprecationWarnings = warnSpy.mock.calls
        .flat()
        .filter((arg) => typeof arg === "string" && /deprecated/i.test(arg));
      expect(deprecationWarnings).toHaveLength(0);
    } finally {
      delete process.env.ADMIN_AUTH_TOKEN;
    }
  });

  it("__resetBrandDeprecationWarnings clears the dedupe set", () => {
    process.env.MYMCP_TIMEZONE = "UTC";
    getConfig("MYMCP_TIMEZONE");
    expect(__getBrandDeprecationWarnings().has("MYMCP_TIMEZONE")).toBe(true);

    __resetBrandDeprecationWarnings();
    expect(__getBrandDeprecationWarnings().size).toBe(0);

    getConfig("MYMCP_TIMEZONE");
    // After reset, a subsequent read fires a fresh warning.
    expect(__getBrandDeprecationWarnings().has("MYMCP_TIMEZONE")).toBe(true);
  });

  it("Empty MYMCP_* value — does NOT trigger fallback (falls through to undefined)", () => {
    process.env.MYMCP_TIMEZONE = "";

    expect(getConfig("MYMCP_TIMEZONE")).toBe("");
    // Empty string is still returned — this matches pre-Phase-50 semantics.
    // No alias fallback concerns (no warning expected).
    const deprecationWarnings = warnSpy.mock.calls
      .flat()
      .filter((arg) => typeof arg === "string" && /deprecated/i.test(arg));
    expect(deprecationWarnings).toHaveLength(0);
  });
});
