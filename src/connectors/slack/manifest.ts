import { defineTool, type ConnectorManifest } from "@/core/types";
import { slackChannelsSchema, handleSlackChannels } from "./tools/slack-channels";
import { slackReadSchema, handleSlackRead } from "./tools/slack-read";
import { slackSendSchema, handleSlackSend } from "./tools/slack-send";
import { slackSearchSchema, handleSlackSearch } from "./tools/slack-search";
import { slackThreadSchema, handleSlackThread } from "./tools/slack-thread";
import { slackProfileSchema, handleSlackProfile } from "./tools/slack-profile";
import { getConfig } from "@/core/config-facade";

export const slackConnector: ConnectorManifest = {
  id: "slack",
  label: "Slack",
  description: "Channels, messages, threads, profiles, search, send",
  guide: `List channels, read messages and threads, search history, look up user profiles, and send messages in your Slack workspace via a Bot User OAuth token.

### Prerequisites
Admin access (or approval) to install a custom app in a Slack workspace. Free Slack plans work but cannot use \`search.messages\` — the search tool will fall back or fail on free tier.

### How to get credentials
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**: \`channels:read\`, \`channels:history\`, \`groups:read\`, \`groups:history\`, \`chat:write\`, \`users:read\`, \`users:read.email\`, \`search:read\` (paid only)
3. Click **Install to Workspace** and approve
4. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`) and set it as \`SLACK_BOT_TOKEN\`
5. Invite the bot to any channel you want it to read with \`/invite @yourbot\`

### Troubleshooting
- _not_in_channel_: invite the bot to the channel first.
- _missing_scope_: add the scope under **OAuth & Permissions**, then reinstall the app.
- _search fails_: \`search.messages\` requires a paid Slack workspace.`,
  requiredEnvVars: ["SLACK_BOT_TOKEN"],
  testConnection: async (credentials) => {
    const token = credentials.SLACK_BOT_TOKEN;
    if (!token) return { ok: false, message: "Missing token" };
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      ok: boolean;
      team?: string;
      team_id?: string;
      error?: string;
      user?: string;
    };
    if (data.ok) {
      // Phase 75 (MAUI): also surface the raw workspace name + id so the
      // multi-account selector can auto-derive the saved account's display
      // name (auth.test returns `team` = workspace name, `team_id` = its id).
      // `message` is left UNCHANGED — setup-test-dispatch + other callers
      // assert against it. exactOptionalPropertyTypes: only attach
      // account_id when present.
      return {
        ok: true,
        message: `Connected to ${data.team} as ${data.user || "bot"}`,
        account_name: data.team || "Slack workspace",
        ...(data.team_id ? { account_id: data.team_id } : {}),
      };
    }
    return {
      ok: false,
      message: "Slack auth failed",
      detail: data.error || "Unknown Slack error",
    };
  },
  diagnose: async () => {
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${getConfig("SLACK_BOT_TOKEN") ?? ""}` },
      });
      const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
      if (data.ok) return { ok: true, message: `Connected to ${data.team}` };
      return { ok: false, message: `Slack auth failed: ${data.error}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach Slack" };
    }
  },
  tools: [
    defineTool({
      name: "slack_channels",
      description:
        "List Slack channels the bot has access to. Returns channel name, topic, member count, and ID.",
      schema: slackChannelsSchema,
      handler: async (args) => handleSlackChannels(args),
      destructive: false,
    }),
    defineTool({
      name: "slack_read",
      description:
        "Read recent messages from a Slack channel. Returns sender, text, timestamp, and thread info. Use slack_channels to find the channel ID.",
      schema: slackReadSchema,
      handler: async (args) => handleSlackRead(args),
      destructive: false,
    }),
    defineTool({
      name: "slack_send",
      description:
        "Send a message to a Slack channel. Supports Slack markdown. Can reply in a thread using thread_ts. Always show the message to the user for approval before calling.",
      schema: slackSendSchema,
      handler: async (args) => handleSlackSend(args),
      destructive: true,
    }),
    defineTool({
      name: "slack_search",
      description:
        "Search Slack messages. Supports Slack search operators: from:user, in:channel, has:link, before:date, after:date.",
      schema: slackSearchSchema,
      handler: async (args) => handleSlackSearch(args),
      destructive: false,
    }),
    defineTool({
      name: "slack_thread",
      description:
        "Read replies in a Slack thread. Provide the channel ID and parent message timestamp (thread_ts from slack_read).",
      schema: slackThreadSchema,
      handler: async (args) => handleSlackThread(args),
      destructive: false,
    }),
    defineTool({
      name: "slack_profile",
      description:
        "Get a Slack user's profile: name, title, email, timezone, status. Use the user ID from slack_read results.",
      schema: slackProfileSchema,
      handler: async (args) => handleSlackProfile(args),
      destructive: false,
    }),
  ],
};
