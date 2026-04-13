import { z } from "zod";
import { githubFetch, resolveRepo, GitHubIssue } from "../lib/github-api";

export const githubUpdateIssueSchema = {
  issue_number: z.number().describe("Issue number to update"),
  title: z.string().optional().describe("New title"),
  body: z.string().optional().describe("New body (replaces existing body)"),
  state: z.enum(["open", "closed"]).optional().describe("Set issue state"),
  labels: z
    .array(z.string())
    .optional()
    .describe("Replace labels (full list — replaces existing labels)"),
  assignees: z
    .array(z.string())
    .optional()
    .describe("Replace assignees (full list — replaces existing assignees)"),
  milestone: z.number().nullable().optional().describe("Milestone number, or null to clear"),
  repo: z
    .string()
    .optional()
    .describe("Repository in owner/repo format. Defaults to GITHUB_DEFAULT_REPO."),
};

export async function handleGithubUpdateIssue(params: {
  issue_number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
  repo?: string;
}) {
  const repo = resolveRepo(params.repo);

  const payload: Record<string, unknown> = {};
  if (params.title !== undefined) payload.title = params.title;
  if (params.body !== undefined) payload.body = params.body;
  if (params.state !== undefined) payload.state = params.state;
  if (params.labels !== undefined) payload.labels = params.labels;
  if (params.assignees !== undefined) payload.assignees = params.assignees;
  if (params.milestone !== undefined) payload.milestone = params.milestone;

  const issue = await githubFetch<GitHubIssue>(`/repos/${repo}/issues/${params.issue_number}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Issue updated: **#${issue.number}** ${issue.title} [${issue.state}]\n${issue.html_url}`,
      },
    ],
  };
}
