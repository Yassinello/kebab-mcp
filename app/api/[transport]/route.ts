import { createMcpHandler } from "mcp-handler";
import { vaultWriteSchema, handleVaultWrite } from "@/tools/vault-write";
import { vaultReadSchema, handleVaultRead } from "@/tools/vault-read";
import { vaultSearchSchema, handleVaultSearch } from "@/tools/vault-search";
import { vaultListSchema, handleVaultList } from "@/tools/vault-list";
import { handleMyContext } from "@/tools/my-context";

const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      "vault_write",
      "Create or update a note in the Obsidian vault. Handles base64 encoding, SHA resolution for updates, and optional YAML frontmatter.",
      vaultWriteSchema,
      async (params) => handleVaultWrite(params)
    );

    server.tool(
      "vault_read",
      "Read a note from the Obsidian vault. Returns the markdown body and parsed frontmatter.",
      vaultReadSchema,
      async (params) => handleVaultRead(params)
    );

    server.tool(
      "vault_search",
      "Full-text search across the Obsidian vault. Returns matching notes with text excerpts.",
      vaultSearchSchema,
      async (params) => handleVaultSearch(params)
    );

    server.tool(
      "vault_list",
      "List notes and folders in a vault directory. Useful for browsing the vault structure.",
      vaultListSchema,
      async (params) => handleVaultList(params)
    );

    server.tool(
      "my_context",
      "Get Yassine's personal context (role, active projects, priorities, tech stack). Reads from System/context.md in the vault.",
      {},
      async () => handleMyContext()
    );
  },
  {
    serverInfo: {
      name: "YassMCP",
      version: "1.0.0",
    },
  },
  {
    basePath: "/api",
    maxDuration: 30,
  }
);

function checkAuth(request: Request): Response | null {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return null; // No auth configured = allow (dev mode)

  // Check Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    if (bearer === token) return null;
  }

  // Check query param as fallback (for MCP clients that don't support headers)
  const url = new URL(request.url);
  if (url.searchParams.get("token") === token) return null;

  console.log("[YassMCP Auth] rejected — token configured:", !!token, "authHeader:", authHeader ? "present" : "missing");
  return new Response("Unauthorized", { status: 401 });
}

async function handler(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
