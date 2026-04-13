import { z } from "zod";
import { githubFetch, resolveRepo, GitHubComment } from "../lib/github-api";

export const githubAddCommentSchema = {
  issue_number: z.number().describe("Issue number to comment on"),
  body: z.string().describe("Comment text (markdown supported)"),
  repo: z
    .string()
    .optional()
    .describe("Repository in owner/repo format. Defaults to GITHUB_DEFAULT_REPO."),
};

export async function handleGithubAddComment(params: {
  issue_number: number;
  body: string;
  repo?: string;
}) {
  const repo = resolveRepo(params.repo);

  const comment = await githubFetch<GitHubComment>(
    `/repos/${repo}/issues/${params.issue_number}/comments`,
    { method: "POST", body: JSON.stringify({ body: params.body }) }
  );

  return {
    content: [
      {
        type: "text" as const,
        text: `Comment added by @${comment.user.login} on issue #${params.issue_number} (id: ${comment.id})`,
      },
    ],
  };
}
