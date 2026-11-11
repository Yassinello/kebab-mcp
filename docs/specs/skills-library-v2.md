# Spec — Skills library v2: Kebab as the personal skills hub for every AI client

- **Status:** Implemented (v0.23)
- **Related:** [ADR 0003](../adr/0003-skills-hub-over-mcp.md)

## 1. Problem

The operator uses several AI clients (two Claude accounts, ChatGPT, Codex / Claude Code, Cadens). Skills live inside each client, so they are copy-pasted, drift apart, and accounts get split "by use case" just to keep skills apart. There is no official way to sync skills between clients: claude.ai and ChatGPT only accept manual uploads, and no mainstream client loads skills from an MCP server natively yet (SEP-2640 is final, but Claude does not implement it and ChatGPT only partially).

## 2. Goal

One library, stored in Kebab, in the open **Agent Skills** format (`SKILL.md` + bundled files), reachable from every client:

| Channel | Clients | How | Sync needed |
|---|---|---|---|
| **A. MCP on demand** | every MCP client | `skills_list` → `skill_load` → `skill_read_file`, plus a catalogue in the MCP server instructions | none |
| **B. Relay skill** | claude.ai, ChatGPT, Claude Desktop | a ~10-line native `SKILL.md` installed once per client; its description triggers natively, its body says "load the real skill from Kebab" | install once, never resync |
| **C. Native copy** | Claude Code, Codex, any folder-based agent | `curl` the authenticated bundle endpoint → unzip into `~/.claude/skills` / `~/.codex/skills` | re-run the one-liner (cron-able) |
| **D. SEP-2640 resources** | future clients | `skill://<name>/SKILL.md` and `skill://<name>/<path>` resources | none |

## 3. Non-goals (v2)

- Executing skill scripts on the Kebab server. Scripts are served as files; clients with code execution (claude.ai, ChatGPT, Claude Code) run them themselves.
- Binary assets (images, fonts). Bundled files are UTF-8 text only in v2.
- Git as the storage backend. KV stays the source of truth; zip / SKILL.md import-export keeps the library portable and git-committable.
- Programmatic upload into claude.ai / ChatGPT (no public API exists).
- Implementing the SEP-2640 custom JSON-RPC methods (`skills/list`, `skills/get`): the resource binding is enough for discovery and stays inside what `mcp-handler` supports.

## 4. Data model (backward compatible)

`Skill` gains:

| Field | Type | Default for existing skills | Default for new skills | Notes |
|---|---|---|---|---|
| `files` | `{path, size}[]` (index only) | `[]` | `[]` | Bundled UTF-8 text files, relative POSIX paths (`scripts/run.py`, `references/api.md`). **Bodies live in a separate KV key** `skill:<id>:files` (same prefix as version keys, so deleting a skill removes them) so the hot `skills:all` record (read on every MCP request) stays small. Limits: ≤ 30 files, ≤ 100 KB per file, ≤ 512 KB per skill. No `..`, no absolute paths, no backslashes, no `SKILL.md` (that is `content`). |
| `tags` | `string[]` | `[]` | `[]` | lower-case slugs, ≤ 10. Drive per-token visibility (§6) and `skills_list` filtering. |
| `exposeAsTool` | `boolean` | **`true`** (keeps today's `skill_<id>` tool) | **`false`** | Per-skill legacy tool. New skills are reached via `skill_load`, which keeps tool lists short. |

The Agent Skills `name` is derived: `id` with `_` → `-` (`meeting_prep` → `meeting-prep`). `skill_load` / `skill_read_file` accept either form. `description` stays ≤ 1024 chars on import (spec limit) — longer is truncated with a warning.

Arguments (`{{arg}}` templating) remain supported; `skill_load` renders them when passed.

## 5. MCP surface

| Tool | Behaviour |
|---|---|
| `skills_list` | `{count, skills:[{name, description, tags, files:[paths], has_arguments}]}`. Optional `tag`, `query` (accent-insensitive over name + description). Respects the token's tag scope. |
| `skill_load` | `name` (+ optional `arguments` object) → full instructions: rendered `SKILL.md` body, then a "Bundled files" list with `skill_read_file` hints. Unknown name → `{error:"skill_not_found", suggestions:[…]}`. |
| `skill_read_file` | `name`, `path` → file content. Unknown → `{error:"file_not_found", available:[…]}`. |

- **Server instructions** (MCP `initialize.instructions`): a short rule ("When a request matches one of these skills, call `skill_load` before answering") + the catalogue `name — description` (scoped, capped at 60 entries / ~8 KB; overflow points to `skills_list`).
- **Prompts**: unchanged (one MCP prompt per skill, slash commands in Claude Desktop).
- **Resources** (channel D): `skill://<name>/SKILL.md` (full file with frontmatter) and one resource per bundled file.
- Legacy `skill_<id>` tools only for skills with `exposeAsTool: true`.

## 6. Profiles (per-token tag scope)

A device token can carry `skillTags: string[]`. When set, that token only sees skills having at least one of those tags — in `skills_list`, `skill_load`, `skill_read_file`, instructions, prompts, resources and legacy tools. Absent = all skills (today's behaviour). Edited in /config → Devices next to the connector scope.

Use: "Claude perso" token → `perso`, "Cadens" token → `cadens`, ChatGPT → both.

## 7. Import / export

| Operation | Endpoint | Auth |
|---|---|---|
| Import `SKILL.md` text or `.zip` (one skill folder, or a zip of several folders) | `POST /api/config/skills/bundle-import` (preview → save) | admin |
| Export one skill as Agent Skills `.zip` (`<name>/SKILL.md` + files) | `GET /api/config/skills/[id]/export?format=zip` | admin |
| Export one **relay** skill `.zip` | `GET /api/config/skills/[id]/export?format=relay` | admin |
| Export the whole (scoped) library as `.zip` for channel C | `GET /api/skills/bundle` | **MCP token, `Authorization: Bearer` header only** (a query-string token would leak into access logs) — usable from a cron / one-liner on a laptop |

The bundle contains one folder per skill plus `.kebab-skills.json` (list of exported names). The documented one-liner uses it to delete local folders of skills removed from Kebab, without touching skills it did not install.

Import rules: frontmatter `name`/`description` required by the spec but tolerated if missing (inferred from folder / first heading, with a warning); `metadata.tags` or `tags` → tags; files outside text types skipped with a warning; existing skill with the same name → preview flags `will_update`, save creates a new version (existing versioning) instead of a duplicate.

Exported `SKILL.md` frontmatter: `name`, `description`, `metadata: {tags, source: "kebab-mcp", kebab_id, version}`, `arguments` (Kebab extension, ignored by other tools).

Relay skill body (generated):

```markdown
---
name: <name>
description: <original description>
---
This skill is stored in Kebab MCP so it stays identical across all AI clients.
Before doing anything else, call the `skill_load` tool of the Kebab MCP connector with name "<name>" and follow the returned instructions exactly.
If the Kebab connector is unavailable, say so and stop.
```

## 8. Dashboard UX (/config → Skills)

- List: tags as chips + tag filter; badges "N files", "tool"; bulk "Export all (.zip)".
- Editor: tags input; "Expose as dedicated tool" toggle with explanation; **Files** panel (list, add, rename, edit in a monospace textarea, delete, size counter vs limits).
- Import dialog: paste `SKILL.md` **or** drop a `.zip`, preview (names, files, warnings, create/update) then save.
- Per skill "Use everywhere" panel: (1) MCP: nothing to do, (2) Relay: download button + 3-step instructions per client (claude.ai, ChatGPT), (3) Native: copyable one-liners for Claude Code / Codex using the bundle endpoint.
- Devices tab: "Skill tags visible to this token" in the existing per-token scope panel (one Save for connectors + tags).
- The obsolete `.skill` JSON export is replaced by the real Agent Skills `.zip`.

## 9. Safety

- Paths normalized and validated (no traversal, no absolute, no backslashes, no hidden `..`); zip-bomb guard: ≤ 2 MB compressed upload, ≤ 5 MB inflated, ≤ 200 entries.
- Bundle endpoint: MCP-token auth, tag scope applied, rate-limited by the existing pipeline; never includes other tenants' skills.
- Imported content is treated as data: nothing is executed server-side.

## 10. Known limits (v2)

- Skill version history (existing `skill-versions`) snapshots metadata + `SKILL.md` body, **not** bundled files: a rollback keeps the current files.
- No push to clients: channel C is pull-based (re-run the one-liner, or cron it).
- Relay skills fire only if the Kebab connector is enabled in that client.

## 11. Review log

Independent code review (pre-merge) found and fixed: process-wide skills/prime caches leaking one tenant's skills to another (now tenant-keyed, stale-object fallback removed); legacy `skill_load`/`skill_read_file` name collision able to break every MCP request (ids reserved, legacy tools filtered); import updates wiping existing files/tags (now kept, with preview warnings); zip64 entry-count DoS (filter throws); bundle endpoint accepting `?token=` (header only); tag scope failing open on KV errors (now closed); scope re-checked on fresh content in legacy tools/prompts; duplicate names in one import; `skills_list` tag normalization.

Spec self-review before implementation changed: file bodies moved out of `skills:all` (KV value size + per-request latency); bundle auth restricted to the Authorization header; `.kebab-skills.json` manifest added so native sync can prune removed skills; versioning limit made explicit.

## 12. Acceptance criteria

1. Existing skills keep working unchanged (tool, prompt, export) after upgrade with no migration step.
2. A skill imported from a standard Agent Skills zip (with `scripts/` and `references/`) round-trips: import → export zip → byte-identical `SKILL.md` body and files.
3. From a fresh MCP client: `skills_list` → `skill_load` → `skill_read_file` works; the instructions contain the catalogue.
4. A token with `skillTags: ["cadens"]` cannot list, load or read a `perso` skill, nor get it in the bundle.
5. `curl -H "Authorization: Bearer <MCP token>" <url>/api/skills/bundle -o s.zip && unzip -o s.zip -d ~/.claude/skills` yields one folder per skill with a valid `SKILL.md`.
6. Typecheck, lint, knip, unit, registry, contract, doc-counts, build green.
