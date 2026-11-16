/**
 * Release sync (Kebab House phase 2, UPD-01..05) against an in-memory
 * GitHub (tests/helpers/fake-github.ts).
 *
 * Scenario: upstream Yassinello/kebab-mcp has releases v1.0.0 and v1.1.0;
 * the user's repo me/kebab-house is a Deploy Button clone of v1.0.0 (same
 * files, unrelated history) plus files of their own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeGitHub } from "../helpers/fake-github";
import {
  applyReleaseSync,
  compareVersions,
  computeDeploymentUpdateStatus,
  detectSyncBase,
  planReleaseSync,
  releaseTagFor,
  resolveReleaseCommit,
  RELEASE_SYNC_MAX_FILES,
  type DeployedRepo,
} from "@/core/release-sync";

const UP = "Yassinello/kebab-mcp";
const ME = "me/kebab-house";
const REPO: DeployedRepo = {
  owner: "me",
  slug: "kebab-house",
  defaultBranch: "main",
  private: false,
};
const TOKEN = "ghp_test";

const pkg = (v: string) => JSON.stringify({ name: "kebab-mcp", version: v });

const V1: Record<string, string> = {
  "package.json": pkg("1.0.0"),
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 1;\n",
  "src/old-name.ts": "export const moved = true;\n",
  "src/same.ts": "unchanged\n",
  ".github/workflows/ci.yml": "on: push\n",
};
const V1_1: Record<string, string> = {
  "package.json": pkg("1.1.0"),
  "src/a.ts": "export const a = 2;\n", // modified
  // src/b.ts removed
  "src/new-name.ts": "export const moved = true;\n", // renamed from old-name
  "src/c.ts": "export const c = 1;\n", // added
  "src/same.ts": "unchanged\n",
  ".github/workflows/ci.yml": "on: [push, pull_request]\n", // never synced
};

let gh: FakeGitHub;
let upV1: string;
let upV11: string;
let upMid: string;

function seed(userFiles: Record<string, string> = { ...V1, "notes/mine.md": "my notes\n" }) {
  gh = new FakeGitHub();
  gh.addRepo(UP);
  gh.addRepo(ME);
  upV1 = gh.commit(UP, V1, "chore(main): release 1.0.0");
  const mid = gh.commit(UP, { ...V1, "src/a.ts": "export const a = 1.5;\n" }, "feat: wip", upV1);
  upMid = mid;
  upV11 = gh.commit(UP, V1_1, "chore(main): release 1.1.0", mid);
  gh.setRef(UP, "heads/main", upV11);
  gh.setRef(UP, "tags/v1.0.0", upV1);
  gh.setRef(UP, "tags/v1.1.0", upV11);
  gh.setLatestRelease(UP, "v1.1.0");
  const userHead = gh.commit(ME, userFiles, "Initial commit");
  gh.setRef(ME, "heads/main", userHead);
  vi.stubGlobal("fetch", gh.fetch);
  return userHead;
}

beforeEach(() => {
  seed();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("version helpers (UPD-02)", () => {
  it("maps a version to its release-please tag", () => {
    expect(releaseTagFor("0.1.16")).toBe("v0.1.16");
    expect(releaseTagFor("v0.1.16")).toBe("v0.1.16");
  });

  it("compares versions numerically, not lexically", () => {
    expect(compareVersions("0.1.16", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.16", "0.1.16")).toBe(0);
    expect(compareVersions("v0.2.0", "0.10.0")).toBe(-1);
  });

  it("resolves version → tag → commit, lightweight and annotated", async () => {
    const light = await resolveReleaseCommit(TOKEN, "v1.0.0");
    expect(light?.commitSha).toBe(upV1);
    gh.setAnnotatedTag(UP, "v1.1.0", upV11);
    const annotated = await resolveReleaseCommit(TOKEN, "v1.1.0");
    expect(annotated?.commitSha).toBe(upV11);
    expect(annotated?.treeSha).toBe(gh.commitInfo(UP, upV11)!.tree);
    expect(await resolveReleaseCommit(TOKEN, "v9.9.9")).toBeNull();
  });
});

describe("applyReleaseSync (UPD-01)", () => {
  it("applies add / modify / remove / rename in one commit on top of the user's HEAD", async () => {
    const head = gh.getRef(ME, "heads/main")!;
    const res = await applyReleaseSync(TOKEN, REPO);

    expect(res.ok).toBe(true);
    if (!res.ok || res.upToDate) throw new Error("expected a sync");
    expect(res.fromVersion).toBe("1.0.0");
    expect(res.toVersion).toBe("1.1.0");
    expect(res.pulled).toBe(2);
    expect(res.added.sort()).toEqual(["src/c.ts", "src/new-name.ts"]);
    expect(res.modified.sort()).toEqual(["package.json", "src/a.ts"]);
    expect(res.removed.sort()).toEqual(["src/b.ts", "src/old-name.ts"]);
    expect(res.skipped).toEqual([".github/workflows/ci.yml"]);

    const newHead = gh.getRef(ME, "heads/main")!;
    expect(newHead).toBe(res.commitSha);
    const info = gh.commitInfo(ME, newHead)!;
    expect(info.parents).toEqual([head]);
    expect(info.message.split("\n")[0]).toBe("chore: sync Kebab House v1.1.0");

    const {
      ".github/workflows/ci.yml": userCi,
      "notes/mine.md": mine,
      ...synced
    } = gh.files(ME, newHead);
    const { ".github/workflows/ci.yml": _upCi, ...upstream } = V1_1;
    expect(synced).toEqual(upstream);
    expect(mine).toBe("my notes\n"); // user's own file untouched
    expect(userCi).toBe(V1[".github/workflows/ci.yml"]); // workflows never written
  });

  it("is a no-op when the installed version is already the latest release", async () => {
    seed({ ...V1_1 });
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res).toEqual({ ok: true, upToDate: true, version: "1.1.0" });
    expect(gh.writes()).toHaveLength(0);
  });

  it("skips files the user already has at the target content (clone of unreleased main)", async () => {
    seed({ ...V1, "src/c.ts": V1_1["src/c.ts"]! });
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok).toBe(true);
    if (!res.ok || res.upToDate) throw new Error("expected a sync");
    expect(res.added).toEqual(["src/new-name.ts"]);
  });
});

describe("conflicts (UPD-03)", () => {
  it("aborts before any write when a file to update was modified by the user", async () => {
    const head = seed({ ...V1, "src/a.ts": "export const a = 42; // mine\n" });
    const res = await applyReleaseSync(TOKEN, REPO);

    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "conflict") throw new Error("expected a conflict");
    expect(res.conflicts).toEqual(["src/a.ts"]);
    expect(res.message).toMatch(/nothing was written/i);
    expect(res.manualUrl).toContain("/compare/v1.0.0...v1.1.0");
    expect(gh.writes()).toHaveLength(0); // no blob, tree, commit or ref call
    expect(gh.getRef(ME, "heads/main")).toBe(head);
  });

  it("treats a file deleted by the user but changed upstream as a conflict", async () => {
    const { "src/a.ts": _a, ...withoutA } = V1;
    seed(withoutA);
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason === "conflict" && res.conflicts).toEqual(["src/a.ts"]);
    expect(gh.writes()).toHaveLength(0);
  });
});

describe("safety (UPD-05)", () => {
  it("aborts without moving the branch when HEAD moved during the sync", async () => {
    const head = gh.getRef(ME, "heads/main")!;
    let pushed = "";
    gh.onRequest = (call) => {
      if (call.method === "POST" && call.path.endsWith("/git/commits") && !pushed) {
        // Someone pushes to main while the sync is building its commit.
        pushed = gh.commit(ME, { ...V1, "late.md": "x" }, "concurrent push", head);
        gh.setRef(ME, "heads/main", pushed);
      }
    };
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason).toBe("head-moved");
    expect(gh.getRef(ME, "heads/main")).toBe(pushed);
    expect(gh.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("maps GitHub's non-fast-forward refusal to head-moved (race after the re-check)", async () => {
    const head = gh.getRef(ME, "heads/main")!;
    gh.onRequest = (call) => {
      if (call.method === "PATCH") {
        gh.setRef(ME, "heads/main", gh.commit(ME, { ...V1 }, "race", head));
      }
    };
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason).toBe("head-moved");
    expect(gh.getRef(ME, "heads/main")).not.toBe(head);
    expect(gh.commitInfo(ME, gh.getRef(ME, "heads/main")!)!.message).toBe("race");
  });

  it("fails mid-way without any visible effect (ref never updated)", async () => {
    const head = gh.getRef(ME, "heads/main")!;
    let blobs = 0;
    gh.onRequest = (call) => {
      if (call.method === "POST" && call.path.endsWith("/git/blobs") && ++blobs === 2) {
        return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      }
    };
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "github-error") throw new Error("expected github-error");
    expect(res.step).toBe("create-blob");
    expect(res.status).toBe(500);
    expect(gh.getRef(ME, "heads/main")).toBe(head);
    expect(gh.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(gh.calls.some((c) => c.path.endsWith("/git/trees") && c.method === "POST")).toBe(false);
  });

  it("reports missing write permission as an auth error with guidance", async () => {
    gh.onRequest = (call) => {
      if (call.method === "POST") {
        return new Response(JSON.stringify({ message: "Resource not accessible" }), {
          status: 403,
        });
      }
    };
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason).toBe("auth");
    expect(res.ok === false && res.message).toMatch(/Contents: read & write/);
  });

  it("refuses syncs above the file limit before writing anything", async () => {
    const many: Record<string, string> = { ...V1_1 };
    for (let i = 0; i <= RELEASE_SYNC_MAX_FILES; i++)
      many[`gen/f${i}.ts`] = `export const n = ${i};\n`;
    gh.commit(UP, many, "chore(main): release 1.2.0", upV11);
    const v12 = [...gh.repos.get(UP)!.commits.keys()].at(-1)!;
    gh.setRef(UP, "tags/v1.2.0", v12);
    gh.setLatestRelease(UP, "v1.2.0");

    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "too-large") throw new Error("expected too-large");
    // compare is capped at 300 files: the tree diff fallback must see them all.
    expect(res.files).toBeGreaterThan(RELEASE_SYNC_MAX_FILES);
    expect(res.manualUrl).toContain("/compare/v1.0.0...v1.2.0");
    expect(gh.writes()).toHaveLength(0);
  });

  it("refuses syncs above the size limit before writing anything", async () => {
    gh.commit(
      UP,
      { ...V1_1, "public/huge.bin": Buffer.alloc(21 * 1024 * 1024, 1).toString("latin1") },
      "chore(main): release 1.2.0",
      upV11
    );
    const v12 = [...gh.repos.get(UP)!.commits.keys()].at(-1)!;
    gh.setRef(UP, "tags/v1.2.0", v12);
    gh.setLatestRelease(UP, "v1.2.0");

    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason).toBe("too-large");
    expect(res.ok === false && res.message).toMatch(/20 MB/);
    expect(gh.writes()).toHaveLength(0);
  });

  it("stops when the installed version has no upstream tag", async () => {
    seed({ ...V1, "package.json": pkg("1.0.5") });
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason).toBe("unknown-version");
    expect(gh.writes()).toHaveLength(0);
  });
});

describe("planReleaseSync (pure)", () => {
  const e = (sha: string) => ({ sha, mode: "100644", size: 1 });
  it("classifies each path by comparing user / installed / target blobs", () => {
    const base = new Map([
      ["x", e("1")],
      ["y", e("1")],
      ["z", e("1")],
    ]);
    const target = new Map([
      ["x", e("2")],
      ["y", e("2")],
      ["w", e("3")],
    ]);
    const user = new Map([
      ["x", e("1")],
      ["y", e("9")],
      ["z", e("1")],
    ]);
    const plan = planReleaseSync(["x", "y", "z", "w"], base, target, user);
    expect(plan.writes.map((w) => [w.path, w.kind])).toEqual([
      ["w", "added"],
      ["x", "modified"],
    ]);
    expect(plan.removals.map((r) => r.path)).toEqual(["z"]);
    expect(plan.conflicts).toEqual(["y"]);
  });
});

describe("mode selection (UPD-04)", () => {
  it("a real fork of upstream keeps the merge-upstream status (github-api)", async () => {
    gh.repos.get(ME)!.meta = {
      private: false,
      fork: true,
      parent: { full_name: UP },
      default_branch: "main",
    };
    gh.onRequest = (call) => {
      if (call.path.includes("/compare/Yassinello:kebab-mcp:main...main")) {
        return new Response(
          JSON.stringify({
            status: "identical",
            ahead_by: 0,
            behind_by: 0,
            total_commits: 0,
            commits: [],
            html_url: "u",
          })
        );
      }
    };
    const res = await computeDeploymentUpdateStatus(TOKEN, "me", "kebab-house");
    expect(res.ok && res.payload.mode).toBe("github-api");
  });

  it("a non-fork repo gets release-sync status with versions and commits", async () => {
    const res = await computeDeploymentUpdateStatus(TOKEN, "me", "kebab-house");
    expect(res.ok).toBe(true);
    if (!res.ok || res.payload.mode !== "release-sync") throw new Error("expected release-sync");
    expect(res.payload).toMatchObject({
      available: true,
      status: "behind",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0",
      behind_by: 2,
      deployedRepo: ME,
    });
    expect(res.payload.commits[0]!.message).toBe("chore(main): release 1.1.0");
    expect(gh.writes()).toHaveLength(0);
  });

  it("reports unknown-version when package.json matches no upstream tag", async () => {
    seed({ ...V1, "package.json": pkg("1.0.5") });
    const res = await computeDeploymentUpdateStatus(TOKEN, "me", "kebab-house");
    expect(res.ok === false && res.kind).toBe("unknown-version");
  });
});

describe("sync base detection (D3, 2026-11 audit)", () => {
  /** Upstream files of the commit between v1.0.0 and v1.1.0 (package.json still says 1.0.0). */
  const MID = { ...V1, "src/a.ts": "export const a = 1.5;\n" };

  it("clone of main after a tag: base is the cloned commit, not the tag, so no false conflict", async () => {
    // The Deploy Button cloned main at `mid`: past v1.0.0, still declaring 1.0.0.
    seed({ ...MID });
    const base = await detectSyncBase(TOKEN, ME, "main", "1.0.0");
    expect(base).toMatchObject({ source: "root-tree", commitSha: upMid });

    const status = await computeDeploymentUpdateStatus(TOKEN, "me", "kebab-house");
    expect(status.ok && status.payload).toMatchObject({ available: true, behind_by: 1 });

    const res = await applyReleaseSync(TOKEN, REPO);
    if (!res.ok || res.upToDate) throw new Error(`expected a sync, got ${JSON.stringify(res)}`);
    // src/a.ts differs from v1.0.0 but is untouched since the clone: updated, not a conflict.
    expect(res.modified).toContain("src/a.ts");
    expect(gh.files(ME, res.commitSha)["src/a.ts"]).toBe(V1_1["src/a.ts"]);
    expect(gh.commitInfo(ME, res.commitSha)!.message).toContain(`Kebab-Upstream-Commit: ${upV11}`);
  });

  it("the same clone with the tag-only fallback reports the false conflict (scenario guard)", async () => {
    seed({ ...MID });
    gh.onRequest = (call) =>
      call.path.includes("/commits?")
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : undefined;
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok === false && res.reason === "conflict" && res.conflicts).toEqual(["src/a.ts"]);
  });

  it("a clone newer than the latest release is up to date, never downgraded", async () => {
    // main moved past v1.1.0; the clone's package.json lags behind (1.0.0).
    const post = { ...V1_1, "package.json": pkg("1.0.0"), "src/d.ts": "export const d = 1;\n" };
    seed({ ...post });
    gh.setRef(UP, "heads/main", gh.commit(UP, post, "feat: after the release", upV11));

    const status = await computeDeploymentUpdateStatus(TOKEN, "me", "kebab-house");
    expect(status.ok && status.payload).toMatchObject({ available: false, status: "identical" });

    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res).toEqual({ ok: true, upToDate: true, version: "1.0.0" });
    expect(gh.writes()).toHaveLength(0);
  });

  it("clone at a tag: the root tree matches the release commit", async () => {
    seed({ ...V1 });
    expect(await detectSyncBase(TOKEN, ME, "main", "1.0.0")).toMatchObject({
      source: "root-tree",
      commitSha: upV1,
    });
    const res = await applyReleaseSync(TOKEN, REPO);
    expect(res.ok && !res.upToDate).toBe(true);
  });

  it("previously synced: the trailer of the last sync is the base, not the root commit", async () => {
    seed({ ...V1 });
    const first = await applyReleaseSync(TOKEN, REPO);
    if (!first.ok || first.upToDate) throw new Error("expected a first sync");

    // Upstream ships v1.2.0, changing src/a.ts again.
    const V1_2 = { ...V1_1, "package.json": pkg("1.2.0"), "src/a.ts": "export const a = 3;\n" };
    const upV12 = gh.commit(UP, V1_2, "chore(main): release 1.2.0", upV11);
    gh.setRef(UP, "heads/main", upV12);
    gh.setRef(UP, "tags/v1.2.0", upV12);
    gh.setLatestRelease(UP, "v1.2.0");

    expect(await detectSyncBase(TOKEN, ME, "main", "1.1.0")).toMatchObject({
      source: "trailer",
      commitSha: upV11,
    });
    const second = await applyReleaseSync(TOKEN, REPO);
    if (!second.ok || second.upToDate)
      throw new Error(`expected a sync: ${JSON.stringify(second)}`);
    expect(second.fromVersion).toBe("1.1.0");
    expect(second.modified.sort()).toEqual(["package.json", "src/a.ts"]);
  });

  it("a legacy sync commit without trailer means its release tag", async () => {
    const files = { ...V1_1, "notes/mine.md": "x\n" };
    const head = seed(files);
    gh.setRef(
      ME,
      "heads/main",
      gh.commit(ME, files, "chore: sync Kebab House v1.1.0\n\nbody", head)
    );
    expect(await detectSyncBase(TOKEN, ME, "main", "0.0.1")).toMatchObject({
      source: "tag",
      commitSha: upV11,
      label: "v1.1.0",
    });
  });
});
