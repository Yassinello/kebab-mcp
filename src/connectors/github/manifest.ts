import { defineTool, type ConnectorManifest } from "@/core/types";
import { githubFetch } from "./lib/github-api";
import { githubListIssuesSchema, handleGithubListIssues } from "./tools/github_list_issues";
import { githubGetIssueSchema, handleGithubGetIssue } from "./tools/github_get_issue";
import { githubCreateIssueSchema, handleGithubCreateIssue } from "./tools/github_create_issue";
import { githubUpdateIssueSchema, handleGithubUpdateIssue } from "./tools/github_update_issue";
import { githubAddCommentSchema, handleGithubAddComment } from "./tools/github_add_comment";
import { githubSearchIssuesSchema, handleGithubSearchIssues } from "./tools/github_search_issues";

export const githubConnector: ConnectorManifest = {
  id: "github",
  label: "GitHub Issues",
  description: "Create, read, update, and search GitHub issues",
  guide: `List, read, create, update, comment on, and search GitHub issues on any repo you have access to.

### Prerequisites
A GitHub account and at least one repository. Works with both personal and org repos, as long as the token's owner has access.

### How to get credentials
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) (or **Settings → Developer settings → Personal access tokens**)
2. Click **Generate new token** — fine-grained tokens are recommended
3. Grant **Read and write** access to **Issues** for the repos you want to expose
4. Copy the generated token and set it as \`GITHUB_TOKEN\`
5. Optional: set a default repo via \`GITHUB_DEFAULT_REPO=owner/repo\` so you don't have to pass \`repo\` on every call

### Troubleshooting
- _404 on a repo you own_: fine-grained tokens must explicitly list the repo under **Repository access**.
- _403 rate limit_: authenticated calls get 5000/hr — if you hit it, wait or use a second token.
- _Cannot create issues_: the token needs **Issues: Read and write**, not just read.`,
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
    defineTool({
      name: "github_list_issues",
      description:
        "List issues in a GitHub repository. Filters: state (open/closed/all), labels, assignee, milestone. Returns issue numbers, titles, labels, and state.",
      schema: githubListIssuesSchema,
      handler: async (args) => handleGithubListIssues(args),
      destructive: false,
    }),
    defineTool({
      name: "github_get_issue",
      description: "Get full details of a GitHub issue by number, including body and comments.",
      schema: githubGetIssueSchema,
      handler: async (args) => handleGithubGetIssue(args),
      destructive: false,
    }),
    defineTool({
      name: "github_create_issue",
      description:
        "Create a new GitHub issue with title, body, labels, and assignees. Always show the issue content to the user for confirmation before calling.",
      schema: githubCreateIssueSchema,
      handler: async (args) => handleGithubCreateIssue(args),
      destructive: true,
    }),
    defineTool({
      name: "github_update_issue",
      description:
        "Update a GitHub issue: change title, body, state (open/closed), labels, or assignees. Always confirm changes with the user before calling.",
      schema: githubUpdateIssueSchema,
      handler: async (args) => handleGithubUpdateIssue(args),
      destructive: true,
    }),
    defineTool({
      name: "github_add_comment",
      description:
        "Add a comment to a GitHub issue. Always show the comment text to the user for approval before calling.",
      schema: githubAddCommentSchema,
      handler: async (args) => handleGithubAddComment(args),
      destructive: true,
    }),
    defineTool({
      name: "github_search_issues",
      description:
        "Search GitHub issues using GitHub search syntax. Supports qualifiers: repo:owner/repo, is:open, is:closed, label:bug, assignee:user, author:user, in:title, in:body.",
      schema: githubSearchIssuesSchema,
      handler: async (args) => handleGithubSearchIssues(args),
      destructive: false,
    }),
  ],
};
