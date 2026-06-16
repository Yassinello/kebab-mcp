import { defineTool, type ConnectorManifest } from "@/core/types";
import { notionSearchSchema, handleNotionSearch } from "./tools/notion-search";
import { notionReadSchema, handleNotionRead } from "./tools/notion-read";
import { notionCreateSchema, handleNotionCreate } from "./tools/notion-create";
import { notionUpdateSchema, handleNotionUpdate } from "./tools/notion-update";
import { notionQuerySchema, handleNotionQuery } from "./tools/notion-query";
import { notionGuide } from "./guide";
import { getConfig } from "@/core/config-facade";

export const notionConnector: ConnectorManifest = {
  id: "notion",
  label: "Notion",
  description: "Search, read, create, update, and query databases in Notion",
  guide: notionGuide,
  requiredEnvVars: ["NOTION_API_KEY"],
  testConnection: async (credentials) => {
    const key = credentials.NOTION_API_KEY;
    if (!key) return { ok: false, message: "Missing API key" };
    const res = await fetch("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${key}`, "Notion-Version": "2022-06-28" },
    });
    if (res.ok) {
      const data = (await res.json()) as { id?: string; name?: string; type?: string };
      // Phase 75 (MAUI): also surface the integration name + bot id so the
      // multi-account selector can auto-derive the saved account's display
      // name. `/v1/users/me` returns `name` = integration name, `id` = bot
      // user id. `message` is left UNCHANGED — setup-test-dispatch + other
      // callers assert against it. exactOptionalPropertyTypes: only attach
      // account_id when present.
      const accountName = data.name || "Notion integration";
      return {
        ok: true,
        message: `Connected as ${accountName} (${data.type || "bot"})`,
        account_name: accountName,
        ...(data.id ? { account_id: data.id } : {}),
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
          Authorization: `Bearer ${getConfig("NOTION_API_KEY") ?? ""}`,
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
