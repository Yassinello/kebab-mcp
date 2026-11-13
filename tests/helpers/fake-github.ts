/**
 * In-memory GitHub REST fake for release-sync tests (Kebab House phase 2,
 * UPD-01..05). Implements just the Git Data / repos endpoints the sync
 * uses, with real git blob SHAs so the integrity check is exercised.
 *
 * Install with `vi.stubGlobal("fetch", gh.fetch)`. Every call is recorded
 * in `gh.calls`; `gh.onRequest` lets a test inject failures or race
 * conditions (return a Response to short-circuit, or mutate state).
 */
import { createHash } from "node:crypto";

type Entry = { sha: string; mode: string };
type Commit = { tree: string; parents: string[]; message: string };

interface FakeRepo {
  meta: {
    private: boolean;
    fork: boolean;
    parent: { full_name: string } | null;
    default_branch: string;
  };
  blobs: Map<string, Buffer>;
  trees: Map<string, Map<string, Entry>>;
  commits: Map<string, Commit>;
  refs: Map<string, string>; // "heads/main" | "tags/v1.0.0" → sha
  tagObjects: Map<string, string>; // annotated tag sha → commit sha
  latestRelease: string | null;
}

export interface FakeCall {
  method: string;
  path: string;
  body?: unknown;
}

function blobSha(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest("hex");
}

function objSha(kind: string, payload: unknown): string {
  return createHash("sha1")
    .update(`${kind}:${JSON.stringify(payload)}`)
    .digest("hex");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class FakeGitHub {
  repos = new Map<string, FakeRepo>();
  calls: FakeCall[] = [];
  onRequest: ((call: FakeCall) => Response | void | Promise<Response | void>) | null = null;
  /** Mimic GitHub's 300-file cap on compare. */
  compareFileCap = 300;

  addRepo(fullName: string, meta: Partial<FakeRepo["meta"]> = {}): void {
    this.repos.set(fullName, {
      meta: { private: false, fork: false, parent: null, default_branch: "main", ...meta },
      blobs: new Map(),
      trees: new Map(),
      commits: new Map(),
      refs: new Map(),
      tagObjects: new Map(),
      latestRelease: null,
    });
  }

  private repo(name: string): FakeRepo {
    const r = this.repos.get(name);
    if (!r) throw new Error(`unknown repo ${name}`);
    return r;
  }

  private putTree(repo: FakeRepo, entries: Map<string, Entry>): string {
    const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sha = objSha("tree", sorted);
    repo.trees.set(sha, new Map(sorted));
    return sha;
  }

  /** Commit a full snapshot of files (path → content) on top of `parent`. */
  commit(
    repoName: string,
    files: Record<string, string | Buffer>,
    message: string,
    parent?: string,
    modes: Record<string, string> = {}
  ): string {
    const repo = this.repo(repoName);
    const entries = new Map<string, Entry>();
    for (const [path, content] of Object.entries(files)) {
      const buf = typeof content === "string" ? Buffer.from(content) : content;
      const sha = blobSha(buf);
      repo.blobs.set(sha, buf);
      entries.set(path, { sha, mode: modes[path] ?? "100644" });
    }
    const tree = this.putTree(repo, entries);
    const c: Commit = { tree, parents: parent ? [parent] : [], message };
    const sha = objSha("commit", { ...c, n: repo.commits.size });
    repo.commits.set(sha, c);
    return sha;
  }

  setRef(repoName: string, ref: string, sha: string): void {
    this.repo(repoName).refs.set(ref, sha);
  }

  getRef(repoName: string, ref: string): string | undefined {
    return this.repo(repoName).refs.get(ref);
  }

  /** Annotated tag: ref → tag object → commit. */
  setAnnotatedTag(repoName: string, tag: string, commit: string): void {
    const repo = this.repo(repoName);
    const tagSha = objSha("tag", { tag, commit });
    repo.tagObjects.set(tagSha, commit);
    repo.refs.set(`tags/${tag}`, `annotated:${tagSha}`);
  }

  setLatestRelease(repoName: string, tag: string): void {
    this.repo(repoName).latestRelease = tag;
  }

  /** Files of a commit as path → utf8 content. */
  files(repoName: string, commitSha: string): Record<string, string> {
    const repo = this.repo(repoName);
    const tree = repo.trees.get(repo.commits.get(commitSha)!.tree)!;
    const out: Record<string, string> = {};
    for (const [path, e] of tree) out[path] = repo.blobs.get(e.sha)!.toString("utf8");
    return out;
  }

  commitInfo(repoName: string, sha: string): Commit | undefined {
    return this.repo(repoName).commits.get(sha);
  }

  writes(): FakeCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  private isAncestor(repo: FakeRepo, ancestor: string, sha: string): boolean {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(repo.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: FakeCall = { method, path: url.pathname + url.search, ...(body ? { body } : {}) };
    this.calls.push(call);
    if (this.onRequest) {
      const injected = await this.onRequest(call);
      if (injected) return injected;
    }
    return this.route(method, url, body);
  };

  private route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return json({ message: "Not Found" }, 404);
    const repoName = m[1]!;
    const rest = m[2] ?? "";
    const repo = this.repos.get(repoName);
    if (!repo) return json({ message: "Not Found" }, 404);

    if (rest === "" && method === "GET") return json({ full_name: repoName, ...repo.meta });

    let mm: RegExpMatchArray | null;
    if (method === "GET" && (mm = rest.match(/^\/git\/ref\/(heads|tags)\/(.+)$/))) {
      const ref = repo.refs.get(`${mm[1]}/${decodeURIComponent(mm[2]!)}`);
      if (!ref) return json({ message: "Not Found" }, 404);
      if (ref.startsWith("annotated:")) {
        return json({ object: { type: "tag", sha: ref.slice("annotated:".length) } });
      }
      return json({ object: { type: "commit", sha: ref } });
    }
    if (method === "GET" && (mm = rest.match(/^\/git\/tags\/(\w+)$/))) {
      const commit = repo.tagObjects.get(mm[1]!);
      if (!commit) return json({ message: "Not Found" }, 404);
      return json({ object: { type: "commit", sha: commit } });
    }
    if (method === "GET" && (mm = rest.match(/^\/git\/commits\/(\w+)$/))) {
      const c = repo.commits.get(mm[1]!);
      if (!c) return json({ message: "Not Found" }, 404);
      return json({
        sha: mm[1],
        tree: { sha: c.tree },
        parents: c.parents.map((sha) => ({ sha })),
      });
    }
    if (method === "GET" && rest === "/contents/package.json") {
      const refName = url.searchParams.get("ref") ?? repo.meta.default_branch;
      const sha = repo.commits.has(refName) ? refName : repo.refs.get(`heads/${refName}`);
      const tree = sha ? repo.trees.get(repo.commits.get(sha)!.tree) : undefined;
      const entry = tree?.get("package.json");
      if (!entry) return json({ message: "Not Found" }, 404);
      return json({ encoding: "base64", content: repo.blobs.get(entry.sha)!.toString("base64") });
    }
    if (method === "GET" && rest === "/releases/latest") {
      if (!repo.latestRelease) return json({ message: "Not Found" }, 404);
      return json({
        tag_name: repo.latestRelease,
        html_url: `https://github.com/${repoName}/releases/tag/${repo.latestRelease}`,
      });
    }
    if (method === "GET" && (mm = rest.match(/^\/compare\/(\w+)\.\.\.(\w+)$/))) {
      return this.compare(repoName, repo, mm[1]!, mm[2]!);
    }
    if (method === "GET" && (mm = rest.match(/^\/git\/trees\/(\w+)$/))) {
      const tree = repo.trees.get(mm[1]!);
      if (!tree) return json({ message: "Not Found" }, 404);
      return json({
        sha: mm[1],
        truncated: false,
        tree: [...tree].map(([path, e]) => ({
          path,
          type: "blob",
          sha: e.sha,
          mode: e.mode,
          size: repo.blobs.get(e.sha)!.length,
        })),
      });
    }
    if (method === "GET" && (mm = rest.match(/^\/git\/blobs\/(\w+)$/))) {
      const blob = repo.blobs.get(mm[1]!);
      if (!blob) return json({ message: "Not Found" }, 404);
      // GitHub wraps base64 at 60 chars.
      const b64 = blob.toString("base64").replace(/(.{60})/g, "$1\n");
      return json({ sha: mm[1], encoding: "base64", content: b64, size: blob.length });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const buf = Buffer.from(
        String(body!.content),
        body!.encoding === "base64" ? "base64" : "utf8"
      );
      const sha = blobSha(buf);
      repo.blobs.set(sha, buf);
      return json({ sha }, 201);
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = body!.base_tree ? repo.trees.get(String(body!.base_tree)) : new Map();
      if (!base) return json({ message: "base_tree not found" }, 422);
      const next = new Map(base);
      for (const e of body!.tree as Array<{ path: string; mode: string; sha: string | null }>) {
        if (e.sha === null) {
          if (!next.has(e.path)) return json({ message: `path ${e.path} not in tree` }, 422);
          next.delete(e.path);
        } else {
          if (!repo.blobs.has(e.sha)) return json({ message: `blob ${e.sha} missing` }, 422);
          next.set(e.path, { sha: e.sha, mode: e.mode });
        }
      }
      return json({ sha: this.putTree(repo, next) }, 201);
    }
    if (method === "POST" && rest === "/git/commits") {
      const tree = String(body!.tree);
      if (!repo.trees.has(tree)) return json({ message: "tree missing" }, 422);
      const parents = body!.parents as string[];
      const c: Commit = { tree, parents, message: String(body!.message) };
      const sha = objSha("commit", { ...c, n: repo.commits.size });
      repo.commits.set(sha, c);
      return json({ sha, html_url: `https://github.com/${repoName}/commit/${sha}` }, 201);
    }
    if (method === "PATCH" && (mm = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const key = `heads/${decodeURIComponent(mm[1]!)}`;
      const current = repo.refs.get(key);
      const sha = String(body!.sha);
      if (!current) return json({ message: "Reference does not exist" }, 422);
      if (!body!.force && !this.isAncestor(repo, current, sha)) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      repo.refs.set(key, sha);
      return json({ ref: `refs/${key}`, object: { sha } });
    }
    return json({ message: `fake: unhandled ${method} ${rest}` }, 404);
  }

  private compare(repoName: string, repo: FakeRepo, a: string, b: string): Response {
    const ca = repo.commits.get(a);
    const cb = repo.commits.get(b);
    if (!ca || !cb) return json({ message: "Not Found" }, 404);
    // Commits reachable from b, stopping at a (linear histories in tests).
    const commits: string[] = [];
    let cur: string | undefined = b;
    while (cur && cur !== a) {
      commits.unshift(cur);
      cur = repo.commits.get(cur)?.parents[0];
    }
    const ta = repo.trees.get(ca.tree)!;
    const tb = repo.trees.get(cb.tree)!;
    const removed = [...ta.keys()].filter((p) => !tb.has(p));
    const added = [...tb.keys()].filter((p) => !ta.has(p));
    const files: Array<{ filename: string; status: string; previous_filename?: string }> = [];
    const renamedFrom = new Set<string>();
    for (const p of added) {
      const from = removed.find((r) => !renamedFrom.has(r) && ta.get(r)!.sha === tb.get(p)!.sha);
      if (from) {
        renamedFrom.add(from);
        files.push({ filename: p, status: "renamed", previous_filename: from });
      } else {
        files.push({ filename: p, status: "added" });
      }
    }
    for (const p of removed)
      if (!renamedFrom.has(p)) files.push({ filename: p, status: "removed" });
    for (const [p, e] of tb) {
      if (ta.has(p) && ta.get(p)!.sha !== e.sha) files.push({ filename: p, status: "modified" });
    }
    return json({
      status: "ahead",
      total_commits: commits.length,
      html_url: `https://github.com/${repoName}/compare/${a}...${b}`,
      commits: commits.map((sha) => ({
        sha,
        html_url: `https://github.com/${repoName}/commit/${sha}`,
        commit: { message: repo.commits.get(sha)!.message },
      })),
      files: files.slice(0, this.compareFileCap),
    });
  }
}
