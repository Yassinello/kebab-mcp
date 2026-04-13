import { z } from "zod";
import { githubFetch, resolveRepo, GitHubIssue } from "../lib/github-api";

export const githubCreateIssueSchema = {
  title: z.string().describe("Issue title"),
  body: z.string().optional().describe("Issue body (markdown supported)"),
  labels: z.array(z.string()).optional().describe("List of label names to apply"),
  assignees: z.array(z.string()).optional().describe("List of GitHub usernames to assign"),
  milestone: z.number().optional().describe("Milestone number to associate with"),
  repo: z
    .string()
    .optional()
    .describe("Repository in owner/repo format. Defaults to GITHUB_DEFAULT_REPO."),
};

export async function handleGithubCreateIssue(params: {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
  repo?: string;
}) {
  const repo = resolveRepo(params.repo);

  const payload: Record<string, unknown> = { title: params.title };
  if (params.body) payload.body = params.body;
  if (params.labels?.length) payload.labels = params.labels;
  if (params.assignees?.length) payload.assignees = params.assignees;
  if (params.milestone) payload.milestone = params.milestone;

  const issue = await githubFetch<GitHubIssue>(`/repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Issue created: **#${issue.number}** ${issue.title}\n${issue.html_url}`,
      },
    ],
  };
}
