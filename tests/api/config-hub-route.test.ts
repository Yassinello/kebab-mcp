/**
 * 2026-11 audit (C1.1): /api/config/hub — the state behind the Overview's
 * "Your Kebab House" card, checklist and admin-key warning (contract 2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { getKVStore, resetKVStoreCache } from "@/core/kv-store";
import { kvVaultBackend } from "@/connectors/vault/lib/kv-backend";
import { saveProfile } from "@/core/profiles";
import { GET, POST } from "../../app/api/config/hub/route";

const ADMIN = "hub-route-admin-token-0123456789abcd";

function req(auth = true): Request {
  return new Request("http://localhost/api/config/hub", {
    headers: {
      "x-forwarded-for": "8.8.8.8",
      ...(auth ? { authorization: `Bearer ${ADMIN}` } : {}),
    },
  });
}

interface Hub {
  profile: { filled: boolean; bytes: number; by: string | null } | null;
  skills: { count: number; rituals: { installed: number; total: number } } | null;
  clients: { connected: number; seen: string[] } | null;
  notes: { count: number; backend: string } | null;
  adminKeyUsedAt: string | null;
  errors: string[];
}

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-hub-route-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("ADMIN_AUTH_TOKEN", ADMIN);
  vi.stubEnv("MCP_AUTH_TOKEN", "hub-route-mcp-token-0123456789abcdef");
  vi.stubEnv("KEBAB_VAULT_BACKEND", "kv");
  vi.stubEnv("KEBAB_TRUST_URL_HOST", "");
  resetKVStoreCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/config/hub", () => {
  it("requires the admin key", async () => {
    expect((await GET(req(false))).status).toBe(401);
  });

  it("describes an empty hub: no profile, no notes, no client, no warning", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const hub = (await res.json()) as Hub;
    expect(hub.profile).toMatchObject({ filled: false, bytes: 0 });
    expect(hub.notes).toEqual({ count: 0, backend: "kv" });
    expect(hub.clients?.connected).toBe(0);
    expect(hub.skills?.rituals.total).toBeGreaterThan(0);
    expect(hub.adminKeyUsedAt).toBeNull();
  });

  it("reflects a filled profile, notes, active clients and the admin-key warning", async () => {
    await saveProfile("default", "# Me", { by: "Claude" });
    await kvVaultBackend.write("Inbox/a.md", "a");
    await kvVaultBackend.write("b.md", "b");
    const kv = getKVStore();
    const { isoWeek } = await import("@/core/usage");
    const week = isoWeek();
    await kv.set(`usage:${week}:client:Claude`, "3");
    await kv.set(`usage:${week}:client:ChatGPT`, "1");
    await kv.set("security:admin-token-mcp-last", "2026-11-14T10:00:00.000Z");

    const hub = (await (await GET(req())).json()) as Hub;
    expect(hub.profile).toMatchObject({ filled: true, bytes: 4, by: "Claude" });
    expect(hub.notes?.count).toBe(2);
    expect(hub.clients?.connected).toBe(2);
    expect(hub.clients?.seen).toEqual(["ChatGPT", "Claude"]);
    expect(hub.adminKeyUsedAt).toBe("2026-11-14T10:00:00.000Z");
  });

  it("ignores a malformed admin-key timestamp", async () => {
    await getKVStore().set("security:admin-token-mcp-last", "not a date");
    const hub = (await (await GET(req())).json()) as Hub;
    expect(hub.adminKeyUsedAt).toBeNull();
  });
});

describe("GET/POST /api/config/hub — setup checklist items", () => {
  function post(body: unknown, auth = true): Request {
    return new Request("http://localhost/api/config/hub", {
      method: "POST",
      headers: {
        "x-forwarded-for": "8.8.8.8",
        "content-type": "application/json",
        origin: "http://localhost",
        ...(auth ? { authorization: `Bearer ${ADMIN}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  interface Items {
    setup: { step: string; updatedAt: string | null } | null;
    kebabSkillAddedAt: string | null;
  }

  it("a fresh hub: onboarding not started, Kebab House skill not added", async () => {
    const hub = (await (await GET(req())).json()) as Items;
    expect(hub.setup).toEqual({ step: "interview", updatedAt: null });
    expect(hub.kebabSkillAddedAt).toBeNull();
  });

  it("reads the onboarding state written by kebab_setup", async () => {
    await getKVStore().set(
      "onboarding:state",
      JSON.stringify({ step: "done", updatedAt: "2026-11-18T09:00:00.000Z" })
    );
    const hub = (await (await GET(req())).json()) as Items;
    expect(hub.setup).toEqual({ step: "done", updatedAt: "2026-11-18T09:00:00.000Z" });
  });

  it("records the Kebab House skill once, and keeps the first time", async () => {
    const first = await POST(post({ mark: "kebab-skill" }));
    expect(first.status).toBe(200);
    const { kebabSkillAddedAt: at } = (await first.json()) as { kebabSkillAddedAt: string };
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    const again = (await (await POST(post({ mark: "kebab-skill" }))).json()) as {
      kebabSkillAddedAt: string;
    };
    expect(again.kebabSkillAddedAt).toBe(at);
    const hub = (await (await GET(req())).json()) as Items;
    expect(hub.kebabSkillAddedAt).toBe(at);
  });

  it("refuses unknown marks and unauthenticated calls", async () => {
    expect((await POST(post({ mark: "something-else" }))).status).toBe(400);
    expect((await POST(post({ mark: "kebab-skill" }, false))).status).toBe(401);
    const hub = (await (await GET(req())).json()) as Items;
    expect(hub.kebabSkillAddedAt).toBeNull();
  });
});
