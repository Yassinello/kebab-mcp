/**
 * Slack credential guide — extracted into its own module so the connector
 * registry (`src/core/registry.ts`) can surface it on the DISABLED stub
 * manifest without paying the cost of loading the full manifest (which pulls
 * in every tool handler + the slack-api layer). The guide is plain markdown,
 * so importing it statically is cheap.
 *
 * Source of truth lives here; the manifest re-exports it as `guide`.
 */
export const slackGuide = `List channels, read messages and threads, search history, look up user profiles, and send messages in your Slack workspace via a Bot User OAuth token.

### Prerequisites
Admin access (or approval) to install a custom app in a Slack workspace. Free Slack plans work but cannot use \`search.messages\` — the search tool will fall back or fail on free tier.

### How to get credentials
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**: \`channels:read\`, \`channels:history\`, \`groups:read\`, \`groups:history\`, \`chat:write\`, \`users:read\`, \`users:read.email\`, \`search:read\` (paid only)
3. Click **Install to Workspace** and approve
4. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`) and set it as \`SLACK_BOT_TOKEN\`
5. Invite the bot to any channel you want it to read with \`/invite @yourbot\`

### Multiple accounts
Once enabled, you can connect more than one Slack workspace from the connector card and pin which one tools act as by default. Override per call with the \`account\` parameter (e.g. _"send to #general in the ACME account"_).

### Troubleshooting
- _not_in_channel_: invite the bot to the channel first.
- _missing_scope_: add the scope under **OAuth & Permissions**, then reinstall the app.
- _search fails_: \`search.messages\` requires a paid Slack workspace.`;
