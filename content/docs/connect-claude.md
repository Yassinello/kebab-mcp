---
title: Set it up from Claude
summary: Connect Claude, say one sentence, and let Claude do the rest
order: 12
---

After deploying, you connect Claude once and say one sentence. Claude does the rest with you, in the conversation.

Three things stay in your browser, on purpose: adding the connector in Claude, the secrets for your connectors (never typed in the chat), and confirming changes to your settings.

## 1. Connect Claude

The **Connect Claude** card is on the last welcome screen, and at the top of the [Overview](/config) until an AI client has connected. It works for Claude on the web, the desktop app and the mobile app.

1. **Add the connector.** Click **Connect Claude**. Claude opens with your Kebab House URL already filled in: click **Add**, then **Connect**. By hand: in Claude, **Settings → Connectors → Add custom connector**, and paste your Kebab House URL (your address followed by `/api/mcp`).
2. **Authorise.** Claude sends you to your Kebab House page. If it asks you to sign in, use your admin key.
3. **Choose the access level.** Pick **Read + my profile and notes** (recommended), then **Approve**. You can change it later in [Devices](/config?tab=devices).

## 2. Say the phrase

In a new conversation with Claude, say:

> Set up my Kebab House

Claude asks a few questions (your role and projects, the "hats" you wear, the tasks that come back every week, how you like answers), drafts your profile and saves it once you agree, then suggests rituals and installs the ones you accept. You can stop at any time: say the phrase again to pick up where you left off.

## 3. Connectors: secrets only here

Claude never asks you to paste a password, token or API key in the conversation. When you want a connector, it gives you a link to that connector's card in [Connectors](/config?tab=connectors): the form is open and ready. Enter the details, save, then go back to Claude and say **"done"**.

## 4. The Kebab House skill

Add it once and Claude uses your profile, your skills and the Kebab House rules on its own. Download it from [Skills → Add the Kebab House skill to Claude](/config?tab=skills&panel=kebab-skill), then:

- **claude.ai and Claude Desktop:** Settings → Capabilities → Skills → Upload skill, and pick the `.zip`.
- **Claude Code:** unzip it into `~/.claude/skills/`.

## 5. Confirming changes to your settings

Claude can propose changes to your settings (an access level, a tool turned on or off, a setting). Nothing changes when it proposes: Claude gives you a link, you read what will change and confirm it in your browser. The link works for 15 minutes.

## 6. Other AI clients

Cursor, Claude Code and ChatGPT are under **Other AI clients** on the Connect Claude card. Clients that cannot sign in get their own token in [Devices → Add device](/config?tab=devices). Never use your admin key in an AI client.

## Troubleshooting

- **Kebab House does not show up in Claude.** In Claude, check **Settings → Connectors**: if it says _Connect_, click it and approve again. In a conversation, make sure the connector is turned on in the tools menu.
- **I chose "Read only" by mistake.** Claude cannot save your profile or install rituals. In [Devices](/config?tab=devices), change Claude's access level to **Read + my profile and notes**, or remove the connector in Claude and add it again.
- **The link has expired.** Confirmation links work for 15 minutes. Ask Claude to propose the change again.
