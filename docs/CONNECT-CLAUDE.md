# Set it up from Claude

After you deploy Kebab House, you connect Claude once and say one sentence. Claude does the rest with you, in the conversation.

Three things stay in your browser, on purpose:

1. **Adding the connector** in Claude (copy the URL, paste it, approve).
2. **Secrets for your connectors** (sign-ins, API keys). You never type them in the chat.
3. **Confirming changes to your settings.** Claude proposes, you confirm on a link.

Everything else (your profile, your rituals, which connectors to plug in) happens by talking to Claude.

---

## 1. Deploy

Use the **Deploy Kebab House** button on [the website](https://kebab-mcp.vercel.app/deploy). It creates your copy of the code on GitHub, a Vercel project and a free database, then deploys. You need a GitHub account and a free Vercel account.

When the build is done, open your new address. The welcome page asks you to create your **admin key**: save it in your password manager. It opens your dashboard. Do not paste it into AI clients.

The last welcome screen is **Connect Claude**. The same card stays at the top of your dashboard (Overview) until an AI client has connected.

Your Kebab House URL is your address followed by `/api/mcp`, for example `https://my-kebab-house.vercel.app/api/mcp`.

## 2. Connect Claude

This works for Claude on the web, the desktop app and the mobile app (add it once on the web or desktop, it then shows up everywhere you use your Claude account).

1. **Add the connector.** Click **Connect Claude** on the welcome page or the dashboard. Claude opens with your URL already filled in: click **Add**, then **Connect**.
   By hand: in Claude, open **Settings → Connectors → Add custom connector**, give it a name (for example _Kebab House_), paste your Kebab House URL, then **Add** and **Connect**.
2. **Authorise.** Claude sends you to your Kebab House page. If it asks you to sign in, use your admin key.
3. **Choose the access level.** Pick **Read + my profile and notes** (recommended), then **Approve**. You can change it later in your dashboard, under **Devices**.

You are back in Claude and Kebab House shows as connected.

## 3. Say the phrase

In a new conversation, say:

> Set up my Kebab House

That is all you need to remember.

## 4. What Claude will ask

Claude runs a short setup, one step at a time. You can stop and come back later: say the phrase again and it picks up where you left off.

1. **A few questions.** Your role and current projects, the "hats" you wear (personal, a company, a side project), the tasks that come back every week, and how you like answers. If Claude already knows you, it says what it knows and only asks what is missing.
2. **Your profile.** Claude drafts it, shows it to you and saves it only once you agree. Every AI client you connect reads the same profile.
3. **Rituals.** Ready-made routines like a morning brief, meeting prep or a weekly review. Claude suggests the ones that fit and installs the ones you accept.
4. **Connectors (optional).** See below.

At the end, Claude suggests one ritual to try right away.

## 5. Connectors: secrets only in the dashboard

Some things need an account of yours: LinkedIn or WhatsApp, a web browser, paywalled articles, your notes on GitHub, and so on.

Claude never asks you to paste a password, token or API key in the conversation. Instead it gives you a link to that connector in your dashboard. The link opens the connector's card with its form ready. Enter the details there and save, then go back to Claude and say **"done"**.

Gmail, Calendar, Drive, Slack and Notion often exist as Claude's own connectors: Claude tells you when that is the simpler choice.

## 6. The Kebab House skill

Claude uses your skills when you ask for them. Add the **Kebab House skill** and Claude uses your profile, your skills and the Kebab House rules on its own, without you asking.

In your dashboard, open **Skills → Add the Kebab House skill to Claude** and download the `.zip`. Then:

- **claude.ai and Claude Desktop:** Settings → Capabilities → Skills → Upload skill, and pick the `.zip`.
- **Claude Code:** unzip it into `~/.claude/skills/` (you get `~/.claude/skills/kebab-house/`).
- **ChatGPT:** Skills → Create → Upload from your computer.

Download it again when you add, rename or remove many skills. Edits to a skill are live right away.

## 7. Confirming changes to your settings

Claude can propose changes to your settings: an access level, turning a tool on or off, a setting of your Kebab House. It does this with the `kebab_config` tool.

Nothing changes when Claude proposes. Claude gives you a link: open it, read what will change, and confirm. Only then is the change applied. If you do nothing, nothing changes. The link works for 15 minutes.

Outgoing messages (an email, a Slack or LinkedIn message) work the same way: Claude prepares them, you approve each one.

## 8. Other AI clients

Every client you connect shares the same profile, skills and notes. The welcome page and the dashboard list them under **Other AI clients**.

- **Cursor:** click **Add to Cursor**, then sign in from Cursor.
- **Claude Code:** run `claude mcp add --transport http kebab-house <your Kebab House URL>`, then sign in when Claude Code asks.
- **ChatGPT:** on the web, Settings → Apps & Connectors → turn on Developer mode, then create a connector with your Kebab House URL. You sign in the same way as for Claude.
- **Clients that cannot sign in:** give each one its own token in your dashboard, under **Devices → Add device**. Never use your admin key in an AI client.

More details per client: [CLIENTS.md](CLIENTS.md).

## 9. Troubleshooting

**Kebab House does not show up in Claude.**
Check **Settings → Connectors** in Claude: the connector must be there and connected. If it says _Connect_, click it and approve again. In a conversation, make sure the connector is turned on in the tools menu. Connectors added on the web can take a minute to appear in the desktop and mobile apps.

**I chose "Read only" by mistake.**
Claude can read your profile and skills but cannot save anything, so it cannot write your profile or install rituals. Open your dashboard, go to **Devices**, find Claude and change its access level to **Read + my profile and notes**. Or remove the connector in Claude, add it again and choose the right level on the approval page.

**The link has expired.**
Confirmation links work for 15 minutes. Ask Claude to propose the change again: you get a new link.

**Claude asks me for a password or an API key.**
Do not paste it. Ask Claude for the dashboard link to that connector instead, and enter it there.

**I lost my admin key.**
Look in your password manager first, or for `MCP_AUTH_TOKEN` in your hosting's environment variables. If it is truly gone, open `/welcome` on your Kebab House and use **Locked out? Recover access**.

**I want to start the setup over.**
Say "Set up my Kebab House" again, and tell Claude which step to revisit, or ask it to start over.
