import type { ConnectorManifest } from "@/core/types";
import { slackChannelsSchema, handleSlackChannels } from "./tools/slack-channels";
import { slackReadSchema, handleSlackRead } from "./tools/slack-read";
import { slackSendSchema, handleSlackSend } from "./tools/slack-send";
import { slackSearchSchema, handleSlackSearch } from "./tools/slack-search";
import { slackThreadSchema, handleSlackThread } from "./tools/slack-thread";
import { slackProfileSchema, handleSlackProfile } from "./tools/slack-profile";

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
      error?: string;
      user?: string;
    };
    if (data.ok) {
      return {
        ok: true,
        message: `Connected to ${data.team} as ${data.user || "bot"}`,
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
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
      if (data.ok) return { ok: true, message: `Connected to ${data.team}` };
      return { ok: false, message: `Slack auth failed: ${data.error}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach Slack" };
    }
  },
  tools: [
    {
      name: "slack_channels",
      description:
        "List Slack channels the bot has access to. Returns channel name, topic, member count, and ID.",
      schema: slackChannelsSchema,
      handler: async (params) => handleSlackChannels(params as { limit?: number }),
      destructive: false,
    },
    {
      name: "slack_read",
      description:
        "Read recent messages from a Slack channel. Returns sender, text, timestamp, and thread info. Use slack_channels to find the channel ID.",
      schema: slackReadSchema,
      handler: async (params) => handleSlackRead(params as { channel: string; limit?: number }),
      destructive: false,
    },
    {
      name: "slack_send",
      description:
        "Send a message to a Slack channel. Supports Slack markdown. Can reply in a thread using thread_ts. Always show the message to the user for approval before calling.",
      schema: slackSendSchema,
      handler: async (params) =>
        handleSlackSend(params as { channel: string; text: string; thread_ts?: string }),
      destructive: true,
    },
    {
      name: "slack_search",
      description:
        "Search Slack messages. Supports Slack search operators: from:user, in:channel, has:link, before:date, after:date.",
      schema: slackSearchSchema,
      handler: async (params) => handleSlackSearch(params as { query: string; count?: number }),
      destructive: false,
    },
    {
      name: "slack_thread",
      description:
        "Read replies in a Slack thread. Provide the channel ID and parent message timestamp (thread_ts from slack_read).",
      schema: slackThreadSchema,
      handler: async (params) =>
        handleSlackThread(params as { channel: string; thread_ts: string; limit?: number }),
      destructive: false,
    },
    {
      name: "slack_profile",
      description:
        "Get a Slack user's profile: name, title, email, timezone, status. Use the user ID from slack_read results.",
      schema: slackProfileSchema,
      handler: async (params) => handleSlackProfile(params as { user: string }),
      destructive: false,
    },
  ],
};
