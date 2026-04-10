import type { PackManifest } from "@/core/types";
import { vaultWriteSchema, handleVaultWrite } from "./tools/vault-write";
import { vaultReadSchema, handleVaultRead } from "./tools/vault-read";
import { vaultSearchSchema, handleVaultSearch } from "./tools/vault-search";
import { vaultListSchema, handleVaultList } from "./tools/vault-list";
import { vaultDeleteSchema, handleVaultDelete } from "./tools/vault-delete";
import { vaultMoveSchema, handleVaultMove } from "./tools/vault-move";
import { saveArticleSchema, handleSaveArticle } from "./tools/save-article";
import { readPaywalledSchema, handleReadPaywalled } from "./tools/read-paywalled";
import { vaultAppendSchema, handleVaultAppend } from "./tools/vault-append";
import { vaultBatchReadSchema, handleVaultBatchRead } from "./tools/vault-batch-read";
import { vaultRecentSchema, handleVaultRecent } from "./tools/vault-recent";
import { vaultStatsSchema, handleVaultStats } from "./tools/vault-stats";
import { vaultBacklinksSchema, handleVaultBacklinks } from "./tools/vault-backlinks";
import { vaultDueSchema, handleVaultDue } from "./tools/vault-due";
import { handleMyContext } from "./tools/my-context";

export const vaultPack: PackManifest = {
  id: "vault",
  label: "Obsidian Vault",
  description: "Notes, articles, search, backlinks — via GitHub-backed Obsidian vault",
  requiredEnvVars: ["GITHUB_PAT", "GITHUB_REPO"],
  diagnose: async () => {
    try {
      const repo = process.env.GITHUB_REPO;
      const pat = process.env.GITHUB_PAT;
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Authorization: `token ${pat}` },
      });
      if (res.ok) return { ok: true, message: `Connected to ${repo}` };
      return { ok: false, message: `GitHub API ${res.status}: cannot access ${repo}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach GitHub" };
    }
  },
  tools: [
    {
      name: "vault_write",
      description:
        "Create or update a note in the Obsidian vault. Handles base64 encoding, SHA resolution for updates, and optional YAML frontmatter. Pass 'sha' from a previous vault_read to skip an extra API call.",
      schema: vaultWriteSchema,
      handler: async (params) =>
        handleVaultWrite(
          params as {
            path: string;
            content: string;
            message?: string;
            frontmatter?: Record<string, unknown>;
            sha?: string;
          }
        ),
    },
    {
      name: "vault_read",
      description:
        "Read a note from the Obsidian vault. Returns the markdown body, parsed frontmatter (via js-yaml), and the file SHA (reusable for vault_write updates).",
      schema: vaultReadSchema,
      handler: async (params) => handleVaultRead(params as { path: string }),
    },
    {
      name: "vault_search",
      description:
        "Full-text search across the Obsidian vault via GitHub Search API. Supports pagination with page parameter.",
      schema: vaultSearchSchema,
      handler: async (params) =>
        handleVaultSearch(
          params as { query: string; folder?: string; limit?: number; page?: number }
        ),
    },
    {
      name: "vault_list",
      description:
        "List notes and folders in a vault directory. Useful for browsing the vault structure.",
      schema: vaultListSchema,
      handler: async (params) => handleVaultList(params as { folder?: string }),
    },
    {
      name: "vault_delete",
      description: "Delete a note from the Obsidian vault.",
      schema: vaultDeleteSchema,
      handler: async (params) => handleVaultDelete(params as { path: string; message?: string }),
    },
    {
      name: "vault_move",
      description:
        "Move or rename a note. Reads source, writes to new path, deletes original. Reports partial failures if delete fails after successful write.",
      schema: vaultMoveSchema,
      handler: async (params) =>
        handleVaultMove(params as { from: string; to: string; message?: string }),
    },
    {
      name: "save_article",
      description:
        "Save a web article to the vault. Fetches URL via Jina Reader (markdown extraction), adds YAML frontmatter (title, source, date, tags). Auto-detects Medium URLs and uses stored session cookie to bypass paywall. Max 5MB.",
      schema: saveArticleSchema,
      handler: async (params) =>
        handleSaveArticle(
          params as { url: string; title?: string; tags?: string[]; folder?: string }
        ),
    },
    {
      name: "read_paywalled",
      description:
        "Read a paywalled article (Medium, etc.) and return its full markdown content. Uses stored session cookies to access premium content. Does NOT save to vault — use save_article for that, or vault_write manually after analysis.",
      schema: readPaywalledSchema,
      handler: async (params) => handleReadPaywalled(params as { url: string }),
    },
    {
      name: "vault_append",
      description:
        "Append content to an existing note without rewriting it. Reads the note, appends your content with a separator, and writes back in one operation. Ideal for journals, running logs, and accumulating ideas.",
      schema: vaultAppendSchema,
      handler: async (params) =>
        handleVaultAppend(params as { path: string; content: string; separator?: string }),
    },
    {
      name: "vault_batch_read",
      description:
        "Read multiple notes in a single call (max 20). Returns all contents with parsed frontmatter and SHA. Perfect for weekly reviews, daily digests, or loading context from several notes at once.",
      schema: vaultBatchReadSchema,
      handler: async (params) => handleVaultBatchRead(params as { paths: string[] }),
    },
    {
      name: "vault_recent",
      description:
        "Get the N most recently modified notes in the vault (or a specific folder). Returns paths, commit messages, and dates. Essential for weekly reviews and catching up on recent activity.",
      schema: vaultRecentSchema,
      handler: async (params) =>
        handleVaultRecent(params as { n?: number; folder?: string; since?: string }),
    },
    {
      name: "vault_stats",
      description:
        "Get vault statistics: total notes, notes per folder, inbox count, total size. Useful for housekeeping and understanding vault structure at a glance.",
      schema: vaultStatsSchema,
      handler: async (params) => handleVaultStats(params as { folder?: string }),
    },
    {
      name: "vault_backlinks",
      description:
        "Find all notes that link to a given note via [[wikilinks]]. Also returns forward links from the target note. Enables graph-of-knowledge navigation.",
      schema: vaultBacklinksSchema,
      handler: async (params) => handleVaultBacklinks(params as { path: string }),
    },
    {
      name: "vault_due",
      description:
        "Find notes with a 'resurface' frontmatter field whose date has passed. Supports resurface: YYYY-MM-DD (date-based) and resurface: when_relevant (always included). Use for spaced repetition, reminders, and resurfacing forgotten insights.",
      schema: vaultDueSchema,
      handler: async (params) => handleVaultDue(params as { before?: string; folder?: string }),
    },
    {
      name: "my_context",
      description:
        "Get personal context (role, active projects, priorities, tech stack). Reads from a configurable path in the vault (default: System/context.md).",
      schema: {},
      handler: async () => handleMyContext(),
    },
  ],
};
