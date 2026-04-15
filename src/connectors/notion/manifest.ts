import { defineTool, type ConnectorManifest } from "@/core/types";
import { notionSearchSchema, handleNotionSearch } from "./tools/notion-search";
import { notionReadSchema, handleNotionRead } from "./tools/notion-read";
import { notionCreateSchema, handleNotionCreate } from "./tools/notion-create";
import { notionUpdateSchema, handleNotionUpdate } from "./tools/notion-update";
import { notionQuerySchema, handleNotionQuery } from "./tools/notion-query";

export const notionConnector: ConnectorManifest = {
  id: "notion",
  label: "Notion",
  description: "Search, read, create, update, and query databases in Notion",
  guide: `Search pages, read/append content, and query databases in your Notion workspace via an internal integration token.

### Prerequisites
A Notion workspace where you can install integrations. Notion integrations only see pages that have been _explicitly shared_ with them — there is no workspace-wide permission.

### How to get credentials
1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and click **New integration**
2. Pick the associated workspace, give it a name (e.g. _MyMCP_), and submit
3. Copy the **Internal Integration Token** (starts with \`secret_\` or \`ntn_\`) and set it as \`NOTION_API_KEY\`
4. Open every page or database you want MyMCP to access, click **…** → **Connections** → add your integration. Granting a parent page shares all its children.

### Troubleshooting
- _"object_not_found" or empty search_: the page/database was never shared with the integration — add it via **Connections**.
- _Cannot update properties_: property names are case-sensitive and must match the database schema exactly.
- _API version errors_: MyMCP sends \`Notion-Version: 2022-06-28\` — that's still supported.`,
  requiredEnvVars: ["NOTION_API_KEY"],
  testConnection: async (credentials) => {
    const key = credentials.NOTION_API_KEY;
    if (!key) return { ok: false, message: "Missing API key" };
    const res = await fetch("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${key}`, "Notion-Version": "2022-06-28" },
    });
    if (res.ok) {
      const data = (await res.json()) as { name?: string; type?: string };
      return {
        ok: true,
        message: `Connected as ${data.name || "Notion integration"} (${data.type || "bot"})`,
      };
    }
    const errData = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    return {
      ok: false,
      message: `Notion: ${res.status}`,
      detail: errData.message || errData.code || `HTTP ${res.status}`,
    };
  },
  diagnose: async () => {
    try {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (res.ok) return { ok: true, message: "Notion API connected" };
      return { ok: false, message: `Notion API ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach Notion" };
    }
  },
  // PILOT: defineTool() migration (v0.5 phase 12, T1). Notion was picked
  // because it has 5 tools mixing read (notion_search/read/query) and
  // write (notion_create/update), exercising both destructive flag values.
  tools: [
    defineTool({
      name: "notion_search",
      description:
        "Search Notion pages by title or content. Returns page title, URL, last edited date, and properties.",
      schema: notionSearchSchema,
      handler: async (args) => handleNotionSearch(args),
      destructive: false,
    }),
    defineTool({
      name: "notion_read",
      description:
        "Read the full content of a Notion page. Returns title and content as markdown (headings, paragraphs, lists, code blocks).",
      schema: notionReadSchema,
      handler: async (args) => handleNotionRead(args),
      destructive: false,
    }),
    defineTool({
      name: "notion_create",
      description:
        "Create a new page in a Notion database. Provide the database ID, title, and optional content.",
      schema: notionCreateSchema,
      handler: async (args) => handleNotionCreate(args),
      destructive: true,
    }),
    defineTool({
      name: "notion_update",
      description:
        "Update an existing Notion page. Can update properties (Status, Priority, etc.) and/or append content to the page body.",
      schema: notionUpdateSchema,
      handler: async (args) => handleNotionUpdate(args),
      destructive: true,
    }),
    defineTool({
      name: "notion_query",
      description:
        "Query a Notion database with optional filters and sorting. Use notion_search to find the database ID first.",
      schema: notionQuerySchema,
      handler: async (args) => handleNotionQuery(args),
      destructive: false,
    }),
  ],
};
