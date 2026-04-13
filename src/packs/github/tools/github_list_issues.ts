import { z } from "zod";
import { githubFetch, resolveRepo, formatIssue, GitHubIssue } from "../lib/github-api";

export const githubListIssuesSchema = {
  repo: z
    .string()
    .optional()
    .describe("Repository in owner/repo format. Defaults to GITHUB_DEFAULT_REPO."),
  state: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe("Filter by issue state (default: open)"),
  labels: z.string().optional().describe("Comma-separated list of label names to filter by"),
  assignee: z.string().optional().describe("Filter by assignee username"),
  milestone: z.string().optional().describe("Milestone number or 'none' / '*'"),
  limit: z.number().optional().describe("Max issues to return (default: 20, max: 100)"),
};

export async function handleGithubListIssues(params: {
  repo?: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  assignee?: string;
  milestone?: string;
  limit?: number;
}) {
  const repo = resolveRepo(params.repo);
  const perPage = Math.min(params.limit ?? 20, 100);

  const query = new URLSearchParams({ per_page: String(perPage) });
  if (params.state) query.set("state", params.state);
  if (params.labels) query.set("labels", params.labels);
  if (params.assignee) query.set("assignee", params.assignee);
  if (params.milestone) query.set("milestone", params.milestone);

  const issues = await githubFetch<GitHubIssue[]>(`/repos/${repo}/issues?${query.toString()}`);

  // Filter out pull requests
  const realIssues = issues.filter((i) => !i.pull_request);

  if (realIssues.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No issues found." }],
    };
  }

  const lines = realIssues.map((i) =>
    `- **#${i.number}** [${i.state}] ${i.title} — ${i.labels.map((l) => `\`${l.name}\``).join(" ")}`.trim()
  );

  return {
    content: [
      {
        type: "text" as const,
        text: `## Issues in ${repo} (${realIssues.length})\n\n${lines.join("\n")}`,
      },
    ],
  };
}
