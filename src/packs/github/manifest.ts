import type { PackManifest } from "@/core/types";
import { githubFetch } from "./lib/github-api";
import { githubListIssuesSchema, handleGithubListIssues } from "./tools/github_list_issues";
import { githubGetIssueSchema, handleGithubGetIssue } from "./tools/github_get_issue";
import { githubCreateIssueSchema, handleGithubCreateIssue } from "./tools/github_create_issue";
import { githubUpdateIssueSchema, handleGithubUpdateIssue } from "./tools/github_update_issue";
import { githubAddCommentSchema, handleGithubAddComment } from "./tools/github_add_comment";
import { githubSearchIssuesSchema, handleGithubSearchIssues } from "./tools/github_search_issues";

export const githubPack: PackManifest = {
  id: "github",
  label: "GitHub Issues",
  description: "Create, read, update, and search GitHub issues",
  requiredEnvVars: ["GITHUB_TOKEN"],
  diagnose: async () => {
    try {
      const user = await githubFetch<{ login: string }>("/user");
      return { ok: true, message: `Connected as @${user.login}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot reach GitHub API",
      };
    }
  },
  tools: [
    {
      name: "github_list_issues",
      description:
        "List issues in a GitHub repository. Filters: state (open/closed/all), labels, assignee, milestone. Returns issue numbers, titles, labels, and state.",
      schema: githubListIssuesSchema,
      handler: async (params) =>
        handleGithubListIssues(
          params as {
            repo?: string;
            state?: "open" | "closed" | "all";
            labels?: string;
            assignee?: string;
            milestone?: string;
            limit?: number;
          }
        ),
    },
    {
      name: "github_get_issue",
      description: "Get full details of a GitHub issue by number, including body and comments.",
      schema: githubGetIssueSchema,
      handler: async (params) =>
        handleGithubGetIssue(
          params as {
            issue_number: number;
            repo?: string;
            include_comments?: boolean;
          }
        ),
    },
    {
      name: "github_create_issue",
      description:
        "Create a new GitHub issue with title, body, labels, and assignees. Always show the issue content to the user for confirmation before calling.",
      schema: githubCreateIssueSchema,
      handler: async (params) =>
        handleGithubCreateIssue(
          params as {
            title: string;
            body?: string;
            labels?: string[];
            assignees?: string[];
            milestone?: number;
            repo?: string;
          }
        ),
      destructive: true,
    },
    {
      name: "github_update_issue",
      description:
        "Update a GitHub issue: change title, body, state (open/closed), labels, or assignees. Always confirm changes with the user before calling.",
      schema: githubUpdateIssueSchema,
      handler: async (params) =>
        handleGithubUpdateIssue(
          params as {
            issue_number: number;
            title?: string;
            body?: string;
            state?: "open" | "closed";
            labels?: string[];
            assignees?: string[];
            milestone?: number | null;
            repo?: string;
          }
        ),
      destructive: true,
    },
    {
      name: "github_add_comment",
      description:
        "Add a comment to a GitHub issue. Always show the comment text to the user for approval before calling.",
      schema: githubAddCommentSchema,
      handler: async (params) =>
        handleGithubAddComment(
          params as {
            issue_number: number;
            body: string;
            repo?: string;
          }
        ),
      destructive: true,
    },
    {
      name: "github_search_issues",
      description:
        "Search GitHub issues using GitHub search syntax. Supports qualifiers: repo:owner/repo, is:open, is:closed, label:bug, assignee:user, author:user, in:title, in:body.",
      schema: githubSearchIssuesSchema,
      handler: async (params) =>
        handleGithubSearchIssues(
          params as {
            query: string;
            limit?: number;
          }
        ),
    },
  ],
};
