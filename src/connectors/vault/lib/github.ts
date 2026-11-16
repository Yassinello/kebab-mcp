import { VaultNotFoundError, VaultAuthError } from "@/core/connector-errors";
import { fetchWithTimeout } from "@/core/fetch-utils";
import { getConfig as readConfig } from "@/core/config-facade";
import { noteProvenance } from "./provenance";
import { validateVaultPath, validateVaultWritePath } from "./paths";
import {
  bestSnippet,
  queryTerms,
  scoreNote,
  searchable,
  termMatches,
  type Searchable,
} from "./search-rank";
import type { RecentNote, SearchResult, TreeFile, VaultFile, VaultListEntry } from "./backend";

const GITHUB_API = "https://api.github.com";
// Phase 44 SCM-05b: 10s default preserved from prior local helper.
const FETCH_TIMEOUT = 10_000;

function getConfig() {
  const pat = readConfig("GITHUB_PAT");
  const repo = readConfig("GITHUB_REPO");
  if (!pat || !repo) {
    throw new Error("Missing GITHUB_PAT or GITHUB_REPO env vars");
  }
  return { pat, repo };
}

function headers(pat: string): HeadersInit {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
}

// --- Types ---

interface GitHubContentResponse {
  path: string;
  name: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
  type: string;
}

interface GitHubDirectoryEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
}

interface GitHubSearchResponse {
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    text_matches?: Array<{ fragment: string }>;
  }>;
}

interface _GitHubRepoResponse {
  id: number;
  full_name: string;
  private: boolean;
}

// --- Path validation (VLT-05: shared with the KV backend) ---

export { validateVaultPath, validateVaultWritePath };

/**
 * SEC-14: strip GitHub search qualifiers (`repo:`, `org:`, `user:`, …) from
 * free-text queries so a query cannot widen the search beyond the vault
 * repository (GitHub ORs multiple `repo:` qualifiers).
 */
export function sanitizeSearchQuery(query: string): string {
  return query
    .replace(
      /(^|\s)-?(repo|org|user|owner|path|in|is|fork|language|extension|filename|size):\S*/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

// --- Read ---

export async function vaultRead(path: string): Promise<VaultFile> {
  validateVaultPath(path);
  const { pat, repo } = getConfig();
  const res = await fetchWithTimeout(
    `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(path)}`,
    { headers: headers(pat) },
    FETCH_TIMEOUT
  );

  if (!res.ok) {
    if (res.status === 404) throw new VaultNotFoundError(path);
    if (res.status === 401 || res.status === 403)
      throw new VaultAuthError(`GitHub API ${res.status} for ${path}`);
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data = (await res.json()) as GitHubContentResponse;
  const content = Buffer.from(data.content, "base64").toString("utf-8");

  return { path: data.path, name: data.name, sha: data.sha, content, size: data.size };
}

// --- Write (create or update) ---

export async function vaultWrite(
  path: string,
  content: string,
  message?: string,
  knownSha?: string
): Promise<{ path: string; sha: string; created: boolean }> {
  validateVaultWritePath(path);
  const { pat, repo } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(path)}`;

  // Use known SHA if provided, otherwise fetch
  let existingSha = knownSha;
  if (!existingSha) {
    const getRes = await fetchWithTimeout(url, { headers: headers(pat) }, FETCH_TIMEOUT);
    if (getRes.ok) {
      const existing = (await getRes.json()) as GitHubContentResponse;
      existingSha = existing.sha;
    } else if (getRes.status !== 404) {
      throw new Error(`GitHub API error: ${getRes.status}`);
    }
  }

  const body: Record<string, string> = {
    message: message || "Update via Kebab MCP",
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const putRes = await fetchWithTimeout(
    url,
    {
      method: "PUT",
      headers: headers(pat),
      body: JSON.stringify(body),
    },
    FETCH_TIMEOUT
  );

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub PUT error: ${putRes.status} — ${err}`);
  }

  const result = await putRes.json();
  return {
    path: result.content.path,
    sha: result.content.sha,
    created: !existingSha,
  };
}

// --- Delete ---

export async function vaultDelete(
  path: string,
  message?: string,
  knownSha?: string
): Promise<{ path: string }> {
  validateVaultWritePath(path);
  const { pat, repo } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(path)}`;

  // Use known SHA if provided, otherwise fetch
  let sha = knownSha;
  if (!sha) {
    const getRes = await fetchWithTimeout(url, { headers: headers(pat) }, FETCH_TIMEOUT);
    if (!getRes.ok) {
      if (getRes.status === 404) throw new VaultNotFoundError(path);
      if (getRes.status === 401 || getRes.status === 403)
        throw new VaultAuthError(`GitHub API ${getRes.status} for ${path}`);
      throw new Error(`GitHub API error: ${getRes.status}`);
    }
    const existing = (await getRes.json()) as GitHubContentResponse;
    sha = existing.sha;
  }

  const delRes = await fetchWithTimeout(
    url,
    {
      method: "DELETE",
      headers: headers(pat),
      body: JSON.stringify({
        message: message || `Delete ${path} via Kebab MCP`,
        sha,
      }),
    },
    FETCH_TIMEOUT
  );

  if (!delRes.ok) {
    const err = await delRes.text();
    throw new Error(`GitHub DELETE error: ${delRes.status} — ${err}`);
  }

  return { path };
}

// --- List directory ---

export async function vaultList(folder?: string): Promise<VaultListEntry[]> {
  if (folder) validateVaultPath(folder);
  const { pat, repo } = getConfig();
  const pathSegment = folder ? `/${encodeURIPath(folder)}` : "";
  const res = await fetchWithTimeout(
    `${GITHUB_API}/repos/${repo}/contents${pathSegment}`,
    { headers: headers(pat) },
    FETCH_TIMEOUT
  );

  if (!res.ok) {
    if (res.status === 404) throw new VaultNotFoundError(folder || "/");
    if (res.status === 401 || res.status === 403)
      throw new VaultAuthError(`GitHub API ${res.status} for ${folder || "/"}`);
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data = (await res.json()) as GitHubDirectoryEntry[];
  if (!Array.isArray(data)) {
    throw new Error(`Path is a file, not a directory: ${folder}`);
  }

  return data.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type === "dir" ? ("dir" as const) : ("file" as const),
    size: item.size || 0,
  }));
}

// --- Search ---

interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

interface GitTreeResponse {
  sha: string;
  tree: GitTreeEntry[];
  truncated: boolean;
}

export async function vaultSearch(
  query: string,
  folder?: string,
  limit = 10,
  page = 1
): Promise<{ results: SearchResult[]; totalCount: number; method: "github_search" | "tree_grep" }> {
  if (folder) validateVaultPath(folder);

  // Try GitHub Code Search first
  const codeSearchResult = await tryCodeSearch(query, folder, limit, page);
  if (codeSearchResult.totalCount > 0) {
    return { ...codeSearchResult, method: "github_search" };
  }

  // Fallback: Git Trees + content grep (for small/unindexed repos)
  return { ...(await treeGrep(query, folder, limit, page)), method: "tree_grep" };
}

async function tryCodeSearch(
  query: string,
  folder: string | undefined,
  limit: number,
  page: number
): Promise<{ results: SearchResult[]; totalCount: number }> {
  const { pat, repo } = getConfig();

  const cleanQuery = sanitizeSearchQuery(query);
  if (!cleanQuery) throw new Error("Search query is empty after removing GitHub qualifiers");
  let q = `${cleanQuery} repo:${repo}`;
  if (folder) q += ` path:${folder}`;

  const res = await fetchWithTimeout(
    `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${limit}&page=${page}`,
    {
      headers: {
        ...headers(pat),
        Accept: "application/vnd.github.text-match+json",
      },
    },
    FETCH_TIMEOUT
  );

  if (!res.ok) return { results: [], totalCount: 0 };

  const data = (await res.json()) as GitHubSearchResponse;
  return {
    totalCount: data.total_count,
    results: (data.items || []).map((item) => ({
      name: item.name,
      path: item.path,
      textMatches: (item.text_matches || []).map((m) => m.fragment),
    })),
  };
}

async function treeGrep(
  query: string,
  folder: string | undefined,
  limit: number,
  page: number
): Promise<{ results: SearchResult[]; totalCount: number }> {
  const { pat, repo } = getConfig();

  // Get full file tree
  const treeRes = await fetchWithTimeout(
    `${GITHUB_API}/repos/${repo}/git/trees/${readConfig("GITHUB_BRANCH") || "main"}?recursive=1`,
    { headers: headers(pat) },
    FETCH_TIMEOUT
  );

  if (!treeRes.ok) throw new Error(`GitHub Trees error: ${treeRes.status}`);

  const tree = (await treeRes.json()) as GitTreeResponse;

  // Filter to markdown files in target folder
  let mdFiles = tree.tree.filter((t) => t.type === "blob" && t.path.endsWith(".md"));
  if (folder) {
    const prefix = folder.replace(/\/$/, "");
    mdFiles = mdFiles.filter((t) => t.path.startsWith(prefix + "/") || t.path === prefix);
  }

  // B3 (2026-11 audit): ranked like the KV backend — stopwords dropped,
  // accent-insensitive, light stemming; a file needs one matching term, and
  // files matching more terms (in the name: double) come first.
  const terms = queryTerms(query);
  if (terms.length === 0) return { totalCount: 0, results: [] };

  interface Hit {
    result: SearchResult;
    score: number;
  }
  const hits: Hit[] = [];
  const contentCandidates: Array<{ file: GitTreeEntry; name: Searchable; nameScore: number }> = [];

  // First pass: file names. A name holding every term needs no content read.
  for (const file of mdFiles) {
    const name = searchable(file.path.replace(/\.md$/, ""));
    const s = scoreNote(terms, name, null);
    if (s.matched.length === terms.length) {
      hits.push({
        score: s.score,
        result: {
          name: file.path.split("/").pop() || file.path,
          path: file.path,
          textMatches: [`Filename match`],
        },
      });
    } else {
      contentCandidates.push({ file, name, nameScore: s.score });
    }
  }

  // Second pass: read content of remaining files to search inside
  // Limit concurrent reads to avoid rate limiting
  const MAX_CONTENT_READS = 20;
  const toRead = contentCandidates.slice(0, MAX_CONTENT_READS);

  const readResults = await Promise.all(
    toRead.map(async ({ file, name, nameScore }): Promise<Hit | null> => {
      const fileName = file.path.split("/").pop() || file.path;
      const nameOnly = (): Hit | null =>
        nameScore > 0
          ? {
              score: nameScore,
              result: { name: fileName, path: file.path, textMatches: [`Filename match`] },
            }
          : null;
      try {
        const res = await fetchWithTimeout(
          `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(file.path)}`,
          { headers: headers(pat) },
          FETCH_TIMEOUT
        );
        if (!res.ok) return nameOnly();

        const data = (await res.json()) as GitHubContentResponse;
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        const body = searchable(content);
        const s = scoreNote(terms, name, body);
        if (s.score === 0) return null;
        const inContent = s.matched.filter((q) => termMatches(body, q));
        return {
          score: s.score,
          result: {
            name: fileName,
            path: file.path,
            textMatches: [inContent.length ? bestSnippet(content, inContent) : `Filename match`],
            provenance: noteProvenance(content),
          },
        };
      } catch {
        return nameOnly();
      }
    })
  );
  for (const r of readResults) if (r) hits.push(r);
  // Files not read (beyond the cap) still count through their name.
  for (const c of contentCandidates.slice(MAX_CONTENT_READS)) {
    if (c.nameScore > 0) {
      hits.push({
        score: c.nameScore,
        result: {
          name: c.file.path.split("/").pop() || c.file.path,
          path: c.file.path,
          textMatches: [`Filename match`],
        },
      });
    }
  }

  // Stable sort: equal scores keep the tree order.
  hits.sort((a, b) => b.score - a.score);
  const allResults = hits.map((h) => h.result);
  const offset = (page - 1) * limit;

  return {
    totalCount: allResults.length,
    results: allResults.slice(offset, offset + limit),
  };
}

// --- Recent commits (files modified recently) ---

export async function vaultRecentCommits(
  limit: number,
  folder?: string,
  since?: string
): Promise<RecentNote[]> {
  if (folder) validateVaultPath(folder);
  const { pat, repo } = getConfig();

  // Use commits API with path filter — returns commits that touch files in folder
  let url = `${GITHUB_API}/repos/${repo}/commits?per_page=100`;
  if (folder) {
    url += `&path=${encodeURIComponent(folder.replace(/\/$/, ""))}`;
  }
  if (since) {
    // Ensure ISO format for GitHub API
    const sinceDate = since.includes("T") ? since : `${since}T00:00:00Z`;
    url += `&since=${encodeURIComponent(sinceDate)}`;
  }

  const res = await fetchWithTimeout(url, { headers: headers(pat) }, 15_000);
  if (!res.ok) throw new Error(`GitHub Commits error: ${res.status}`);

  const commits = (await res.json()) as Array<{
    sha: string;
    commit: {
      message: string;
      author: { name: string; date: string };
    };
    files?: Array<{ filename: string; status: string }>;
  }>;

  // Deduplicate by file path — we want unique recently modified files
  const seen = new Set<string>();
  const results: RecentNote[] = [];

  for (const commit of commits) {
    if (results.length >= limit) break;

    // Fetch commit details to get file list
    const detailRes = await fetchWithTimeout(
      `${GITHUB_API}/repos/${repo}/commits/${commit.sha}`,
      { headers: headers(pat) },
      FETCH_TIMEOUT
    );
    if (!detailRes.ok) continue;

    const detail = (await detailRes.json()) as {
      files?: Array<{ filename: string; status: string }>;
    };

    for (const file of detail.files || []) {
      if (results.length >= limit) break;
      if (!file.filename.endsWith(".md")) continue;
      if (folder && !file.filename.startsWith(folder.replace(/\/$/, "") + "/")) continue;
      if (seen.has(file.filename)) continue;

      seen.add(file.filename);
      results.push({
        path: file.filename,
        message: commit.commit.message.split("\n")[0] ?? "",
        date: commit.commit.author.date,
        author: commit.commit.author.name,
      });
    }
  }

  return results;
}

// --- Tree listing (for stats) ---

export async function vaultTree(folder?: string): Promise<TreeFile[]> {
  if (folder) validateVaultPath(folder);
  const { pat, repo } = getConfig();

  const res = await fetchWithTimeout(
    `${GITHUB_API}/repos/${repo}/git/trees/${readConfig("GITHUB_BRANCH") || "main"}?recursive=1`,
    { headers: headers(pat) },
    FETCH_TIMEOUT
  );

  if (!res.ok) throw new Error(`GitHub Trees error: ${res.status}`);

  const tree = (await res.json()) as GitTreeResponse;

  let files = tree.tree
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size || 0, sha: t.sha }));

  if (folder) {
    const prefix = folder.replace(/\/$/, "") + "/";
    files = files.filter((f) => f.path.startsWith(prefix));
  }

  return files;
}

// --- Health check ---

export async function checkVaultHealth(): Promise<{
  ok: boolean;
  patValid: boolean;
  repoAccessible: boolean;
  rateLimit: { remaining: number; limit: number; reset: string };
  error?: string;
}> {
  const { pat, repo } = getConfig();

  const res = await fetchWithTimeout(
    `${GITHUB_API}/repos/${repo}`,
    { headers: headers(pat) },
    FETCH_TIMEOUT
  );

  const rateLimitRemaining = parseInt(res.headers.get("x-ratelimit-remaining") || "0");
  const rateLimitTotal = parseInt(res.headers.get("x-ratelimit-limit") || "0");
  const rateLimitReset = new Date(
    parseInt(res.headers.get("x-ratelimit-reset") || "0") * 1000
  ).toISOString();

  const rateLimit = { remaining: rateLimitRemaining, limit: rateLimitTotal, reset: rateLimitReset };

  if (!res.ok) {
    return {
      ok: false,
      patValid: res.status !== 401,
      repoAccessible: false,
      rateLimit,
      error: `${res.status}`,
    };
  }

  return { ok: true, patValid: true, repoAccessible: true, rateLimit };
}

// --- Helpers ---

function encodeURIPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
