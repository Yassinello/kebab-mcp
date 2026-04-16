/**
 * Tests for per-tool enable/disable via KV.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock kv-store before importing tool-toggles
const mockKV: Record<string, string> = {};
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem" as const,
    get: async (key: string) => mockKV[key] ?? null,
    set: async (key: string, value: string) => {
      mockKV[key] = value;
    },
    delete: async (key: string) => {
      delete mockKV[key];
    },
    list: async (prefix?: string) =>
      Object.keys(mockKV).filter((k) => (prefix ? k.startsWith(prefix) : true)),
  }),
}));

vi.mock("@/core/events", () => ({
  emit: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));

import {
  isToolDisabled,
  setToolDisabled,
  getDisabledTools,
  __resetDisabledToolsCacheForTests,
} from "@/core/tool-toggles";
import { emit } from "@/core/events";

describe("tool-toggles", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    __resetDisabledToolsCacheForTests();
    vi.clearAllMocks();
  });

  it("reports a tool as enabled by default", async () => {
    expect(await isToolDisabled("gmail_search")).toBe(false);
  });

  it("disables a tool and reports it as disabled", async () => {
    await setToolDisabled("gmail_search", true);
    expect(await isToolDisabled("gmail_search")).toBe(true);
    expect(mockKV["tool:disabled:gmail_search"]).toBe("true");
    expect(emit).toHaveBeenCalledWith("env.changed");
  });

  it("re-enables a tool by deleting the key", async () => {
    mockKV["tool:disabled:gmail_search"] = "true";
    await setToolDisabled("gmail_search", false);
    expect(await isToolDisabled("gmail_search")).toBe(false);
    expect(mockKV["tool:disabled:gmail_search"]).toBeUndefined();
  });

  it("getDisabledTools returns all disabled tool names", async () => {
    mockKV["tool:disabled:gmail_search"] = "true";
    mockKV["tool:disabled:vault_read"] = "true";
    mockKV["other:key"] = "value";

    const disabled = await getDisabledTools();
    expect(disabled).toEqual(new Set(["gmail_search", "vault_read"]));
  });

  it("getDisabledTools returns empty set when nothing is disabled", async () => {
    const disabled = await getDisabledTools();
    expect(disabled.size).toBe(0);
  });
});
