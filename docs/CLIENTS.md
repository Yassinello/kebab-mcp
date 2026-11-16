# Connect your clients

Kebab House is one MCP endpoint, `https://<your-instance>/api/mcp`, shared by every AI client you use. Each client gets its own identity (a sign-in or a device token), so you can give it its own access level, profile, skill tags and connectors.

Once a client is connected, type **“Set up my Kebab House”** in it to run the guided setup (interview, profile, rituals, connectors). You can run it again at any time.

## Your admin key is not for AI clients

The **admin key** (minted by the welcome page, or `ADMIN_AUTH_TOKEN`) opens your dashboard and approves outgoing messages. Keep it to yourself: **never paste it into an AI client.** Each client gets its own identity instead, one of the two below. If a client calls Kebab House with the admin key, Overview shows a warning.

## Two ways to connect a client

- **Sign-in (OAuth) — Claude, ChatGPT, Cursor, Claude Code.** Paste the endpoint URL only. The client opens your instance's consent page; sign in with your admin key and choose the client's **access level**:
  - **Read only** — it can read your profile, skills, notes and connectors, and change nothing.
  - **Read + my profile and notes** (recommended) — it can also update your profile, save notes and install skills. No deletes, no sends, no writes to other services.
  - **Everything** — every tool, including sends, deletes and the admin tools.

  The client then appears in _Devices_, where you can change its level, bind a profile or revoke it.
- **Device token — every other client** (Codex, Windsurf, n8n…). _Devices → Add device_ creates a token for that one client; pass it as `Authorization: Bearer <token>`, or as `?token=<token>` when the client cannot set headers. A new device token has full access; lower it in _Devices_ if the client needs less. Revoking it cuts off that client only.

Whatever the level, messages sent through Kebab House — e-mail (Gmail), Slack, Google Chat, LinkedIn, WhatsApp — wait for your approval on a signed page outside the chat. Content from outside (web pages, e-mails, messages) reaches the model labelled as data, with an instruction not to follow what it says. See [Security](SECURITY.md#trust-model).

## Client by client

| Client                                     | Support    | How to connect                                                                                                        | Interactive cards |
| ------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Claude** (web and desktop)               | Full       | _Settings → Connectors → Add custom connector_, URL only (OAuth). The dashboard's _Add to Claude_ button prefills it. | Yes               |
| **Claude Code**                            | Full       | `claude mcp add --transport http kebab-house https://<your-instance>/api/mcp` (OAuth on first use)                    | No: text only     |
| **Cursor**                                 | Full       | The dashboard's _Add to Cursor_ button, or `~/.cursor/mcp.json` with `{ "url": "…/api/mcp" }`                         | Yes               |
| **Codex**                                  | Full       | Device token, then `~/.codex/config.toml`: `[mcp_servers.kebab]`, `url = "…/api/mcp"`, `bearer_token_env_var = "KEBAB_TOKEN"` | No: text only     |
| **ChatGPT**                                | Partial    | Developer mode → custom MCP connector with OAuth, web only. Write actions need a Business or Enterprise plan.         | Yes               |
| **VS Code, Windsurf, n8n, any MCP client** | Compatible | Streamable HTTP endpoint, sign-in where supported, otherwise a device token                                           | VS Code: yes      |

The full configuration snippets are in the [README](../README.md#connect-your-ai-client).

## Interactive cards (MCP Apps)

Three tools come with a card that clients supporting MCP Apps render in the conversation:

- `kebab_status`: your hub at a glance (active profile, skills, recent notes, connectors, this week's activity).
- `skills_gallery`: your skills by tag, with _Use this skill_, and the ritual templates you have not installed yet, with _Install_.
- Send previews (e-mail, Slack, Google Chat, LinkedIn, WhatsApp): recipient, account and the exact text, with a button to the signed approval page.

Clients without MCP Apps get the same content as Markdown. Nothing is lost, it is just less pretty.

## Skills in clients that ignore server instructions

claude.ai, Claude Desktop and ChatGPT do not pass the server's instructions to the model, so the model only reaches for a skill when the conversation obviously calls for it. Download the **master relay skill** from the dashboard (_Skills → Use your skills in every AI client → Master relay (.zip)_) and upload it once to the client: your rituals then trigger on their own and always load the live version from your Kebab House.

## One hat per client

In _Devices_, bind each client to a profile (for example `work` for your work laptop's Cursor, `perso` for your phone's Claude) and choose which skill tags and connectors it sees. `my_context` then returns the right profile without you saying which.
