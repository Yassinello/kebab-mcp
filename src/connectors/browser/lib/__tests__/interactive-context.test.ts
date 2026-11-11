/**
 * SEC-13 (2026-11 audit): interactive browser tools are refused in the
 * logged-in LinkedIn context unless explicitly allowed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { assertInteractiveContextAllowed } from "../browserbase";

describe("assertInteractiveContextAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows the default context", () => {
    expect(() => assertInteractiveContextAllowed("default")).not.toThrow();
  });

  it("EXPLOIT: refuses the linkedin context by default", () => {
    expect(() => assertInteractiveContextAllowed("linkedin")).toThrow(/disabled/);
  });

  it("allows linkedin when KEBAB_BROWSER_LINKEDIN_WRITE=1", () => {
    vi.stubEnv("KEBAB_BROWSER_LINKEDIN_WRITE", "1");
    expect(() => assertInteractiveContextAllowed("linkedin")).not.toThrow();
  });
});
