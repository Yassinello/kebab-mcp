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

// --- Database schema ---

export interface NotionPropertySchema {
  name: string;
  type: string;
  /** Choice names for select / multi_select / status properties. */
  options?: string[];
}

interface RawDbProperty {
  type: string;
  select?: { options?: { name: string }[] };
  multi_select?: { options?: { name: string }[] };
  status?: { options?: { name: string }[] };
}

/**
 * Fetch a database's property schema: each property's name, type, and (for
 * select/multi_select/status) its valid option names. An agent needs this to
 * supply correct values when querying or updating rows — and updatePage uses
 * it to type each property correctly.
 */
export async function getDatabaseSchema(
  tokens: AccountTokenSet,
  databaseId: string
): Promise<{ title: string; properties: NotionPropertySchema[] }> {
  const data = await notionFetch<{
    title?: NotionRichText[];
    properties?: Record<string, RawDbProperty>;
  }>(tokens, `/databases/${databaseId}`);

  const title = (data.title || []).map((t) => t.plain_text).join("") || "(untitled database)";

  const properties: NotionPropertySchema[] = Object.entries(data.properties || {}).map(
    ([name, prop]) => {
      const opts =
        prop.select?.options ?? prop.multi_select?.options ?? prop.status?.options ?? undefined;
      const schema: NotionPropertySchema = { name, type: prop.type };
      if (opts) schema.options = opts.map((o) => o.name);
      return schema;
    }
  );

  return { title, properties };
}

// --- Update page ---

/**
 * Build a Notion property-value object for a given property TYPE. This is what
 * makes select/date/status/etc. updates actually work — Notion rejects a
 * rich_text payload on a select property. The type comes from the parent
 * database's schema (getDatabaseSchema); when the type is unknown (page parent,
 * not a DB) we fall back to rich_text for strings.
 *
 * multi_select accepts a comma-separated string or is split on commas. people
 * accepts comma-separated user ids. date accepts an ISO string (or anything
 * Notion's date.start accepts).
 */
export function buildPropertyValue(
  type: string,
  value: string | number | boolean
): Record<string, unknown> {
  const str = String(value);
  switch (type) {
    case "title":
      return { title: [{ type: "text", text: { content: str } }] };
    case "rich_text":
      return { rich_text: [{ type: "text", text: { content: str } }] };
    case "number":
      return { number: typeof value === "number" ? value : Number(str) };
    case "checkbox":
      return { checkbox: typeof value === "boolean" ? value : str === "true" };
    case "select":
      return { select: { name: str } };
    case "status":
      return { status: { name: str } };
    case "multi_select":
      return {
        multi_select: str
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((name) => ({ name })),
      };
    case "date":
      return { date: { start: str } };
    case "url":
      return { url: str };
    case "email":
      return { email: str };
    case "phone_number":
      return { phone_number: str };
    case "people":
      return {
        people: str
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((id) => ({ id })),
      };
    default:
      // Unknown / unsupported type → best-effort rich_text.
      return { rich_text: [{ type: "text", text: { content: str } }] };
  }
}

/**
 * Resolve the property TYPE for each provided key from the page's parent
 * database schema. Returns a name→type map. If the page is not inside a
 * database (parent is a page/workspace) there is no schema — returns null and
 * the caller falls back to string→rich_text.
 */
async function propertyTypesForPage(
  tokens: AccountTokenSet,
  pageId: string
): Promise<Record<string, string> | null> {
  const page = await notionFetch<{ parent?: { type?: string; database_id?: string } }>(
    tokens,
    `/pages/${pageId}`
  );
  const dbId = page.parent?.type === "database_id" ? page.parent.database_id : undefined;
  if (!dbId) return null;
  const schema = await getDatabaseSchema(tokens, dbId);
  return Object.fromEntries(schema.properties.map((p) => [p.name, p.type]));
}

export async function updatePage(
  tokens: AccountTokenSet,
  pageId: string,
  properties?: Record<string, string | number | boolean>,
  appendContent?: string,
  archive?: boolean
): Promise<{ id: string; url: string }> {
  // Archive (trash) the page — terminal, so do it and return early.
  if (archive) {
    const page = await notionFetch<{ id: string; url: string }>(tokens, `/pages/${pageId}`, {
      method: "PATCH",
      body: { archived: true },
    });
    return { id: page.id, url: page.url };
  }

  // Update properties if provided — type each one from the parent DB schema so
  // select/date/status/multi_select/people land correctly.
  if (properties && Object.keys(properties).length > 0) {
    const types = await propertyTypesForPage(tokens, pageId);
    const notionProps: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      // Known type from schema wins. Without a schema (page parent), infer:
      // booleans → checkbox, numbers → number, strings → rich_text. The
      // special key "title" always maps to the title property.
      let type = types?.[key];
      if (!type) {
        if (key.toLowerCase() === "title") type = "title";
        else if (typeof value === "boolean") type = "checkbox";
        else if (typeof value === "number") type = "number";
        else type = "rich_text";
      }
      notionProps[key] = buildPropertyValue(type, value);
    }

    await notionFetch(tokens, `/pages/${pageId}`, {
      method: "PATCH",
      body: { properties: notionProps },
    });
  }

  // Append content if provided — same markdown→blocks builder as createPage
  // so appended content gets headings/lists/checkboxes/code, not flat text.
  if (appendContent) {
    const children = markdownToBlocks(appendContent);
    if (children.length > 0) {
      await notionFetch(tokens, `/blocks/${pageId}/children`, {
        method: "PATCH",
        body: { children },
      });
    }
  }

  // Return page info
  const page = await notionFetch<{ id: string; url: string }>(tokens, `/pages/${pageId}`);
  return { id: page.id, url: page.url };
}

// --- Markdown → Notion blocks ---
//
// Inverse of the readPage() switch above (heading_1/2/3, paragraph,
// bulleted_list_item, numbered_list_item, to_do, code, divider). Keeping the
// two in lockstep means content written by notion_create / notion_update and
// then read back by notion_read round-trips without surprises. Inline marks
// (bold/italic/links) are intentionally NOT parsed — readPage flattens them
// too, so a single rich_text run per block keeps write/read symmetric.

function richText(content: string) {
  return content ? [{ type: "text" as const, text: { content } }] : [];
}

function block(type: string, payload: Record<string, unknown>) {
  return { object: "block" as const, type, [type]: payload };
}

/**
 * Parse a markdown string into Notion block objects. Recognizes the same
 * constructs readPage() emits:
 *   #/##/### → heading_1/2/3 · - → bulleted_list_item · 1. → numbered_list_item
 *   [ ]/[x] → to_do (checked) · ```lang fenced → code · --- → divider
 *   blank-line-separated runs → paragraph
 * Anything unrecognized falls through to a paragraph.
 */
export function markdownToBlocks(md: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    if (text) blocks.push(block("paragraph", { rich_text: richText(text) }));
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Fenced code block — consume until the closing ``` (mirrors readPage's
    // ```lang\n…\n``` emission).
    const fence = trimmed.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1] || "plain text";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // skip the closing fence
      blocks.push(block("code", { rich_text: richText(code.join("\n")), language }));
      continue;
    }

    // Blank line → paragraph boundary.
    if (trimmed === "") {
      flushParagraph();
      i++;
      continue;
    }

    // Divider.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push(block("divider", {}));
      i++;
      continue;
    }

    // Headings (1–3; readPage only emits up to ###).
    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      blocks.push(block(`heading_${level}`, { rich_text: richText(heading[2]!.trim()) }));
      i++;
      continue;
    }

    // Checkbox (to_do) — `[ ] text` / `[x] text`, optionally as a `- [ ]` list.
    const todo = trimmed.match(/^(?:[-*]\s+)?\[([ xX])\]\s+(.*)$/);
    if (todo) {
      flushParagraph();
      blocks.push(
        block("to_do", {
          rich_text: richText(todo[2]!.trim()),
          checked: todo[1]!.toLowerCase() === "x",
        })
      );
      i++;
      continue;
    }

    // Bulleted list item.
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push(block("bulleted_list_item", { rich_text: richText(bullet[1]!.trim()) }));
      i++;
      continue;
    }

    // Numbered list item.
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      blocks.push(block("numbered_list_item", { rich_text: richText(numbered[1]!.trim()) }));
      i++;
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  return blocks;
}

// --- Parent type detection ---
//
// notion_create accepts a parent id that may be a PAGE or a DATABASE. Notion's
// POST /pages needs `parent:{page_id}` vs `{database_id}` accordingly. We probe
// the object: GET /pages/<id> first (the common case — sub-page under a page),
// then GET /databases/<id>. A 404 on both means the id is wrong or not shared
// with the integration.

export type NotionParentKind = "page" | "database";

export async function detectParentType(
  tokens: AccountTokenSet,
  id: string
): Promise<NotionParentKind> {
  try {
    await notionFetch(tokens, `/pages/${id}`);
    return "page";
  } catch {
    // fall through to database probe
  }
  try {
    await notionFetch(tokens, `/databases/${id}`);
    return "database";
  } catch {
    throw new Error(
      `Notion parent ${id} is neither a page nor a database reachable by this integration. ` +
        `Check the ID and that the page/database is shared with the integration (… → Connections).`
    );
  }
}

// --- Create page ---

export async function createPage(
  tokens: AccountTokenSet,
  opts: {
    parentId: string;
    title: string;
    content?: string | undefined;
    /**
     * Optional override. When omitted, the parent kind is auto-detected
     * (detectParentType) so callers can pass any page OR database id without
     * knowing which it is — the common case for an agent given a URL.
     */
    parentType?: NotionParentKind | undefined;
  }
): Promise<{ id: string; url: string }> {
  const children = opts.content ? markdownToBlocks(opts.content) : [];

  const kind = opts.parentType ?? (await detectParentType(tokens, opts.parentId));
  const parent = kind === "page" ? { page_id: opts.parentId } : { database_id: opts.parentId };

  const data = await notionFetch<{ id: string; url: string }>(tokens, "/pages", {
    method: "POST",
    body: {
      parent,
      // Notion accepts properties.title.title[...] for both page and database
      // parents; only the `parent` form differs.
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
