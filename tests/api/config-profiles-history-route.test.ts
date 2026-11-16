/**
 * 2026-11 audit (C1.2): /api/config/profiles — history and restore, plus
 * backward compatibility of the existing verbs. Real pipeline and admin
 * auth, real filesystem KV.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { getKVStore, resetKVStoreCache } from "@/core/kv-store";
import { GET, PUT, POST, DELETE } from "../../app/api/config/profiles/route";

const ADMIN = "profiles-route-admin-token-0123456789";

function req(
  query: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {}
): Request {
  return new Request(`http://localhost/api/config/profiles${query}`, {
    method: opts.method ?? "GET",
    headers: {
      "x-forwarded-for": "8.8.8.8",
      "Content-Type": "application/json",
      ...(opts.auth === false ? {} : { authorization: `Bearer ${ADMIN}` }),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-profiles-route-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("ADMIN_AUTH_TOKEN", ADMIN);
  vi.stubEnv("MCP_AUTH_TOKEN", "profiles-route-mcp-token-0123456789");
  vi.stubEnv("KEBAB_TRUST_URL_HOST", "");
  resetKVStoreCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("/api/config/profiles — history", () => {
  it("requires the admin key for history and restore", async () => {
    expect((await GET(req("?name=default&history=1", { auth: false }))).status).toBe(401);
    const res = await POST(
      req("", {
        method: "POST",
        auth: false,
        body: { action: "restore", name: "default", index: 0 },
      })
    );
    expect(res.status).toBe(401);
  });

  it("records dashboard saves, lists history and restores a version", async () => {
    // A legacy default profile written before history existed.
    await getKVStore().set("mymcp:context:inline", "legacy profile");
    expect(
      (await PUT(req("", { method: "PUT", body: { name: "default", content: "v1" } }))).status
    ).toBe(200);

    const one = (await (await GET(req("?name=default"))).json()) as {
      content: string;
      by: string;
      updatedAt: string;
      bytes: number;
    };
    expect(one).toMatchObject({ content: "v1", by: "Dashboard", bytes: 2 });
    expect(one.updatedAt).toMatch(/^\d{4}-/);

    const hist = (await (await GET(req("?name=default&history=1"))).json()) as {
      history: { content: string; bytes: number; savedAt: string }[];
    };
    expect(hist.history.map((h) => h.content)).toEqual(["legacy profile"]);

    const restore = await POST(
      req("", { method: "POST", body: { action: "restore", name: "default", index: 0 } })
    );
    expect(restore.status).toBe(200);
    // Legacy key still holds the current content.
    expect(await getKVStore().get("mymcp:context:inline")).toBe("legacy profile");
    const after = (await (await GET(req("?name=default&history=1"))).json()) as {
      history: { content: string }[];
    };
    expect(after.history.map((h) => h.content)).toEqual(["v1", "legacy profile"]);
  });

  it("answers 404 for an unknown profile or version, 400 for a bad action", async () => {
    expect((await GET(req("?name=nope&history=1"))).status).toBe(404);
    await PUT(req("", { method: "PUT", body: { name: "work", content: "w" } }));
    const missing = await POST(
      req("", { method: "POST", body: { action: "restore", name: "work", index: 3 } })
    );
    expect(missing.status).toBe(404);
    const bad = await POST(req("", { method: "POST", body: { action: "explode", name: "work" } }));
    expect(bad.status).toBe(400);
  });

  it("keeps the existing list / get / delete contract", async () => {
    await PUT(req("", { method: "PUT", body: { name: "Work", content: "work hat" } }));
    const list = (await (await GET(req(""))).json()) as { profiles: { name: string }[] };
    expect(list.profiles.map((p) => p.name)).toEqual(["default", "work"]);
    const got = (await (await GET(req("?name=work"))).json()) as { name: string; content: string };
    expect(got).toMatchObject({ name: "work", content: "work hat" });
    expect((await DELETE(req("?name=work", { method: "DELETE" }))).status).toBe(200);
    expect((await DELETE(req("?name=default", { method: "DELETE" }))).status).toBe(400);
  });
});
