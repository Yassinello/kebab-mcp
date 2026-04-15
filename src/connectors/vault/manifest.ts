import { defineTool, type ConnectorManifest } from "@/core/types";
import { vaultWriteSchema, handleVaultWrite } from "./tools/vault-write";
import { vaultReadSchema, handleVaultRead } from "./tools/vault-read";
import { vaultSearchSchema, handleVaultSearch } from "./tools/vault-search";
import { vaultListSchema, handleVaultList } from "./tools/vault-list";
import { vaultDeleteSchema, handleVaultDelete } from "./tools/vault-delete";
import { vaultMoveSchema, handleVaultMove } from "./tools/vault-move";
import { saveArticleSchema, handleSaveArticle } from "./tools/save-article";
import { vaultAppendSchema, handleVaultAppend } from "./tools/vault-append";
import { vaultBatchReadSchema, handleVaultBatchRead } from "./tools/vault-batch-read";
import { vaultRecentSchema, handleVaultRecent } from "./tools/vault-recent";
import { vaultStatsSchema, handleVaultStats } from "./tools/vault-stats";
import { vaultBacklinksSchema, handleVaultBacklinks } from "./tools/vault-backlinks";
import { vaultDueSchema, handleVaultDue } from "./tools/vault-due";
import { handleMyContext } from "./tools/my-context";

export const vaultConnector: ConnectorManifest = {
  id: "vault",
  label: "Obsidian Vault",
  description: "Notes, articles, search, backlinks — via GitHub-backed Obsidian vault",
  guide: `Read, write, search, and link notes in an Obsidian vault that lives inside a GitHub repository. Every write becomes a git commit, so you get full history for free.

### Prerequisites
An Obsidian vault pushed to a **private GitHub repo** (public works too, but private is recommended for personal notes). The repo can be empty at first — MyMCP will create notes in it.

### How to get credentials
1. Go to [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens/new) and create a **fine-grained** personal access token
2. Under **Repository access**, pick _Only select repositories_ and choose your vault repo
3. Grant **Contents: Read and write** and **Metadata: Read-only**
4. Copy the token into \`GITHUB_PAT\`
5. Set \`GITHUB_REPO\` to \`owner/repo\` (e.g. \`yassine/my-vault\`)
6. Optional: override the default branch with \`GITHUB_BRANCH\` (defaults to \`main\`)

### Troubleshooting
- _404 on the repo_: the token wasn't granted access to that specific repo — edit it and add it.
- _409 conflict on write_: someone (or another sync) committed between your read and write; retry — MyMCP passes \`sha\` to handle this.
- _Search returns nothing fresh_: GitHub's search index lags by 1–2 minutes after a commit; that's normal.`,
  requiredEnvVars: ["GITHUB_PAT", "GITHUB_REPO"],
  testConnection: async (credentials) => {
    const pat = credentials.GITHUB_PAT;
    const repo = credentials.GITHUB_REPO;
    if (!pat || !repo) {
      return {
        ok: false,
        message: "Missing PAT or repo",
        detail: "Both GITHUB_PAT and GITHUB_REPO are required.",
      };
    }
    const repoNorm = repo.replace(/.*github\.com\//, "").replace(/\/+$/, "");
    const res = await fetch(`https://api.github.com/repos/${repoNorm}`, {
      headers: { Authorization: `token ${pat}`, "User-Agent": "MyMCP" },
    });
    if (res.ok) {
      const data = (await res.json()) as { full_name?: string; private?: boolean };
      return {
        ok: true,
        message: `Connected to ${data.full_name}${data.private ? " (private)" : ""}`,
      };
    }
    const errData = (await res.json().catch(() => ({}))) as { message?: string };
    return {
      ok: false,
      message: `GitHub: ${res.status}`,
      detail: errData.message || `HTTP ${res.status} from GitHub API`,
    };
  },
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
    defineTool({
      name: "vault_write",
      description:
        "Create or update a note in the Obsidian vault. Handles base64 encoding, SHA resolution for updates, and optional YAML frontmatter. Pass 'sha' from a previous vault_read to skip an extra API call.",
      schema: vaultWriteSchema,
      handler: async (args) => handleVaultWrite(args),
      destructive: true,
    }),
    defineTool({
      name: "vault_read",
      description:
        "Read a note from the Obsidian vault. Returns the markdown body, parsed frontmatter (via js-yaml), and the file SHA (reusable for vault_write updates).",
      schema: vaultReadSchema,
      handler: async (args) => handleVaultRead(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_search",
      description:
        "Full-text search across the Obsidian vault via GitHub Search API. Supports pagination with page parameter.",
      schema: vaultSearchSchema,
      handler: async (args) => handleVaultSearch(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_list",
      description:
        "List notes and folders in a vault directory. Useful for browsing the vault structure.",
      schema: vaultListSchema,
      handler: async (args) => handleVaultList(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_delete",
      description: "Delete a note from the Obsidian vault.",
      schema: vaultDeleteSchema,
      handler: async (args) => handleVaultDelete(args),
      destructive: true,
    }),
    defineTool({
      name: "vault_move",
      description:
        "Move or rename a note. Reads source, writes to new path, deletes original. Reports partial failures if delete fails after successful write.",
      schema: vaultMoveSchema,
      handler: async (args) => handleVaultMove(args),
      destructive: true,
    }),
    defineTool({
      name: "save_article",
      description:
        "Save a web article to the vault. Fetches URL via Jina Reader (markdown extraction), adds YAML frontmatter (title, source, date, tags). Auto-detects Medium URLs and uses stored session cookie to bypass paywall. Max 5MB.",
      schema: saveArticleSchema,
      handler: async (args) => handleSaveArticle(args),
      destructive: true,
    }),
    defineTool({
      name: "vault_append",
      description:
        "Append content to an existing note without rewriting it. Reads the note, appends your content with a separator, and writes back in one operation. Ideal for journals, running logs, and accumulating ideas.",
      schema: vaultAppendSchema,
      handler: async (args) => handleVaultAppend(args),
      destructive: true,
    }),
    defineTool({
      name: "vault_batch_read",
      description:
        "Read multiple notes in a single call (max 20). Returns all contents with parsed frontmatter and SHA. Perfect for weekly reviews, daily digests, or loading context from several notes at once.",
      schema: vaultBatchReadSchema,
      handler: async (args) => handleVaultBatchRead(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_recent",
      description:
        "Get the N most recently modified notes in the vault (or a specific folder). Returns paths, commit messages, and dates. Essential for weekly reviews and catching up on recent activity.",
      schema: vaultRecentSchema,
      handler: async (args) => handleVaultRecent(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_stats",
      description:
        "Get vault statistics: total notes, notes per folder, inbox count, total size. Useful for housekeeping and understanding vault structure at a glance.",
      schema: vaultStatsSchema,
      handler: async (args) => handleVaultStats(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_backlinks",
      description:
        "Find all notes that link to a given note via [[wikilinks]]. Also returns forward links from the target note. Enables graph-of-knowledge navigation.",
      schema: vaultBacklinksSchema,
      handler: async (args) => handleVaultBacklinks(args),
      destructive: false,
    }),
    defineTool({
      name: "vault_due",
      description:
        "Find notes with a 'resurface' frontmatter field whose date has passed. Supports resurface: YYYY-MM-DD (date-based) and resurface: when_relevant (always included). Use for spaced repetition, reminders, and resurfacing forgotten insights.",
      schema: vaultDueSchema,
      handler: async (args) => handleVaultDue(args),
      destructive: false,
    }),
    defineTool({
      name: "my_context",
      description:
        "Get personal context (role, active projects, priorities, tech stack). Reads from a configurable path in the vault (default: System/context.md).",
      schema: {},
      handler: async () => handleMyContext(),
      destructive: false,
    }),
  ],
};
