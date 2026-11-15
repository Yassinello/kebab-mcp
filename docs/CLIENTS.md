# Connect your clients

Kebab House is one MCP endpoint, `https://<your-instance>/api/mcp`, shared by every AI client you use. Each client gets its own identity (an OAuth grant or a token), so you can give it its own profile, skill tags and connectors.

Once a client is connected, type **“Set up my Kebab House”** in it to run the guided setup (interview, profile, rituals, connectors). You can run it again at any time.

## Two ways to sign in

- **OAuth (recommended where the client supports it).** Paste the endpoint URL only. The client opens your instance's consent page; sign in to your dashboard and approve. The client is **read-only unless you tick “allow writes”** on that page. It then appears in _Devices_, where you can bind a profile or revoke it.
- **Token.** Mint a token in the dashboard (_Devices → Add device_) and pass it as `Authorization: Bearer <token>`, or as `?token=<token>` when the client cannot set headers. Tokens have write access.

## Client by client

| Client                                     | Support    | How to connect                                                                                                        | Interactive cards |
| ------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Claude** (web and desktop)               | Full       | _Settings → Connectors → Add custom connector_, URL only (OAuth). The dashboard's _Add to Claude_ button prefills it. | Yes               |
| **Claude Code**                            | Full       | `claude mcp add --transport http kebab-house https://<your-instance>/api/mcp` (OAuth on first use)                    | No: text only     |
| **Cursor**                                 | Full       | The dashboard's _Add to Cursor_ button, or `~/.cursor/mcp.json` with `{ "url": "…/api/mcp" }`                         | Yes               |
| **Codex**                                  | Full       | `~/.codex/config.toml`: `[mcp_servers.kebab]`, `url = "…/api/mcp"`, `bearer_token_env_var = "KEBAB_TOKEN"`            | No: text only     |
| **ChatGPT**                                | Partial    | Developer mode → custom MCP connector, web only. Write actions need a Business or Enterprise plan.                    | Yes               |
| **VS Code, Windsurf, n8n, any MCP client** | Compatible | Streamable HTTP endpoint, OAuth or token                                                                              | VS Code: yes      |

The full configuration snippets are in the [README](../README.md#connect-your-ai-client).

## Interactive cards (MCP Apps)

Three tools come with a card that clients supporting MCP Apps render in the conversation:

- `kebab_status`: your hub at a glance (active profile, skills, recent notes, connectors, this week's activity).
- `skills_gallery`: your skills by tag, with _Use this skill_, and the ritual templates you have not installed yet, with _Install_.
- LinkedIn and WhatsApp send previews: recipient, account and the exact text, with a button to the signed approval page.

Clients without MCP Apps get the same content as Markdown. Nothing is lost, it is just less pretty.

## Skills in clients that ignore server instructions

claude.ai, Claude Desktop and ChatGPT do not pass the server's instructions to the model, so the model only reaches for a skill when the conversation obviously calls for it. Download the **master relay skill** from the dashboard (_Skills → Use your skills in every AI client → Master relay (.zip)_) and upload it once to the client: your rituals then trigger on their own and always load the live version from your Kebab House.

## One hat per client

In _Devices_, bind each client to a profile (for example `work` for your work laptop's Cursor, `perso` for your phone's Claude) and choose which skill tags and connectors it sees. `my_context` then returns the right profile without you saying which.
