import { McpToolError, ErrorCode } from "@/core/errors";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

const LINEAR_API = "https://api.linear.app/graphql";

export async function linearQuery<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const apiKey = getConfig("LINEAR_API_KEY");
  if (!apiKey) {
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "linear",
      message: "LINEAR_API_KEY not configured",
      userMessage:
        "Linear pack is not configured. Add LINEAR_API_KEY to your environment variables.",
      retryable: false,
    });
  }

  let res: Response;
  try {
    res = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "Linear-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "linear",
      message: `Network error reaching Linear API: ${toMsg(err)}`,
      userMessage: "Could not reach the Linear API. Check your network connection.",
      retryable: true,
      cause: err instanceof Error ? err : undefined,
    });
  }

  if (res.status === 401) {
    throw new McpToolError({
      code: ErrorCode.AUTH_FAILED,
      toolName: "linear",
      message: "Linear API key is invalid or expired",
      userMessage: "Linear authentication failed. Check your LINEAR_API_KEY.",
      retryable: false,
    });
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    throw new McpToolError({
      code: ErrorCode.RATE_LIMITED,
      toolName: "linear",
      message: `Linear API rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
      userMessage: `Linear API rate limit hit. Try again shortly.`,
      retryable: true,
    });
  }

  if (!res.ok) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "linear",
      message: `Linear API HTTP error ${res.status}`,
      userMessage: `Linear API returned an error (${res.status}). Try again later.`,
      retryable: false,
    });
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "linear",
      message: `Linear GraphQL error: ${msg}`,
      userMessage: `Linear returned an error: ${msg}`,
      retryable: false,
    });
  }

  return json.data as T;
}

// --- Name resolution helpers ---

export async function resolveTeamId(teamKey: string): Promise<string> {
  const data = await linearQuery<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
    `query($filter: TeamFilter) { teams(filter: $filter) { nodes { id key } } }`,
    { filter: { key: { eq: teamKey.toUpperCase() } } }
  );
  const team = data.teams.nodes[0];
  if (!team) {
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "linear",
      message: `Team with key "${teamKey}" not found`,
      userMessage: `No Linear team found with key "${teamKey}". Check the team key (e.g. "ENG").`,
      retryable: false,
    });
  }
  return team.id;
}

export async function resolveUserId(nameOrEmail: string): Promise<string> {
  const data = await linearQuery<{
    users: { nodes: Array<{ id: string; name: string; email: string }> };
  }>(`query { users { nodes { id name email } } }`);
  const lower = nameOrEmail.toLowerCase();
  const user = data.users.nodes.find(
    (u) => u.name.toLowerCase() === lower || u.email.toLowerCase() === lower
  );
  if (!user) {
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "linear",
      message: `User "${nameOrEmail}" not found`,
      userMessage: `No Linear user found matching "${nameOrEmail}".`,
      retryable: false,
    });
  }
  return user.id;
}

export async function resolveStateId(teamId: string, stateName: string): Promise<string> {
  const data = await linearQuery<{
    workflowStates: { nodes: Array<{ id: string; name: string }> };
  }>(
    `query($filter: WorkflowStateFilter) { workflowStates(filter: $filter) { nodes { id name } } }`,
    { filter: { team: { id: { eq: teamId } } } }
  );
  const lower = stateName.toLowerCase();
  const state = data.workflowStates.nodes.find((s) => s.name.toLowerCase() === lower);
  if (!state) {
    const available = data.workflowStates.nodes.map((s) => s.name).join(", ");
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "linear",
      message: `State "${stateName}" not found in team`,
      userMessage: `No workflow state "${stateName}" found. Available: ${available}`,
      retryable: false,
    });
  }
  return state.id;
}

export async function resolveLabelIds(teamId: string, labelNames: string[]): Promise<string[]> {
  const data = await linearQuery<{
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(`query($filter: IssueLabelFilter) { issueLabels(filter: $filter) { nodes { id name } } }`, {
    filter: { team: { id: { eq: teamId } } },
  });
  return labelNames.map((name) => {
    const lower = name.toLowerCase();
    const label = data.issueLabels.nodes.find((l) => l.name.toLowerCase() === lower);
    if (!label) {
      throw new McpToolError({
        code: ErrorCode.NOT_FOUND,
        toolName: "linear",
        message: `Label "${name}" not found`,
        userMessage: `No label "${name}" found in this team.`,
        retryable: false,
      });
    }
    return label.id;
  });
}

// --- Shared types ---

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  priorityLabel: string;
  state: { name: string; type: string };
  team: { key: string; name: string };
  assignee?: { name: string; email: string } | null;
  labels: { nodes: Array<{ name: string }> };
  createdAt: string;
  updatedAt: string;
  url: string;
  commentCount?: number;
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: "No Priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function formatLinearIssue(issue: LinearIssue): string {
  const labels = issue.labels.nodes.map((l) => `\`${l.name}\``).join(", ") || "none";
  const assignee = issue.assignee?.name || "unassigned";
  return [
    `### ${issue.identifier}: ${issue.title}`,
    `**State:** ${issue.state.name}  **Priority:** ${issue.priorityLabel}  **Assignee:** ${assignee}`,
    `**Team:** ${issue.team.name}  **Labels:** ${labels}`,
    `**Created:** ${issue.createdAt.slice(0, 10)}  **Updated:** ${issue.updatedAt.slice(0, 10)}`,
    `**URL:** ${issue.url}`,
    issue.description ? `\n${issue.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
