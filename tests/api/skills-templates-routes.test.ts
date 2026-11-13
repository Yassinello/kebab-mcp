/**
 * Kebab House phase 0 — routes for the ritual templates (RIT-02) and the
 * master relay (RLY-01/02):
 *   - GET/POST /api/welcome/starter-skills (same contract, templates inside)
 *   - GET/POST /api/config/skills/templates (dashboard)
 *   - GET /api/config/skills/relay-master[?tag=]
 *
 * Admin auth is bypassed (covered elsewhere); the welcome route keeps its
 * own auth check, exercised once with a refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { strFromU8, unzipSync } from "fflate";

const authState = { allow: true };
vi.mock("@/core/auth", async (orig) => ({
  ...(await orig<typeof import("@/core/auth")>()),
  checkAdminAuth: async () =>
    authState.allow ? null : new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/core/first-run", async (orig) => ({
  ...(await orig<typeof import("@/core/first-run")>()),
  isClaimer: async () => false,
}));
vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

import { resetKVStoreCache } from "@/core/kv-store";
import { createSkill, listSkills, _resetSkillsCacheForTests } from "@/connectors/skills/store";
import { parseSkillMd } from "@/connectors/skills/lib/bundle";
import * as welcome from "../../app/api/welcome/starter-skills/route";
import * as templates from "../../app/api/config/skills/templates/route";
import * as relay from "../../app/api/config/skills/relay-master/route";

type AdminHandler = (ctx: { request: Request }) => Promise<Response>;
const EXPECTED = ["remember", "morning-brief", "meeting-prep", "weekly-review", "read-later"];

let tmpDir = "";
beforeEach(async () => {
  authState.allow = true;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-templates-routes-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("MYMCP_SKILLS_PATH", "");
  vi.stubEnv("KEBAB_SKILLS_PATH", "");
  resetKVStoreCache();
  _resetSkillsCacheForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  _resetSkillsCacheForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/welcome/starter-skills", () => {
  it("GET lists the 5 templates with the historical fields", async () => {
    const res = await welcome.GET(new Request("http://localhost/api/welcome/starter-skills"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skills: Record<string, unknown>[] };
    expect(data.skills.map((s) => s.id)).toEqual(EXPECTED);
    for (const s of data.skills) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(typeof s.icon).toBe("string");
      expect(s.installed).toBe(false);
    }
  });

  it("POST { id } installs once, then reports unchanged (idempotent)", async () => {
    const url = "http://localhost/api/welcome/starter-skills";
    const first = await welcome.POST(post(url, { id: "morning-brief" }));
    expect(await first.json()).toEqual({
      ok: true,
      id: "morning_brief",
      name: "morning-brief",
      action: "created",
    });
    const second = await welcome.POST(post(url, { id: "morning-brief" }));
    expect(await second.json()).toMatchObject({ ok: true, action: "unchanged" });
    expect((await listSkills()).map((s) => s.id)).toEqual(["morning_brief"]);

    const list = (await (await welcome.GET(new Request(url))).json()) as {
      skills: { id: string; installed: boolean }[];
    };
    expect(list.skills.find((s) => s.id === "morning-brief")!.installed).toBe(true);
  });

  it("POST with an unknown id (e.g. a removed starter) → 404", async () => {
    const res = await welcome.POST(
      post("http://localhost/api/welcome/starter-skills", { id: "summarize-article" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("refuses unauthenticated callers", async () => {
    authState.allow = false;
    const res = await welcome.GET(new Request("http://localhost/api/welcome/starter-skills"));
    expect(res.status).toBe(401);
  });
});

describe("/api/config/skills/templates", () => {
  const GET = templates.GET as unknown as AdminHandler;
  const POST = templates.POST as unknown as AdminHandler;
  const url = "http://localhost/api/config/skills/templates";

  it("GET returns the catalogue with status", async () => {
    const data = (await (await GET({ request: new Request(url) })).json()) as {
      ok: boolean;
      templates: { id: string; status: string; tags: string[] }[];
    };
    expect(data.ok).toBe(true);
    expect(data.templates.map((t) => t.id)).toEqual(EXPECTED);
    expect(data.templates.every((t) => t.status === "available")).toBe(true);
    expect(data.templates.every((t) => t.tags.includes("rituals"))).toBe(true);
  });

  it("POST installs, and a second POST does not duplicate", async () => {
    const a = await POST({ request: post(url, { id: "weekly-review" }) });
    expect(await a.json()).toMatchObject({ ok: true, id: "weekly_review", action: "created" });
    const b = await POST({ request: post(url, { id: "weekly-review" }) });
    expect(await b.json()).toMatchObject({ ok: true, action: "unchanged" });
    expect((await listSkills()).filter((s) => s.id.startsWith("weekly_review"))).toHaveLength(1);
  });

  it("POST validates the body", async () => {
    expect((await POST({ request: post(url, {}) })).status).toBe(400);
    expect((await POST({ request: post(url, { id: "nope" }) })).status).toBe(404);
    const bad = new Request(url, { method: "POST", body: "{" });
    expect((await POST({ request: bad })).status).toBe(400);
  });
});

describe("/api/config/skills/relay-master", () => {
  const GET = relay.GET as unknown as AdminHandler;

  async function relayMd(res: Response): Promise<string> {
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["kebab-house/SKILL.md"]);
    return strFromU8(files["kebab-house/SKILL.md"]!);
  }

  it("returns the master relay zip for the whole library", async () => {
    await createSkill({ name: "alpha", source: { type: "inline" }, tags: ["perso"] });
    await createSkill({ name: "beta", source: { type: "inline" }, tags: ["work"] });
    const res = await GET({
      request: new Request("http://localhost/api/config/skills/relay-master"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain('filename="kebab-house.zip"');
    expect(res.headers.get("X-Kebab-Skill-Count")).toBe("2");
    const parsed = parseSkillMd(await relayMd(res));
    expect(parsed.name).toBe("kebab-house");
    expect(parsed.description.length).toBeLessThanOrEqual(1024);
    expect(parsed.description).toContain("Skills: alpha, beta.");
  });

  it("?tag= filters the listed skills and names the file after the tag", async () => {
    await createSkill({ name: "alpha", source: { type: "inline" }, tags: ["perso"] });
    await createSkill({ name: "beta", source: { type: "inline" }, tags: ["work"] });
    const res = await GET({
      request: new Request("http://localhost/api/config/skills/relay-master?tag=Perso"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain('filename="kebab-house-perso.zip"');
    expect(res.headers.get("X-Kebab-Skill-Count")).toBe("1");
    const parsed = parseSkillMd(await relayMd(res));
    expect(parsed.description).toContain("Skills: alpha.");
    expect(parsed.description).not.toContain("beta");
  });

  it("rejects a tag that normalizes to nothing", async () => {
    const res = await GET({
      request: new Request("http://localhost/api/config/skills/relay-master?tag=%23%23"),
    });
    expect(res.status).toBe(400);
  });
});
