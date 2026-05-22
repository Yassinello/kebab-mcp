import type { AccountTokenSet } from "@/core/connector-accounts";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Phase 74 (MATL-02): the selected account's token set is threaded in from
 * the tool handler (which resolved it via `resolveConnectorAccount("notion",
 * …)`) instead of being read from `getConfig()` here. `notionFetch` uses the
 * account's `NOTION_API_KEY`. Missing key still throws the same plain Error
 * as before.
 */
async function notionFetch<T>(
  tokens: AccountTokenSet,
  path: string,
  opts: { method?: string | undefined; body?: unknown | undefined } = {}
): Promise<T> {
  const token = tokens.NOTION_API_KEY;
  if (!token) throw new Error("NOTION_API_KEY not configured");

  const res = await fetch(`${NOTION_API}${path}`, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Notion API ${res.status}: ${data.message || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

// --- Types ---

interface NotionRichText {
  plain_text: string;
}

interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number;
  select?: { name: string };
  multi_select?: { name: string }[];
  date?: { start: string };
  url?: string;
  email?: string;
  checkbox?: boolean;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEdited: string;
  properties: Record<string, string>;
}

// --- Helpers ---

function extractTitle(props: Record<string, NotionProperty>): string {
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && prop.title) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

function extractProperty(prop: NotionProperty): string {
  switch (prop.type) {
    case "title":
      return (prop.title || []).map((t) => t.plain_text).join("");
    case "rich_text":
      return (prop.rich_text || []).map((t) => t.plain_text).join("");
    case "number":
      return prop.number !== undefined ? String(prop.number) : "";
    case "select":
      return prop.select?.name || "";
    case "multi_select":
      return (prop.multi_select || []).map((s) => s.name).join(", ");
    case "date":
      return prop.date?.start || "";
    case "url":
      return prop.url || "";
    case "email":
      return prop.email || "";
    case "checkbox":
      return prop.checkbox ? "true" : "false";
    default:
      return "";
  }
}

// --- Search ---

export async function searchNotion(
  tokens: AccountTokenSet,
  query: string,
  limit?: number
): Promise<NotionPage[]> {
  const data = await notionFetch<{
    results: {
      id: string;
      url: string;
      last_edited_time: string;
      properties?: Record<string, NotionProperty>;
    }[];
  }>(tokens, "/search", {
    method: "POST",
    body: {
      query,
      page_size: limit || 10,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    },
  });

  return data.results.map((r) => ({
    id: r.id,
    title: r.properties ? extractTitle(r.properties) : "(untitled)",
    url: r.url,
    lastEdited: r.last_edited_time,
    properties: r.properties
      ? Object.fromEntries(
          Object.entries(r.properties)
            .map(([k, v]) => [k, extractProperty(v)])
            .filter(([, v]) => v)
        )
      : {},
  }));
}

// --- Read page content ---

export async function readPage(
  tokens: AccountTokenSet,
  pageId: string
): Promise<{ title: string; content: string }> {
  // Get page metadata
  const page = await notionFetch<{
    properties?: Record<string, NotionProperty>;
  }>(tokens, `/pages/${pageId}`);

  const title = page.properties ? extractTitle(page.properties) : "(untitled)";

  // Get page blocks (content)
  const blocks = await notionFetch<{
    results: {
      type: string;
      [key: string]: unknown;
    }[];
  }>(tokens, `/blocks/${pageId}/children?page_size=100`);

  const lines: string[] = [];
  for (const block of blocks.results) {
    const blockData = block[block.type] as { rich_text?: NotionRichText[] } | undefined;
    const text = (blockData?.rich_text || []).map((t) => t.plain_text).join("");

    switch (block.type) {
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "paragraph":
        lines.push(text);
        break;
      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;
      case "to_do": {
        const todo = block[block.type] as { checked?: boolean; rich_text?: NotionRichText[] };
        const todoText = (todo?.rich_text || []).map((t) => t.plain_text).join("");
        lines.push(`${todo?.checked ? "[x]" : "[ ]"} ${todoText}`);
        break;
      }
      case "code": {
        const code = block[block.type] as { rich_text?: NotionRichText[]; language?: string };
        const codeText = (code?.rich_text || []).map((t) => t.plain_text).join("");
        lines.push(`\`\`\`${code?.language || ""}\n${codeText}\n\`\`\``);
        break;
      }
      case "divider":
        lines.push("---");
        break;
      default:
        if (text) lines.push(text);
    }
  }

  return { title, content: lines.join("\n\n") };
}

// --- Query database ---

export async function queryDatabase(
  tokens: AccountTokenSet,
  databaseId: string,
  filter?: Record<string, string | number | boolean>,
  sort?: string,
  limit?: number
): Promise<NotionPage[]> {
  const body: Record<string, unknown> = {
    page_size: limit || 20,
  };

  // Build filter from simple key-value pairs
  if (filter && Object.keys(filter).length > 0) {
    const conditions = Object.entries(filter).map(([key, value]) => {
      if (typeof value === "boolean") {
        return { property: key, checkbox: { equals: value } };
      }
      if (typeof value === "number") {
        return { property: key, number: { equals: value } };
      }
      // Try select first, fall back to rich_text
      return {
        or: [
          { property: key, select: { equals: String(value) } },
          { property: key, rich_text: { equals: String(value) } },
          { property: key, status: { equals: String(value) } },
        ],
      };
    });

    body.filter = conditions.length === 1 ? conditions[0] : { and: conditions };
  }

  // Sort
  if (sort) {
    body.sorts = [{ property: sort, direction: "descending" }];
  } else {
    body.sorts = [{ timestamp: "last_edited_time", direction: "descending" }];
  }

  const data = await notionFetch<{
    results: {
      id: string;
      url: string;
      last_edited_time: string;
      properties?: Record<string, NotionProperty>;
    }[];
  }>(tokens, `/databases/${databaseId}/query`, {
    method: "POST",
    body,
  });

  return data.results.map((r) => ({
    id: r.id,
    title: r.properties ? extractTitle(r.properties) : "(untitled)",
    url: r.url,
    lastEdited: r.last_edited_time,
    properties: r.properties
      ? Object.fromEntries(
          Object.entries(r.properties)
            .map(([k, v]) => [k, extractProperty(v)])
            .filter(([, v]) => v)
        )
      : {},
  }));
}

// --- Update page ---

export async function updatePage(
  tokens: AccountTokenSet,
  pageId: string,
  properties?: Record<string, string | number | boolean>,
  appendContent?: string
): Promise<{ id: string; url: string }> {
  // Update properties if provided
  if (properties && Object.keys(properties).length > 0) {
    const notionProps: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === "boolean") {
        notionProps[key] = { checkbox: value };
      } else if (typeof value === "number") {
        notionProps[key] = { number: value };
      } else {
        // Try rich_text for string values — select/status are auto-detected by Notion
        notionProps[key] = {
          rich_text: [{ type: "text", text: { content: String(value) } }],
        };
      }
    }

    await notionFetch(tokens, `/pages/${pageId}`, {
      method: "PATCH",
      body: { properties: notionProps },
    });
  }

  // Append content if provided
  if (appendContent) {
    const children = appendContent
      .split("\n\n")
      .filter(Boolean)
      .map((paragraph) => ({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: paragraph } }],
        },
      }));

    await notionFetch(tokens, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children },
    });
  }

  // Return page info
  const page = await notionFetch<{ id: string; url: string }>(tokens, `/pages/${pageId}`);
  return { id: page.id, url: page.url };
}

// --- Create page ---

export async function createPage(
  tokens: AccountTokenSet,
  opts: {
    parentId: string;
    title: string;
    content?: string | undefined;
  }
): Promise<{ id: string; url: string }> {
  const children: unknown[] = [];

  if (opts.content) {
    // Split content into paragraph blocks
    for (const paragraph of opts.content.split("\n\n").filter(Boolean)) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: paragraph } }],
        },
      });
    }
  }

  const data = await notionFetch<{ id: string; url: string }>(tokens, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: opts.parentId },
      properties: {
        title: {
          title: [{ text: { content: opts.title } }],
        },
      },
      children,
    },
  });

  return { id: data.id, url: data.url };
}
