import { createMcpHandler } from "mcp-handler";
import { timingSafeEqual } from "crypto";
import { withLogging } from "@/lib/logging";
import { vaultWriteSchema, handleVaultWrite } from "@/tools/vault-write";
import { vaultReadSchema, handleVaultRead } from "@/tools/vault-read";
import { vaultSearchSchema, handleVaultSearch } from "@/tools/vault-search";
import { vaultListSchema, handleVaultList } from "@/tools/vault-list";
import { vaultDeleteSchema, handleVaultDelete } from "@/tools/vault-delete";
import { vaultMoveSchema, handleVaultMove } from "@/tools/vault-move";
import { saveArticleSchema, handleSaveArticle } from "@/tools/save-article";
import { handleMyContext } from "@/tools/my-context";

const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      "vault_write",
      "Create or update a note in the Obsidian vault. Handles base64 encoding, SHA resolution for updates, and optional YAML frontmatter. Pass 'sha' from a previous vault_read to skip an extra API call.",
      vaultWriteSchema,
      withLogging("vault_write", async (params) => handleVaultWrite(params))
    );

    server.tool(
      "vault_read",
      "Read a note from the Obsidian vault. Returns the markdown body, parsed frontmatter (via js-yaml), and the file SHA (reusable for vault_write updates).",
      vaultReadSchema,
      withLogging("vault_read", async (params) => handleVaultRead(params))
    );

    server.tool(
      "vault_search",
      "Full-text search across the Obsidian vault via GitHub Search API. Supports pagination with page parameter.",
      vaultSearchSchema,
      withLogging("vault_search", async (params) => handleVaultSearch(params))
    );

    server.tool(
      "vault_list",
      "List notes and folders in a vault directory. Useful for browsing the vault structure.",
      vaultListSchema,
      withLogging("vault_list", async (params) => handleVaultList(params))
    );

    server.tool(
      "vault_delete",
      "Delete a note from the Obsidian vault.",
      vaultDeleteSchema,
      withLogging("vault_delete", async (params) => handleVaultDelete(params))
    );

    server.tool(
      "vault_move",
      "Move or rename a note. Reads source, writes to new path, deletes original. Reports partial failures if delete fails after successful write.",
      vaultMoveSchema,
      withLogging("vault_move", async (params) => handleVaultMove(params))
    );

    server.tool(
      "save_article",
      "Save a web article to the vault. Fetches URL via Jina Reader (markdown extraction), adds YAML frontmatter (title, source, date, tags), writes to Veille/ folder. Max 5MB.",
      saveArticleSchema,
      withLogging("save_article", async (params) => handleSaveArticle(params))
    );

    server.tool(
      "my_context",
      "Get Yassine's personal context (role, active projects, priorities, tech stack). Reads from System/context.md in the vault.",
      {},
      withLogging("my_context", async () => handleMyContext())
    );
  },
  {
    serverInfo: {
      name: "YassMCP",
      version: "3.0.0",
    },
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

function checkAuth(request: Request): Response | null {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  if (!token) return null;

  // Check Authorization header (timing-safe)
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (bearer.length === token.length) {
      try {
        if (timingSafeEqual(Buffer.from(bearer), Buffer.from(token))) {
          return null;
        }
      } catch { /* noop */ }
    }
  }

  // Fallback: query string token (needed for Claude Desktop which embeds token in URL)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken && queryToken.length === token.length) {
    try {
      if (timingSafeEqual(Buffer.from(queryToken), Buffer.from(token))) {
        return null;
      }
    } catch { /* noop */ }
  }

  return new Response("Unauthorized", { status: 401 });
}

async function handler(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
