/**
 * v0.20 — unit tests for src/core/token-scope.ts.
 *
 * Covers resolveTokenConnectorScope + isConnectorAllowed:
 *   - null / empty caller token → no filter (full access)
 *   - no stored allowlist → no filter
 *   - stored allowlist → strict set, ∪ core connectors
 *   - empty allowlist → core connectors only
 *   - isConnectorAllowed semantics (null scope allows all)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the device store — token-scope only reads getDeviceConnectors.
const getDeviceConnectorsMock = vi.fn<(id: string) => Promise<string[] | null>>();
vi.mock("@/core/devices", () => ({
  getDeviceConnectors: (id: string) => getDeviceConnectorsMock(id),
}));

// Import under test AFTER mocks. CORE_CONNECTOR_IDS is the real value from
// the static registry table (admin, skills) — not mocked, so the tests
// assert the true core set is always folded in.
import { resolveTokenConnectorScope, isConnectorAllowed } from "@/core/token-scope";
import { CORE_CONNECTOR_IDS } from "@/core/registry";

beforeEach(() => {
  getDeviceConnectorsMock.mockReset();
});

describe("resolveTokenConnectorScope", () => {
  it("returns null (no filter) when caller token is null", async () => {
    expect(await resolveTokenConnectorScope(null)).toBeNull();
    expect(getDeviceConnectorsMock).not.toHaveBeenCalled();
  });

  it("returns null (no filter) when caller token is undefined", async () => {
    expect(await resolveTokenConnectorScope(undefined)).toBeNull();
  });

  it("returns null (no filter) when caller token is empty string", async () => {
    expect(await resolveTokenConnectorScope("")).toBeNull();
    expect(getDeviceConnectorsMock).not.toHaveBeenCalled();
  });

  it("returns null (no filter) when no allowlist is stored", async () => {
    getDeviceConnectorsMock.mockResolvedValue(null);
    expect(await resolveTokenConnectorScope("abcd1234")).toBeNull();
  });

  it("returns the allowlist ∪ core connectors when a scope is stored", async () => {
    getDeviceConnectorsMock.mockResolvedValue(["apify", "unipile"]);
    const scope = await resolveTokenConnectorScope("abcd1234");
    expect(scope).not.toBeNull();
    expect(scope!.has("apify")).toBe(true);
    expect(scope!.has("unipile")).toBe(true);
    for (const core of CORE_CONNECTOR_IDS) {
      expect(scope!.has(core)).toBe(true);
    }
    expect(scope!.has("google")).toBe(false);
  });

  it("returns core-only when the allowlist is empty", async () => {
    getDeviceConnectorsMock.mockResolvedValue([]);
    const scope = await resolveTokenConnectorScope("abcd1234");
    expect(scope).not.toBeNull();
    expect(scope!.has("apify")).toBe(false);
    for (const core of CORE_CONNECTOR_IDS) {
      expect(scope!.has(core)).toBe(true);
    }
  });
});

describe("isConnectorAllowed", () => {
  it("allows everything when scope is null (no filter)", () => {
    expect(isConnectorAllowed(null, "google")).toBe(true);
    expect(isConnectorAllowed(null, "apify")).toBe(true);
  });

  it("allows only members of a non-null scope", () => {
    const scope = new Set(["apify", "unipile"]);
    expect(isConnectorAllowed(scope, "apify")).toBe(true);
    expect(isConnectorAllowed(scope, "google")).toBe(false);
  });
});

describe("core connector set sanity", () => {
  it("includes admin and skills as core connectors", () => {
    expect(CORE_CONNECTOR_IDS).toContain("admin");
    expect(CORE_CONNECTOR_IDS).toContain("skills");
  });
});
