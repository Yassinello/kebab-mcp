/**
 * /api/config/update — release-sync mode at the route level (Kebab House
 * phase 2, UPD-01/04). The sync algorithm itself is covered in
 * tests/core/release-sync.test.ts; here we check mode selection and the
 * HTTP shapes the Overview banner consumes.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../helpers/fake-github";

vi.mock("@/core/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/core/pipeline")>("@/core/pipeline");
  return {
    ...actual,
    composeRequestPipeline: <H>(_steps: unknown[], handler: H) => handler,
  };
});
vi.mock("@/core/config-facade");
vi.mock("@/core/request-context");
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

const kvDelete = vi.fn().mockResolvedValue(undefined);
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
    kind: "filesystem" as const,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: kvDelete,
  }),
}));

import { getConfig } from "@/core/config-facade";
import { getCredential } from "@/core/request-context";

const UP = "Yassinello/kebab-mcp";
const ME = "me/kebab-house";
const pkg = (v: string) => JSON.stringify({ version: v });

let gh: FakeGitHub;

beforeEach(() => {
  vi.resetModules();
  kvDelete.mockClear();
  vi.mocked(getConfig).mockImplementation(
    (key: string) =>
      ({ VERCEL: "1", VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "kebab-house" })[key]
  );
  vi.mocked(getCredential).mockImplementation((key: string) =>
    key === "KEBAB_UPDATE_PAT" ? "ghp_test" : undefined
  );

  gh = new FakeGitHub();
  gh.addRepo(UP);
  gh.addRepo(ME); // fork: false — a Deploy Button clone
  const v1 = gh.commit(UP, { "package.json": pkg("1.0.0"), "a.ts": "1" }, "release 1.0.0");
  const v2 = gh.commit(UP, { "package.json": pkg("1.1.0"), "a.ts": "2" }, "release 1.1.0", v1);
  gh.setRef(UP, "tags/v1.0.0", v1);
  gh.setRef(UP, "tags/v1.1.0", v2);
  gh.setLatestRelease(UP, "v1.1.0");
  vi.stubGlobal("fetch", gh.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seedUser(files: Record<string, string>): string {
  const head = gh.commit(ME, files, "Initial commit");
  gh.setRef(ME, "heads/main", head);
  return head;
}

async function post(): Promise<{ status: number; body: Record<string, unknown> }> {
  const mod = await import("../../app/api/config/update/route");
  const res = await (mod.POST as unknown as () => Promise<Response>)();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/config/update — release-sync", () => {
  it("syncs a non-fork repo without calling merge-upstream", async () => {
    seedUser({ "package.json": pkg("1.0.0"), "a.ts": "1" });
    const { status, body } = await post();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      mode: "release-sync",
      fromVersion: "1.0.0",
      version: "1.1.0",
      pulled: 1,
      deployUrl: "https://vercel.com/me/kebab-house/deployments",
    });
    expect(body.files).toEqual({ added: [], modified: ["a.ts", "package.json"], removed: [] });
    expect(gh.calls.some((c) => c.path.includes("merge-upstream"))).toBe(false);
    expect(gh.getRef(ME, "heads/main")).toBe(body.commitSha);
    // The "update available" cache is dropped so the banner doesn't re-offer it.
    expect(kvDelete).toHaveBeenCalled();
  });

  it("returns 409 with the conflicting files and leaves the repo untouched", async () => {
    const head = seedUser({ "package.json": pkg("1.0.0"), "a.ts": "mine" });
    const { status, body } = await post();

    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, mode: "release-sync", reason: "conflict" });
    expect(body.conflicts).toEqual(["a.ts"]);
    expect(typeof body.message).toBe("string");
    expect(gh.getRef(ME, "heads/main")).toBe(head);
  });

  it("keeps merge-upstream for a real fork of upstream", async () => {
    gh.repos.get(ME)!.meta.fork = true;
    gh.repos.get(ME)!.meta.parent = { full_name: UP };
    seedUser({ "package.json": pkg("1.0.0") });
    gh.onRequest = (call) => {
      if (call.path.includes("/compare/Yassinello:kebab-mcp:main...main")) {
        return new Response(JSON.stringify({ ahead_by: 0, behind_by: 3, html_url: "u" }));
      }
      if (call.path.endsWith("/merge-upstream")) {
        return new Response(JSON.stringify({ merge_type: "fast-forward" }));
      }
    };
    const { body } = await post();
    expect(body).toMatchObject({ ok: true, pulled: 3, merge_type: "fast-forward" });
    expect(gh.calls.some((c) => c.path.endsWith("/git/commits") && c.method === "POST")).toBe(
      false
    );
  });
});

describe("GET /api/config/update — release-sync status", () => {
  it("reports the mode, installed and latest versions", async () => {
    seedUser({ "package.json": pkg("1.0.0"), "a.ts": "1" });
    const mod = await import("../../app/api/config/update/route");
    const ctx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(ctx);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "release-sync",
      available: true,
      status: "behind",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0",
      behind_by: 1,
    });
  });

  it("surfaces unknown-version with an explanation", async () => {
    seedUser({ "package.json": pkg("1.0.7") });
    const mod = await import("../../app/api/config/update/route");
    const ctx = { request: new Request("http://localhost/api/config/update") };
    const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)(ctx);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "release-sync",
      available: false,
      reason: "unknown-version",
      installedVersion: "1.0.7",
    });
    expect(body.message).toMatch(/does not match an upstream release/);
  });
});
