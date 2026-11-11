/** Skills v2 — the skill tag scope fails CLOSED on KV errors. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/core/devices", () => ({
  getDeviceConnectors: vi.fn(async () => null),
  getDeviceSkillTags: vi.fn(async () => {
    throw new Error("kv down");
  }),
}));
vi.mock("@/core/registry", () => ({ CORE_CONNECTOR_IDS: ["admin", "skills"] }));

import { resolveTokenSkillScope, isSkillVisible } from "@/core/token-scope";

describe("resolveTokenSkillScope", () => {
  it("no token → null (all skills)", async () => {
    expect(await resolveTokenSkillScope(null)).toBeNull();
  });
  it("KV error → [] (no skill), never null", async () => {
    expect(await resolveTokenSkillScope("abcd1234")).toEqual([]);
    expect(isSkillVisible(["perso"], [])).toBe(false);
  });
});
