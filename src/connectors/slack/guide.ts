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

### How to get the Bot User OAuth Token
The token Kebab needs is **not** on the _Basic Information_ page (that page shows the Client ID / Client Secret / Signing Secret — those are **not** what you want). It lives under **OAuth & Permissions**, and it only appears **after** you add scopes and install the app:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch** (or open your existing app)
2. In the left sidebar, open **Features → OAuth & Permissions**
3. Scroll to **Scopes → Bot Token Scopes** and add: \`channels:read\`, \`channels:history\`, \`groups:read\`, \`groups:history\`, \`chat:write\`, \`users:read\`, \`users:read.email\`, \`search:read\` (paid plans only)
4. Scroll back to the top of that same page and click **Install to Workspace** → **Allow**
5. A **Bot User OAuth Token** now appears at the top of **OAuth & Permissions** — it starts with \`xoxb-\`. Copy it and paste it here.
6. Invite the bot to any channel you want it to read with \`/invite @yourbot\`

> **Not the Client Secret / Signing Secret.** Those are for OAuth redirect flows and request signing — Kebab uses the bot token (\`xoxb-…\`) only.

### Multiple accounts
Once enabled, you can connect more than one Slack workspace from the connector card and pin which one tools act as by default. Override per call with the \`account\` parameter (e.g. _"send to #general in the ACME account"_).

### Troubleshooting
- _not_in_channel_: invite the bot to the channel first.
- _missing_scope_: add the scope under **OAuth & Permissions**, then reinstall the app.
- _search fails_: \`search.messages\` requires a paid Slack workspace.`;
