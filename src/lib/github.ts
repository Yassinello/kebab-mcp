const GITHUB_API = "https://api.github.com";

function getConfig() {
  const pat = process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPO;
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

export interface VaultFile {
  path: string;
  name: string;
  sha: string;
  content: string;
  size: number;
}

export interface VaultListEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface SearchResult {
  name: string;
  path: string;
  textMatches: string[];
}

// --- Read ---

export async function vaultRead(path: string): Promise<VaultFile> {
  const { pat, repo } = getConfig();
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(path)}`,
    { headers: headers(pat) }
  );

  if (!res.ok) {
    if (res.status === 404) throw new Error(`Note not found: ${path}`);
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");

  return {
    path: data.path,
    name: data.name,
    sha: data.sha,
    content,
    size: data.size,
  };
}

// --- Write (create or update) ---

export async function vaultWrite(
  path: string,
  content: string,
  message?: string
): Promise<{ path: string; sha: string; created: boolean }> {
  const { pat, repo } = getConfig();
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIPath(path)}`;

  // Try to get existing file SHA for update
  let existingSha: string | undefined;
  const getRes = await fetch(url, { headers: headers(pat) });
  if (getRes.ok) {
    const existing = await getRes.json();
    existingSha = existing.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub API error: ${getRes.status} ${getRes.statusText}`);
  }

  const body: Record<string, string> = {
    message: message || "Update via YassMCP",
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const putRes = await fetch(url, {
    method: "PUT",
    headers: headers(pat),
    body: JSON.stringify(body),
  });

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

// --- List directory ---

export async function vaultList(folder?: string): Promise<VaultListEntry[]> {
  const { pat, repo } = getConfig();
  const pathSegment = folder ? `/${encodeURIPath(folder)}` : "";
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents${pathSegment}`,
    { headers: headers(pat) }
  );

  if (!res.ok) {
    if (res.status === 404) throw new Error(`Folder not found: ${folder || "/"}`);
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Path is a file, not a directory: ${folder}`);
  }

  return data.map((item: any) => ({
    name: item.name,
    path: item.path,
    type: item.type === "dir" ? "dir" : "file",
    size: item.size || 0,
  }));
}

// --- Search ---

export async function vaultSearch(
  query: string,
  folder?: string,
  limit = 10
): Promise<SearchResult[]> {
  const { pat, repo } = getConfig();

  let q = `${query} repo:${repo}`;
  if (folder) {
    q += ` path:${folder}`;
  }

  const res = await fetch(
    `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`,
    {
      headers: {
        ...headers(pat),
        Accept: "application/vnd.github.text-match+json",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`GitHub Search error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  return (data.items || []).map((item: any) => ({
    name: item.name,
    path: item.path,
    textMatches: (item.text_matches || []).map((m: any) => m.fragment),
  }));
}

// --- Helpers ---

function encodeURIPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
