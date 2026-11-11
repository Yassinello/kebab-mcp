# ADR 0003 — Kebab as the skills hub: Agent Skills format, served over MCP, relayed natively

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Yassine (Founder)
- **Scope:** `src/connectors/skills/` (v0.23) — see [spec](../specs/skills-library-v2.md)

## Context

The operator runs several AI clients (two Claude accounts, ChatGPT, Codex / Claude Code, Cadens) and wants one skills library instead of per-client copies. State of the art (Nov 2026):

- `SKILL.md` (Agent Skills) is the de-facto cross-vendor format (~40 clients, ChatGPT included).
- MCP SEP-2640 (skills over MCP, resource binding) is final, but no Claude product implements the client side and ChatGPT only partially.
- claude.ai and ChatGPT accept skills only by manual upload; no programmatic API for personal accounts. Community sync tools (skillshare, git + symlinks) cover file-based agents only.

Kebab's v1 skills were flat prompt templates, each exposed as its own `skill_<id>` tool — not the standard format, and tool-list bloat at scale.

## Options

| Option | Reach today | Native auto-trigger | Sync burden | Verdict |
|---|---|---|---|---|
| Copy skills into every client | all | ✅ | high, manual for claude.ai / ChatGPT | status quo, what we leave |
| Pure SEP-2640 | future clients only | ✅ (when shipped) | none | too early alone |
| Tool-based loading over MCP (`skills_list` / `skill_load`) | every MCP client | ⚠️ model must decide to load | none | **base layer** |
| + Relay skills (native stub → `skill_load`) | claude.ai, ChatGPT, Desktop | ✅ | install once | **for high-value skills** |
| + Bundle pull for folder agents | Claude Code, Codex | ✅ | one-liner / cron | **for coding agents** |
| Git repo as storage backend | — | — | — | deferred: zip/SKILL.md export keeps it git-committable without coupling Kebab to a repo |

## Decision

Store skills in Kebab in the Agent Skills shape (SKILL.md body + bundled text files + tags), and distribute through four channels: MCP on-demand tools, relay skills, an authenticated bundle endpoint, and SEP-2640-style `skill://` resources for forward compatibility. Per-token tag scopes replace "one client account per use case".

## Consequences

- One edit propagates instantly to every client using channels A, B and D; channel C needs a pull.
- Existing skills are untouched (`exposeAsTool` defaults to true for them); new skills stop adding tools.
- Scripts are served, not executed by Kebab; clients with code execution run them.
- When Claude / ChatGPT ship SEP-2640 client support, channel D works without changes and relay skills become optional.
