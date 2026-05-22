import { McpToolError, ErrorCode } from "@/core/errors";
import { SlackRateLimitError, SlackAuthError } from "@/core/connector-errors";
import type { AccountTokenSet } from "@/core/connector-accounts";

const SLACK_API = "https://slack.com/api";

interface SlackResponse {
  ok: boolean;
  error?: string;
}

/**
 * Phase 74 (MATL-01/03/05): the selected account's token set is threaded
 * in from the tool handler (which resolved it via
 * `resolveConnectorAccount("slack", …)`) instead of being read from
 * `getConfig()` here. `slackFetch` uses `SLACK_BOT_TOKEN`; `searchMessages`
 * falls back to `SLACK_USER_TOKEN ?? SLACK_BOT_TOKEN`. Missing token still
 * surfaces the same CONFIGURATION_ERROR McpToolError as before.
 */
async function slackFetch<T extends SlackResponse>(
  tokens: AccountTokenSet,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const token = tokens.SLACK_BOT_TOKEN;
  if (!token)
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "slack",
      message: "SLACK_BOT_TOKEN not configured",
      userMessage:
        "Slack pack is not configured. Add SLACK_BOT_TOKEN to your environment variables.",
      retryable: false,
    });

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body.set(k, String(v));
  }

  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await res.json()) as T;
  if (!data.ok) {
    const slackError = data.error || "unknown";
    const isAuth =
      slackError === "not_authed" ||
      slackError === "invalid_auth" ||
      slackError === "token_revoked";
    const isRateLimit = slackError === "ratelimited";

    if (isRateLimit) {
      throw new SlackRateLimitError(method);
    }
    if (isAuth) {
      throw new SlackAuthError(slackError);
    }
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "slack",
      message: `Slack API error: ${slackError}`,
      userMessage: `Slack API error: ${slackError}`,
      retryable: false,
    });
  }
  return data;
}

// --- Types ---

export interface SlackChannel {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  isPrivate: boolean;
}

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  date: string;
  threadTs?: string | undefined;
  replyCount?: number | undefined;
}

// --- List channels ---

export async function listChannels(
  tokens: AccountTokenSet,
  limit?: number
): Promise<SlackChannel[]> {
  const data = await slackFetch<
    SlackResponse & {
      channels?: {
        id: string;
        name: string;
        topic?: { value?: string };
        num_members?: number;
        is_private?: boolean;
      }[];
    }
  >(tokens, "conversations.list", {
    types: "public_channel,private_channel",
    limit: limit || 50,
    exclude_archived: true,
  });

  return (data.channels || []).map((c) => ({
    id: c.id,
    name: c.name,
    topic: c.topic?.value || "",
    memberCount: c.num_members || 0,
    isPrivate: c.is_private || false,
  }));
}

// --- Read messages ---

export async function readMessages(
  tokens: AccountTokenSet,
  channel: string,
  limit?: number
): Promise<SlackMessage[]> {
  const data = await slackFetch<
    SlackResponse & {
      messages?: {
        user?: string;
        text?: string;
        ts: string;
        thread_ts?: string;
        reply_count?: number;
      }[];
    }
  >(tokens, "conversations.history", {
    channel,
    limit: limit || 20,
  });

  return (data.messages || []).map((m) => ({
    user: m.user || "unknown",
    text: m.text || "",
    ts: m.ts,
    date: new Date(parseFloat(m.ts) * 1000).toISOString(),
    threadTs: m.thread_ts,
    replyCount: m.reply_count,
  }));
}

// --- Send message ---

export async function sendMessage(
  tokens: AccountTokenSet,
  channel: string,
  text: string,
  threadTs?: string
): Promise<{ ts: string; channel: string }> {
  const data = await slackFetch<SlackResponse & { ts: string; channel: string }>(
    tokens,
    "chat.postMessage",
    { channel, text, thread_ts: threadTs }
  );
  return { ts: data.ts, channel: data.channel };
}

// --- Read thread ---

export async function readThread(
  tokens: AccountTokenSet,
  channel: string,
  threadTs: string,
  limit?: number
): Promise<SlackMessage[]> {
  const data = await slackFetch<
    SlackResponse & {
      messages?: {
        user?: string;
        text?: string;
        ts: string;
        thread_ts?: string;
      }[];
    }
  >(tokens, "conversations.replies", {
    channel,
    ts: threadTs,
    limit: limit || 50,
  });

  // First message is the parent — skip it to return only replies
  const replies = (data.messages || []).slice(1);
  return replies.map((m) => ({
    user: m.user || "unknown",
    text: m.text || "",
    ts: m.ts,
    date: new Date(parseFloat(m.ts) * 1000).toISOString(),
    threadTs: m.thread_ts,
  }));
}

// --- User profile ---

export interface SlackProfile {
  userId: string;
  realName: string;
  displayName: string;
  title: string;
  email: string;
  phone: string;
  tz: string;
  statusText: string;
  statusEmoji: string;
}

export async function getUserProfile(
  tokens: AccountTokenSet,
  userId: string
): Promise<SlackProfile> {
  const data = await slackFetch<
    SlackResponse & {
      user?: {
        id: string;
        real_name?: string;
        tz?: string;
        profile?: {
          display_name?: string;
          title?: string;
          email?: string;
          phone?: string;
          status_text?: string;
          status_emoji?: string;
        };
      };
    }
  >(tokens, "users.info", { user: userId });

  const u = data.user;
  return {
    userId: u?.id || userId,
    realName: u?.real_name || "",
    displayName: u?.profile?.display_name || "",
    title: u?.profile?.title || "",
    email: u?.profile?.email || "",
    phone: u?.profile?.phone || "",
    tz: u?.tz || "",
    statusText: u?.profile?.status_text || "",
    statusEmoji: u?.profile?.status_emoji || "",
  };
}

// --- Search messages ---

export async function searchMessages(
  tokens: AccountTokenSet,
  query: string,
  count?: number
): Promise<{ text: string; channel: string; user: string; ts: string; date: string }[]> {
  // Note: search requires a user token (xoxp-), not a bot token (MATL-05).
  const token = tokens.SLACK_USER_TOKEN || tokens.SLACK_BOT_TOKEN;
  if (!token)
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "slack",
      message: "SLACK_BOT_TOKEN or SLACK_USER_TOKEN not configured",
      userMessage:
        "Slack search requires SLACK_USER_TOKEN or SLACK_BOT_TOKEN in your environment variables.",
      retryable: false,
    });

  const res = await fetch(
    `${SLACK_API}/search.messages?query=${encodeURIComponent(query)}&count=${count || 10}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const data = (await res.json()) as SlackResponse & {
    messages?: {
      matches?: {
        text: string;
        channel?: { name: string };
        user?: string;
        ts: string;
      }[];
    };
  };

  if (!data.ok) {
    if (data.error === "ratelimited") {
      throw new SlackRateLimitError("search.messages");
    }
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "slack",
      message: `Slack search error: ${data.error}`,
      userMessage: `Slack search failed: ${data.error}`,
      retryable: false,
    });
  }

  return (data.messages?.matches || []).map((m) => ({
    text: m.text,
    channel: m.channel?.name || "",
    user: m.user || "",
    ts: m.ts,
    date: new Date(parseFloat(m.ts) * 1000).toISOString(),
  }));
}
