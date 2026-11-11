/** REL-08 (2026-11 audit): linkedin_feed daily counter lives in KV. */
import { describe, it, expect, vi } from "vitest";

const store = new Map<string, number>();
vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => ({
    kind: "upstash",
    get: async () => null,
    set: async () => undefined,
    incr: async (k: string) => {
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
  }),
  getCurrentTenantId: () => null,
}));
vi.mock("@/core/config", () => ({ getInstanceConfig: () => ({ timezone: "Europe/Paris" }) }));

import { checkAndIncrementDailyLimit } from "../browserbase";

describe("checkAndIncrementDailyLimit", () => {
  it("admits up to the limit then refuses, without any GitHub call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await checkAndIncrementDailyLimit(2)).toEqual({ allowed: true, count: 1 });
    expect(await checkAndIncrementDailyLimit(2)).toEqual({ allowed: true, count: 2 });
    expect((await checkAndIncrementDailyLimit(2)).allowed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
