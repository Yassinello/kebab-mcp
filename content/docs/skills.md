---
title: Authoring skills
summary: Create reusable prompt templates exposed as MCP tools and prompts
order: 30
---

## What a skill is

A **skill** is a user-authored prompt template stored in MyMCP and exposed to your AI client as both an MCP `prompt` and an MCP `tool`. Use skills to package recurring instructions ("draft a weekly status report from these inputs", "summarize a research paper into 5 bullets") so you can invoke them by name instead of pasting the same prompt every time.

Skills appear under their `skill_<name>` tool name in your MCP client, and as named prompts in clients that support the prompts primitive (Claude Desktop, Claude Code).

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

- **Name**: slug (lowercase, dashes). Becomes the tool name `skill_<name>`.
- **Description**: one-line summary the LLM sees when picking which tool to call. Be precise — vague descriptions get ignored.
- **Source**: the prompt body. Use `{{var_name}}` mustache placeholders for arguments.
- **Arguments**: typed inputs. Each has a name, description, and required flag.

## Inline vs remote skills

- **Inline**: source lives in MyMCP's KV store. Edit anytime from `/config → Skills`.
- **Remote**: source is fetched from a URL on each invocation (with caching). Useful for sharing skills across deployments — point at a raw GitHub URL or a `skills.sh` skill page.

## Importing a skill from a URL

`/config → Skills → Import from URL`. Paste a raw GitHub markdown URL or a `skills.sh` skill page. MyMCP fetches it (with byte cap and SSRF protection), parses the frontmatter into a skill definition, and shows a preview before saving.

## Skill Composer

`/config → Skills → Compose` opens a visual wizard that creates a skill by wrapping an existing tool:

1. **Pick a tool** — search and select from all registered tools.
2. **Configure arguments** — for each field in the tool's schema, either pre-fill a value or mark it as a `{{placeholder}}` that callers provide at invocation time.
3. **Set metadata** — name, description, optional tags.
4. **Preview and save** — review the generated skill content and create it.

The composer is the fastest way to create "shortcut" skills that call a tool with pre-filled defaults while exposing only the fields the user needs to change.

## Tips

- Keep the source short. Skills are templates, not whole conversations.
- Use clear argument names — they show up in the MCP tool input schema and the LLM has to pick them.
- Test in your client: invoke `skill_<name>` with sample inputs and watch the rendered output.
