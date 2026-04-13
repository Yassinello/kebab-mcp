import { z } from "zod";
import {
  githubFetch,
  resolveRepo,
  formatIssue,
  GitHubIssue,
  GitHubComment,
} from "../lib/github-api";

export const githubGetIssueSchema = {
  issue_number: z.number().describe("Issue number"),
  repo: z
    .string()
    .optional()
    .describe("Repository in owner/repo format. Defaults to GITHUB_DEFAULT_REPO."),
  include_comments: z.boolean().optional().describe("Include issue comments (default: true)"),
};

export async function handleGithubGetIssue(params: {
  issue_number: number;
  repo?: string;
  include_comments?: boolean;
}) {
  const repo = resolveRepo(params.repo);
  const includeComments = params.include_comments !== false;

  const issue = await githubFetch<GitHubIssue>(`/repos/${repo}/issues/${params.issue_number}`);

  const sections: string[] = [formatIssue(issue)];

  if (includeComments && issue.comments > 0) {
    const comments = await githubFetch<GitHubComment[]>(
      `/repos/${repo}/issues/${params.issue_number}/comments?per_page=50`
    );
    if (comments.length > 0) {
      sections.push("---");
      sections.push(`## Comments (${comments.length})`);
      for (const c of comments) {
        sections.push(`**@${c.user.login}** on ${c.created_at.slice(0, 10)}:\n${c.body ?? ""}`);
      }
    }
  }

  return {
    content: [{ type: "text" as const, text: sections.join("\n\n") }],
  };
}
