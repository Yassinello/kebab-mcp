---
title: Authoring skills
summary: One personal skills library (Agent Skills / SKILL.md) shared by every AI client
order: 30
---

## What a skill is

A **skill** is a reusable set of instructions in the open **Agent Skills** format: a `SKILL.md` (name, description, instructions) plus optional bundled files (`references/…`, `scripts/…`, templates). It is the same format Claude, ChatGPT, Codex and Claude Code use — so Kebab can be the **single library** for all your AI clients instead of copy-pasting skills into each one.

## How clients use your skills

| Channel | Clients | What to do |
|---|---|---|
| **On demand over MCP** | every client connected to Kebab | nothing — the catalogue is in Kebab's server instructions; the model calls `skill_load(name)` (and `skills_list`, `skill_read_file`) |
| **Master relay** | claude.ai, ChatGPT | upload *Master relay (.zip)* once per account (`/config → Skills → Use your skills in every AI client`). One native `kebab-house` skill whose description lists your skill names; it calls `my_context`, `skills_list`, then `skill_load`. Optional tag filter (one relay per account / hat). Re-download it when you add, rename or remove many skills |
| **Relay skill** | claude.ai, ChatGPT | upload the skill's *relay .zip* once (Skills → Upload). It triggers natively and loads the live version from Kebab — no re-upload after edits |
| **Native copy** | Claude Code, Codex | run the one-liner from `/config → Skills → Use your skills in every AI client` (pulls `/api/skills/bundle` with your MCP token, prunes removed skills, unzips into `~/.claude/skills` or `~/.codex/skills`) |
| **Resources** | clients supporting MCP skills (SEP-2640) | `skill://<name>/SKILL.md` and `skill://<name>/<file>` |

Skills also appear as MCP prompts (slash commands in Claude Desktop / Claude Code). Skills created before v0.23 — or any skill with **Also expose as a dedicated tool** ticked — additionally keep a `skill_<id>` tool; new skills don't, so 50 skills cost 3 tools instead of 50.

## Templates (rituals)

`/config → Skills → Templates` offers ready-made rituals: `remember`, `morning-brief`, `meeting-prep`, `weekly-review`, `read-later`. **Install** copies one into your library (tag `rituals`) through the regular import, so it is versioned and yours to edit. Installing again updates it in place (new version, never a duplicate) and keeps your display name and extra tags. They read your profile (`my_context`), use your notes when the vault is connected, use a calendar or email tool when the client has one, and skip what is not available. The sources live in `content/skill-templates/<name>/SKILL.md`; after editing one, run `npm run gen:skill-templates`.

## Profiles (tags)

Give skills tags (`perso`, `cadens`, …). In `/config → Devices`, open a token's scope and set **Skill tags visible to this token**: that client then only sees matching skills everywhere (list, load, prompts, resources, native bundle). Empty = every skill.

## Import & export

- **Import** (`/config → Skills → Import`): paste a `SKILL.md` or drop a `.zip` — one skill folder (e.g. exported from Claude or ChatGPT) or a library of folders. Preview shows new vs updated skills; a skill with the same name is updated (new version), never duplicated. Text files only, ≤ 30 files / 100 KB each / 512 KB per skill.
- **Export**: per skill *Download .zip* (Agent Skill) or *Download relay .zip*; *Export all* downloads the whole library (handy to commit to git).

## Anatomy

```
{
  "name": "weekly-status",
  "description": "Draft a weekly status report from raw notes",
  "source": "Write a weekly status report based on the following notes:\n\n{{notes}}\n\nFormat as: Wins, Blockers, Next.",
  "arguments": [
    { "name": "notes", "description": "Raw notes for the week", "required": true }
  ]
}
```

## Fields

- **Name**: display name. The skill's id (`weekly-review`, used by `skill_load`) is derived from it at creation.
- **Description**: one-line summary the LLM sees when picking which tool to call. Be precise — vague descriptions get ignored.
- **Source**: the prompt body. Use `{{var_name}}` mustache placeholders for arguments.
- **Arguments**: typed inputs. Each has a name, description, and required flag.

## Inline vs remote skills

- **Inline**: source lives in Kebab MCP's KV store. Edit anytime from `/config → Skills`.
- **Remote**: source is fetched from a URL on each invocation (with caching). Useful for sharing skills across deployments — point at a raw GitHub URL or a `skills.sh` skill page.

## Importing a skill from a URL

`/config → Skills → Import from URL`. Paste a raw GitHub markdown URL or a `skills.sh` skill page. Kebab MCP fetches it (with byte cap and SSRF protection), parses the frontmatter into a skill definition, and shows a preview before saving.

## Skill Composer

`/config → Skills → Compose` opens a visual wizard that creates a skill by wrapping an existing tool:

1. **Pick a tool** — search and select from all registered tools.
2. **Configure arguments** — for each field in the tool's schema, either pre-fill a value or mark it as a `{{placeholder}}` that callers provide at invocation time.
3. **Set metadata** — name, description, optional tags.
4. **Preview and save** — review the generated skill content and create it.

The composer is the fastest way to create "shortcut" skills that call a tool with pre-filled defaults while exposing only the fields the user needs to change.

## Editing a skill

Click any skill card body to open the dedicated edit page (URL: `?edit=<id>`). The page splits into two tabs:

- **Editor** — Identity (name, description, tags, dedicated-tool toggle), Instructions (prompt body or remote URL), Arguments (typed inputs with required flag), Allowed tools (governance list), **Bundled files** (references, templates, scripts — read on demand by clients).
- **Settings** — Version history with one-click rollback (covers SKILL.md, not bundled files), exports (Agent Skill `.zip`, relay `.zip`, Markdown), instance metadata, and a danger zone for delete.

Every save creates a new version. Rolling back never destroys history — it writes the old content as a new version, so you can always come back.

## Card actions

The Actions menu on each skill card groups: Edit, History, Refresh (remote skills), Sync to targets (Claude Code/local), Export as Markdown, Export as Claude Skill, and Delete. Click anywhere else on the card body to jump straight to Edit.

## Tips

- Keep the source short. Skills are templates, not whole conversations.
- Use clear argument names — they show up in the MCP tool input schema and the LLM has to pick them.
- Test in your client: invoke `skill_<name>` with sample inputs and watch the rendered output.
- Bundle a skill with `Allowed tools` to constrain which integrations it touches — useful for governance and review.
