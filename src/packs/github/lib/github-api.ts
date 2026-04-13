import { McpToolError, ErrorCode } from "@/core/errors";

const GITHUB_API = "https://api.github.com";

export function getDefaultRepo(): string | undefined {
  return process.env.GITHUB_DEFAULT_REPO;
}

export function resolveRepo(repoParam?: string): string {
  const repo = repoParam || getDefaultRepo();
  if (!repo) {
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "github",
      message: "No repo specified",
      userMessage:
        "Provide a repo in owner/repo format, or set GITHUB_DEFAULT_REPO in your environment.",
      retryable: false,
    });
  }
  return repo;
}

export async function githubFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "github",
      message: "GITHUB_TOKEN not configured",
      userMessage: "GitHub pack is not configured. Add GITHUB_TOKEN to your environment variables.",
      retryable: false,
    });
  }

  const url = path.startsWith("https://") ? path : `${GITHUB_API}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  // Handle rate limiting
  if (res.status === 429 || res.status === 403) {
    const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");
    const rateLimitReset = res.headers.get("x-ratelimit-reset");
    if (rateLimitRemaining === "0") {
      const resetAt = rateLimitReset
        ? new Date(parseInt(rateLimitReset) * 1000).toISOString()
        : "unknown";
      throw new McpToolError({
        code: ErrorCode.RATE_LIMITED,
        toolName: "github",
        message: `GitHub rate limit exceeded, resets at ${resetAt}`,
        userMessage: `GitHub API rate limit exceeded. Try again after ${resetAt}.`,
        retryable: true,
      });
    }
  }

  if (res.status === 401) {
    throw new McpToolError({
      code: ErrorCode.AUTH_FAILED,
      toolName: "github",
      message: "GitHub token is invalid or expired",
      userMessage: "GitHub authentication failed. Check your GITHUB_TOKEN.",
      retryable: false,
    });
  }

  if (res.status === 404) {
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "github",
      message: `GitHub resource not found: ${path}`,
      userMessage: `Resource not found. Check the repo name and issue number.`,
      retryable: false,
    });
  }

  if (!res.ok) {
    let errorMessage = `GitHub API error ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) errorMessage = `GitHub API error: ${body.message}`;
    } catch {
      // ignore parse errors
    }
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "github",
      message: errorMessage,
      userMessage: errorMessage,
      retryable: false,
    });
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

// --- Shared types ---

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubUser {
  login: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  user: GitHubUser;
  labels: GitHubLabel[];
  assignees: GitHubUser[];
  created_at: string;
  updated_at: string;
  comments: number;
  milestone?: { title: string } | null;
  pull_request?: unknown;
}

export interface GitHubComment {
  id: number;
  user: GitHubUser;
  body?: string | null;
  created_at: string;
}

/** Format a GitHub issue as a markdown block */
export function formatIssue(issue: GitHubIssue): string {
  const labels = issue.labels.map((l) => `\`${l.name}\``).join(", ") || "none";
  const assignees = issue.assignees.map((a) => `@${a.login}`).join(", ") || "unassigned";
  const milestone = issue.milestone?.title || "none";
  const type = issue.pull_request ? "PR" : "Issue";

  return [
    `### ${type} #${issue.number}: ${issue.title}`,
    `**State:** ${issue.state}  **Labels:** ${labels}  **Assignees:** ${assignees}`,
    `**Milestone:** ${milestone}  **Comments:** ${issue.comments}`,
    `**Created:** ${issue.created_at.slice(0, 10)}  **Updated:** ${issue.updated_at.slice(0, 10)}`,
    `**URL:** ${issue.html_url}`,
    issue.body ? `\n${issue.body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
