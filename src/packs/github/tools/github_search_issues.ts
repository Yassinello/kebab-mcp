import { z } from "zod";
import { githubFetch, GitHubIssue } from "../lib/github-api";

export const githubSearchIssuesSchema = {
  query: z
    .string()
    .describe(
      "GitHub search query. Supports qualifiers: repo:owner/repo, is:open, is:closed, label:bug, assignee:user, author:user, milestone:title, etc."
    ),
  limit: z.number().optional().describe("Max results to return (default: 20, max: 100)"),
};

interface GitHubSearchResult {
  total_count: number;
  items: GitHubIssue[];
}

export async function handleGithubSearchIssues(params: { query: string; limit?: number }) {
  const perPage = Math.min(params.limit ?? 20, 100);
  const searchQuery = encodeURIComponent(params.query);

  const result = await githubFetch<GitHubSearchResult>(
    `/search/issues?q=${searchQuery}&per_page=${perPage}`
  );

  if (result.items.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No results for: \`${params.query}\``,
        },
      ],
    };
  }

  const lines = result.items.map((i) => {
    const type = i.pull_request ? "PR" : "Issue";
    const labels = i.labels.map((l) => `\`${l.name}\``).join(" ");
    return `- **${type} #${i.number}** [${i.state}] ${i.title} ${labels}\n  ${i.html_url}`.trim();
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `## Search results for \`${params.query}\` (${result.total_count} total, showing ${result.items.length})\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}
