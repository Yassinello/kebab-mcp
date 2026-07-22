import type { AccountTokenSet } from "@/core/connector-accounts";
import { toMsg } from "@/core/error-utils";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// --- API limits (v0.21) ---
//
// Hard limits imposed by Notion, not by us. Exceeding any of them is a 400,
// so the write path has to chunk/split rather than hope for the best:
//   · 100 block children per append request
//   · 2000 characters per rich_text run
//   · ~3 requests/second average (429 + Retry-After when exceeded)
// Read bounds (MAX_PAGE_BLOCKS / MAX_CHILD_DEPTH) are OURS — generous
// defaults per the project's "generous defaults over tight defaults +
// per-caller exceptions" preference. When either is hit, readPage emits an
// explicit truncation marker instead of silently stopping (NREAD-03).

/** Max block children Notion accepts in a single append request. */
export const MAX_BLOCKS_PER_REQUEST = 100;
/** Max characters in a single rich_text run. */
export const MAX_RICH_TEXT_LENGTH = 2000;
/** Safety bound on how many blocks readPage will pull for one page. */
export const MAX_PAGE_BLOCKS = 5000;

/**
 * Ceiling on how many top-level blocks `replace_content` will delete.
 *
 * This is a WALL-CLOCK bound, not a correctness one. Notion has no batch
 * delete, so replacing a page costs one request per block against a ~3 req/s
 * budget: ~200 blocks already takes ~68s, and the MCP transport route runs
 * under `maxDuration = 90` (silently clamped to 60s on Vercel Hobby). Past
 * that the lambda is killed MID-DELETE — the page is left half-cleared and the
 * caller never even receives the error explaining the blocks are in the trash.
 *
 * 150 keeps the whole operation inside the 60s floor with headroom for a
 * retry. Refusing up front is strictly better than a truncated massacre: the
 * page is untouched and the message says what to do.
 */
export const MAX_REPLACE_BLOCKS = 150;
/** How deep readPage recurses into blocks that have children. */
export const MAX_CHILD_DEPTH = 5;

/** Retry budget for 429 / 529 responses. */
const MAX_RETRIES = 4;
/** Fallback backoff when a 429 carries no (or an unparseable) Retry-After. */
const DEFAULT_RETRY_MS = 1000;
/** Upper bound on any single backoff wait, so a hostile header can't hang us. */
const MAX_RETRY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `Retry-After`. Notion sends seconds; the HTTP spec also allows an
 * HTTP-date, so both are handled. Returns null when absent/unparseable so the
 * caller falls back to exponential backoff.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_MS);
  return null;
}

/**
 * Phase 74 (MATL-02): the selected account's token set is threaded in from
 * the tool handler (which resolved it via `resolveConnectorAccount("notion",
 * …)`) instead of being read from `getConfig()` here. `notionFetch` uses the
 * account's `NOTION_API_KEY`. Missing key still throws the same plain Error
 * as before.
 *
 * v0.21 (NWRITE-07): retries 429 (rate_limited) and 529 (service_overload).
 * `replace_content` issues one DELETE per block against a ~3 req/s budget, so
 * hitting 429 mid-run is expected, not exceptional — without this the page
 * would be left half-deleted. Other statuses still throw on the first
 * response, preserving the previous error shape.
 */
async function notionFetch<T>(
  tokens: AccountTokenSet,
  path: string,
  opts: { method?: string | undefined; body?: unknown | undefined } = {}
): Promise<T> {
  const token = tokens.NOTION_API_KEY;
  if (!token) throw new Error("NOTION_API_KEY not configured");

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${NOTION_API}${path}`, {
      method: opts.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });

    if (res.ok) return res.json() as Promise<T>;

    const data = (await res.json().catch(() => ({}))) as { message?: string };
    lastError = `Notion API ${res.status}: ${data.message || res.statusText}`;

    // A 400 on a block-write is almost always a payload the API rejects: a
    // block shape that differs on this API version, an out-of-enum value, or
    // nesting past the 2-level limit. Notion's message alone ("body failed
    // validation") doesn't say which block, so name the request that failed —
    // this is the failure mode most likely to surface on a Notion-Version bump.
    if (res.status === 400 && opts.method && opts.method !== "GET") {
      lastError += ` — while ${opts.method} ${path}. If this started after an API-version change, check the block shapes (callout/toggle/table), enum values (color, code language), and that no payload nests more than 2 levels.`;
    }

    const retryable = res.status === 429 || res.status === 529;
    if (!retryable || attempt === MAX_RETRIES) throw new Error(lastError);

    // `headers` may be absent on hand-rolled test doubles — treat as no hint.
    const header = typeof res.headers?.get === "function" ? res.headers.get("Retry-After") : null;
    const wait = parseRetryAfter(header) ?? Math.min(DEFAULT_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
    await sleep(wait);
  }

  // Unreachable: the loop either returns or throws.
  throw new Error(lastError);
}

// --- Types ---

interface NotionAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

interface NotionRichText {
  plain_text: string;
  annotations?: NotionAnnotations;
  href?: string | null;
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

/**
 * Appended to a page's markdown when a read bound cut it short. Deliberately
 * free of inline-mark characters so it round-trips as plain text, and
 * recognized by markdownToBlocks so an edited read isn't written back into
 * the page as content.
 */
export const TRUNCATION_MARKER =
  "[Kebab: page truncated at the read bound — content below this point was not read.]";

/**
 * Prefix of the warning `notion_read` puts ABOVE a truncated page. Like
 * TRUNCATION_MARKER it is a read-side annotation, so markdownToBlocks drops it
 * — otherwise a read → edit → replace_content cycle would write our own
 * warning into the user's page as a paragraph.
 */
export const TRUNCATION_WARNING_PREFIX = "> WARNING: this page was only partially read";

/** A block as returned by Notion, with the fields readPage cares about. */
interface RawBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface BlockPage {
  results: RawBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * Fetch ONE page of a block's children. Notion caps page_size at 100 and
 * returns only the FIRST level — children of children need their own call
 * (see fetchBlockTree).
 */
async function fetchChildrenPage(
  tokens: AccountTokenSet,
  blockId: string,
  cursor?: string
): Promise<BlockPage> {
  const qs = new URLSearchParams({ page_size: String(MAX_BLOCKS_PER_REQUEST) });
  if (cursor) qs.set("start_cursor", cursor);
  return notionFetch<BlockPage>(tokens, `/blocks/${blockId}/children?${qs.toString()}`);
}

/**
 * Fetch every child of `blockId`, following `next_cursor` to exhaustion
 * (NREAD-01). `budget` is shared across the whole tree walk so a pathological
 * page can't fan out into thousands of requests; when it runs out we stop and
 * the caller reports truncation rather than pretending the page ended.
 */
async function fetchAllChildren(
  tokens: AccountTokenSet,
  blockId: string,
  budget: { remaining: number; truncated: boolean }
): Promise<RawBlock[]> {
  const out: RawBlock[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page: BlockPage = await fetchChildrenPage(tokens, blockId, cursor);

    for (let i = 0; i < page.results.length; i++) {
      if (budget.remaining <= 0) {
        // Blocks remain in THIS page that we're dropping — genuine truncation.
        budget.truncated = true;
        return out;
      }
      budget.remaining--;
      out.push(page.results[i]!);
    }

    if (!page.has_more) return out;

    // has_more with no cursor: Notion says there is more but gives us no way
    // to ask for it. Treat as truncation, never as a clean end — otherwise
    // deleteAllBlocks would believe it saw the whole page and replace_content
    // would leave orphaned blocks above the new content.
    if (!page.next_cursor) {
      budget.truncated = true;
      return out;
    }

    // Budget exhausted exactly at a page boundary AND more pages exist: the
    // next page would be dropped, so this IS truncation. (When has_more is
    // false we returned above, so an exact-fit page is not falsely flagged.)
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return out;
    }

    cursor = page.next_cursor;
  }
}

/** A block plus its recursively-fetched children. */
interface BlockNode {
  block: RawBlock;
  children: BlockNode[];
}

/**
 * Walk the block tree depth-first (NREAD-02). Only blocks flagged
 * `has_children` are descended into, so the number of requests stays
 * proportional to the number of parent blocks — not to the block count
 * (NREAD-04). Depth is bounded by MAX_CHILD_DEPTH; hitting it flips the
 * truncation flag instead of silently flattening.
 */
async function fetchBlockTree(
  tokens: AccountTokenSet,
  blockId: string,
  depth: number,
  budget: { remaining: number; truncated: boolean }
): Promise<BlockNode[]> {
  const blocks = await fetchAllChildren(tokens, blockId, budget);
  const nodes: BlockNode[] = [];

  for (const block of blocks) {
    let children: BlockNode[] = [];
    if (block.has_children) {
      if (depth < MAX_CHILD_DEPTH) {
        children = await fetchBlockTree(tokens, block.id, depth + 1, budget);
      } else {
        budget.truncated = true;
      }
    }
    nodes.push({ block, children });
  }

  return nodes;
}

function plain(rt: NotionRichText[] | undefined): string {
  return (rt || []).map((t) => t.plain_text).join("");
}

/**
 * Render one block as markdown. Returns null for blocks with no textual
 * representation. Kept in lockstep with markdownToBlocks() — that symmetry is
 * the connector's read/write contract (see the markdownToBlocks comment).
 */
function renderBlock(block: RawBlock): string | null {
  const payload = block[block.type] as
    | {
        rich_text?: NotionRichText[];
        checked?: boolean;
        language?: string;
        icon?: { type?: string; emoji?: string; external?: { url?: string } };
        color?: string;
        caption?: NotionRichText[];
        url?: string;
        external?: { url?: string };
        file?: { url?: string };
        has_column_header?: boolean;
        cells?: NotionRichText[][];
      }
    | undefined;
  const text = renderRichText(payload?.rich_text);

  switch (block.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "paragraph":
      return text;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `${payload?.checked ? "[x]" : "[ ]"} ${text}`;
    case "code":
      // Code is opaque: emit the raw text, no inline marks.
      return `\`\`\`${payload?.language || ""}\n${plain(payload?.rich_text)}\n\`\`\``;
    case "divider":
      return "---";

    // --- v0.21 rich blocks (NRICH-01..04) ---
    case "callout": {
      // `> [!icon] text` — the icon slot carries the emoji so the writer can
      // reproduce it. Colors round-trip via a trailing attribute.
      const emoji = payload?.icon?.emoji || "";
      const color = payload?.color && payload.color !== "default" ? ` {${payload.color}}` : "";
      return `> [!${emoji}] ${text}${color}`;
    }
    case "toggle":
      // Children are rendered by renderTree as indented blocks underneath.
      return `<details> ${text}`;
    case "image":
    case "embed":
    case "bookmark": {
      const url = payload?.url || payload?.external?.url || payload?.file?.url || "";
      if (!url) return null;
      const caption = renderRichText(payload?.caption);
      if (block.type === "image") return `![${caption}](${url})`;
      if (block.type === "bookmark") return `[bookmark](${url})`;
      return `[embed](${url})`;
    }
    case "table":
      // The table itself renders nothing; its table_row children carry the
      // cells and are emitted by renderTree.
      return null;
    case "table_row": {
      // Escape pipes inside a cell, otherwise the rendered row re-parses with
      // more columns than the table actually has.
      const cells = (payload?.cells || []).map((cell) =>
        renderRichText(cell).replace(/\|/g, "\\|")
      );
      return `| ${cells.join(" | ")} |`;
    }

    default:
      return text || null;
  }
}

/** Indent every line of a rendered block so nesting survives in markdown. */
function indent(text: string, level: number): string {
  if (level <= 0) return text;
  const pad = "  ".repeat(level);
  return text
    .split("\n")
    .map((line) => (line ? `${pad}${line}` : line))
    .join("\n");
}

/**
 * Render a table as one markdown block. Tables are special-cased because a
 * markdown table only parses when its rows are contiguous and unindented —
 * feeding table_row through the generic indent path would break it.
 */
function renderTable(node: BlockNode): string | null {
  const rowNodes = node.children.filter((child) => child.block.type === "table_row");
  const rows = rowNodes
    .map((child) => renderBlock(child.block))
    .filter((line): line is string => line !== null);

  if (rows.length === 0) return null;

  const table = node.block[node.block.type] as { has_column_header?: boolean } | undefined;
  if (!table?.has_column_header) return rows.join("\n");

  // Column count comes from the first row's actual cell array — counting `|`
  // in the rendered string would over-count whenever a cell contains a pipe,
  // and the wrong separator width makes the re-parsed table_width disagree
  // with the row cell counts (which Notion rejects).
  const firstRow = rowNodes[0]!.block[rowNodes[0]!.block.type] as
    | { cells?: NotionRichText[][] }
    | undefined;
  const columns = Math.max(firstRow?.cells?.length ?? 1, 1);
  const separator = `|${" --- |".repeat(columns)}`;
  return [rows[0]!, separator, ...rows.slice(1)].join("\n");
}

function renderTree(nodes: BlockNode[], level: number, out: string[]): void {
  for (const node of nodes) {
    if (node.block.type === "table") {
      const table = renderTable(node);
      if (table !== null) out.push(indent(table, level));
      continue;
    }
    const rendered = renderBlock(node.block);
    if (rendered !== null) out.push(indent(rendered, level));
    if (node.children.length > 0) renderTree(node.children, level + 1, out);
  }
}

export async function readPage(
  tokens: AccountTokenSet,
  pageId: string
): Promise<{ title: string; content: string; truncated: boolean }> {
  // Get page metadata
  const page = await notionFetch<{
    properties?: Record<string, NotionProperty>;
  }>(tokens, `/pages/${pageId}`);

  const title = page.properties ? extractTitle(page.properties) : "(untitled)";

  // v0.21 (NREAD-01/02): the previous implementation issued a single
  // `?page_size=100` request and rendered only the first level, so any page
  // over 100 blocks was silently cut and every nested block (toggles, list
  // children, columns) was invisible. Both were silent data loss — no error,
  // no marker. Now: follow next_cursor to exhaustion and descend into
  // has_children.
  const budget = { remaining: MAX_PAGE_BLOCKS, truncated: false };
  const tree = await fetchBlockTree(tokens, pageId, 0, budget);

  const lines: string[] = [];
  renderTree(tree, 0, lines);

  // NREAD-03: never stop silently. The marker is prose (not a block form the
  // converter parses) so a truncated read that gets written back doesn't
  // smuggle a bogus block into the page.
  if (budget.truncated) {
    // Plain text, no `_…_` wrapper: the marker must NOT parse as a mark, or a
    // read → edit → replace_content cycle would write it back into the page
    // as real italic content.
    lines.push(TRUNCATION_MARKER);
  }

  return { title, content: lines.join("\n\n"), truncated: budget.truncated };
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

// --- Page icon / cover (NWRITE-03) ---

/** Sentinel a caller passes to clear an existing icon/cover. */
export const REMOVE_SENTINEL = "none";

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Build the `icon` value for PATCH/POST /pages. Notion takes either
 * `{type:"emoji", emoji}` or `{type:"external", external:{url}}`. Anything
 * that isn't an http(s) URL is treated as an emoji — Notion validates it.
 * The remove sentinel maps to null, which clears the icon.
 */
export function buildIcon(icon: string): Record<string, unknown> | null {
  const value = icon.trim();
  if (value.toLowerCase() === REMOVE_SENTINEL) return null;
  if (looksLikeUrl(value)) return { type: "external", external: { url: value } };
  return { type: "emoji", emoji: value };
}

/**
 * Build the `cover` value. Notion only accepts an external image URL here
 * (no emoji), so a non-URL is a caller error rather than something to coerce.
 */
export function buildCover(cover: string): Record<string, unknown> | null {
  const value = cover.trim();
  if (value.toLowerCase() === REMOVE_SENTINEL) return null;
  if (!looksLikeUrl(value)) {
    throw new Error(
      `Notion cover must be an external image URL (or "${REMOVE_SENTINEL}" to remove it) — got "${value}".`
    );
  }
  return { type: "external", external: { url: value } };
}

// --- Block writing (NWRITE-05) ---

/**
 * Append blocks in chunks of MAX_BLOCKS_PER_REQUEST. `after` positions the
 * FIRST chunk; later chunks chain off the last block written so a multi-chunk
 * insert stays contiguous and in order instead of every chunk landing at the
 * same anchor (which would reverse the content).
 *
 * The `after` parameter is deliberately confined to this helper: it is flat on
 * Notion-Version 2022-06-28 but was replaced by a `position` object in
 * 2026-03-11, so a version bump is a one-place change (NWRITE-04).
 */
async function appendBlocks(
  tokens: AccountTokenSet,
  blockId: string,
  children: unknown[],
  after?: string
): Promise<void> {
  let anchor = after;

  for (let i = 0; i < children.length; i += MAX_BLOCKS_PER_REQUEST) {
    const chunk = children.slice(i, i + MAX_BLOCKS_PER_REQUEST);
    let res: { results?: { id: string }[] };
    try {
      res = await notionFetch<{ results?: { id: string }[] }>(
        tokens,
        `/blocks/${blockId}/children`,
        {
          method: "PATCH",
          body: { children: chunk, ...(anchor ? { after: anchor } : {}) },
        }
      );
    } catch (err) {
      // Notion's docs never state it outright, but `after` appears to require
      // a DIRECT child of the target block. The resulting error doesn't name
      // the anchor, so an agent that passed a nested block id gets a validation
      // failure with no clue what to fix.
      if (anchor && i === 0 && /validation|invalid|not found/i.test(toMsg(err))) {
        throw new Error(
          `Append failed while inserting after block "${anchor}": ${toMsg(err)}. ` +
            `after_block_id must be a DIRECT child of the page — a block nested inside a ` +
            `toggle, column or list item won't work. Omit it to append at the end.`,
          { cause: err }
        );
      }
      throw err;
    }
    // Chain the next chunk after the last block we just wrote.
    const written = res?.results;
    const more = i + MAX_BLOCKS_PER_REQUEST < children.length;
    if (!written?.length && more && anchor) {
      // We were inserting at a specific position and Notion didn't echo the
      // created ids, so we can't anchor the next chunk. Silently dropping the
      // anchor would put chunk 1 mid-page and the rest at the end — content
      // split across two locations, out of order. Fail loudly instead.
      throw new Error(
        `Notion did not return created block ids, so the remaining ${children.length - i - MAX_BLOCKS_PER_REQUEST} ` +
          `block(s) cannot be inserted after "${anchor}" in order. ${i + MAX_BLOCKS_PER_REQUEST} block(s) were written. ` +
          `Retry without after_block_id to append at the end of the page.`
      );
    }
    anchor = written?.length ? written[written.length - 1]!.id : undefined;
  }
}

/**
 * Delete every existing child block of a page (NWRITE-01).
 *
 * Notion has no batch delete, so this is one request per block against a
 * ~3 req/s budget. DELETE moves a block to the workspace trash rather than
 * destroying it, so a run that dies partway through is recoverable — which is
 * why there's no staging/rollback machinery here (NWRITE-08 surfaces the
 * recovery path in the error message instead).
 */
async function deleteAllBlocks(tokens: AccountTokenSet, pageId: string): Promise<number> {
  const budget = { remaining: MAX_PAGE_BLOCKS, truncated: false };
  const blocks = await fetchAllChildren(tokens, pageId, budget);

  if (budget.truncated) {
    throw new Error(
      `Could not read the full list of blocks on this page, so replace_content would leave it ` +
        `partially cleared. Aborted before deleting anything.`
    );
  }

  // Wall-clock guard: one DELETE per block at ~3 req/s outruns the lambda
  // budget well before it outruns MAX_PAGE_BLOCKS. Refuse up front rather than
  // be killed halfway through, which would half-empty the page AND swallow the
  // message telling the caller where the blocks went.
  if (blocks.length > MAX_REPLACE_BLOCKS) {
    throw new Error(
      `This page has ${blocks.length} top-level blocks; replace_content is capped at ` +
        `${MAX_REPLACE_BLOCKS} because Notion has no batch delete (~3 requests/second, one per ` +
        `block) and the request would time out mid-delete, leaving the page half-cleared. ` +
        `Nothing was changed. Either edit the page in sections with append_content, or clear it ` +
        `in Notion first and then write the new content.`
    );
  }

  let deleted = 0;
  for (const block of blocks) {
    try {
      await notionFetch(tokens, `/blocks/${block.id}`, { method: "DELETE" });
      deleted++;
    } catch (err) {
      const reason = toMsg(err);
      throw new Error(
        `replace_content failed after deleting ${deleted}/${blocks.length} blocks: ${reason}. ` +
          `The page is in a PARTIAL state — the deleted blocks are recoverable from the Notion trash ` +
          `(page → ••• → Undo / workspace Trash). No new content was written.`,
        { cause: err }
      );
    }
  }

  return deleted;
}

export interface UpdatePageOptions {
  properties?: Record<string, string | number | boolean> | undefined;
  appendContent?: string | undefined;
  replaceContent?: string | undefined;
  archive?: boolean | undefined;
  icon?: string | undefined;
  cover?: string | undefined;
  /**
   * Insert `appendContent` directly after this block instead of at the end of
   * the page (NWRITE-04). Notion's `after` anchors AFTER an existing block, so
   * there is no way to express "prepend" — that's why this is an anchor id and
   * not a start/end enum. The block must be a direct child of the page.
   */
  afterBlockId?: string | undefined;
}

export async function updatePage(
  tokens: AccountTokenSet,
  pageId: string,
  options: UpdatePageOptions = {}
): Promise<{ id: string; url: string; deletedBlocks?: number }> {
  const { properties, appendContent, replaceContent, archive, icon, cover, afterBlockId } = options;

  // NWRITE-02: refuse conflicting content ops BEFORE touching anything, so a
  // bad call can't half-apply.
  if (appendContent !== undefined && replaceContent !== undefined) {
    throw new Error(
      "append_content and replace_content are mutually exclusive — pass only one. " +
        "Use replace_content to overwrite the page body, append_content to add to it."
    );
  }

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

  // Icon / cover — one PATCH for both (NWRITE-03). buildCover throws on a
  // non-URL, which happens before any block mutation below.
  if (icon !== undefined || cover !== undefined) {
    const body: Record<string, unknown> = {};
    if (icon !== undefined) body.icon = buildIcon(icon);
    if (cover !== undefined) body.cover = buildCover(cover);
    await notionFetch(tokens, `/pages/${pageId}`, { method: "PATCH", body });
  }

  // Replace: clear the existing body, then write the new one.
  let deletedBlocks: number | undefined;
  if (replaceContent !== undefined) {
    deletedBlocks = await deleteAllBlocks(tokens, pageId);
    const children = markdownToBlocks(replaceContent);
    if (children.length > 0) await appendBlocks(tokens, pageId, children);
  }

  // Append content if provided — same markdown→blocks builder as createPage
  // so appended content gets headings/lists/checkboxes/code, not flat text.
  if (appendContent) {
    const children = markdownToBlocks(appendContent);
    if (children.length > 0) {
      await appendBlocks(tokens, pageId, children, afterBlockId);
    }
  }

  // Return page info
  const page = await notionFetch<{ id: string; url: string }>(tokens, `/pages/${pageId}`);
  return {
    id: page.id,
    url: page.url,
    ...(deletedBlocks !== undefined ? { deletedBlocks } : {}),
  };
}

// --- Markdown → Notion blocks ---
//
// ┌─ THE READ/WRITE SYMMETRY CONTRACT ─────────────────────────────────────┐
// │                                                                        │
// │ Every construct is defined TWICE:                                      │
// │   · markdownToBlocks()  (below)  — markdown → Notion blocks   [WRITE]  │
// │   · renderBlock()       (above)  — Notion blocks → markdown   [READ]   │
// │                                                                        │
// │ The invariant: md → blocks → render → md is STABLE. Content written    │
// │ by notion_create/notion_update reads back through notion_read as the   │
// │ same markdown, so an agent can read a page, edit the text, and write   │
// │ it back with replace_content without the page degrading a little on    │
// │ every cycle.                                                           │
// │                                                                        │
// │ ADDING A BLOCK TYPE means touching BOTH functions plus a round-trip    │
// │ case in rich-blocks.test.ts. If you can parse something you can't      │
// │ render back, you have silently made every edit cycle lossy — so when   │
// │ in doubt, DON'T parse it. That is why inline marks were absent before  │
// │ v0.21: the renderer flattened them, so the writer refused to create    │
// │ them. v0.21 added both sides together (NRICH-05).                      │
// │                                                                        │
// │ Deliberate asymmetries (safe, because they lose no content):           │
// │   · `_em_`/`__bold__` normalize to `*em*`/`**bold**` on read-back      │
// │   · code fence aliases normalize (```ts → ```typescript), since        │
// │     Notion's `language` is a closed enum                               │
// │   · constructs deeper than Notion's 2-level nesting limit degrade to   │
// │     flatter blocks rather than emitting a payload the API rejects      │
// │                                                                        │
// │ Known hole: nested LIST children render indented but re-parse flat —   │
// │ 2-space indentation is only structural inside <details>.               │
// └────────────────────────────────────────────────────────────────────────┘

/** One rich_text run as we build it for the API. */
interface RichTextRun {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: NotionAnnotations;
}

/**
 * Split a single run's content on MAX_RICH_TEXT_LENGTH (NWRITE-06). Notion
 * rejects any run over 2000 characters, so a long paragraph or code block has
 * to become several runs. Splits prefer a newline, then a space, then fall
 * back to a hard cut, so the seam lands between words where possible. Notion
 * concatenates runs on render, so the visible text is identical either way.
 */
function splitRun(run: RichTextRun): RichTextRun[] {
  const content = run.text.content;
  if (content.length <= MAX_RICH_TEXT_LENGTH) return [run];

  const out: RichTextRun[] = [];
  let rest = content;

  while (rest.length > MAX_RICH_TEXT_LENGTH) {
    const window = rest.slice(0, MAX_RICH_TEXT_LENGTH);
    // Only break on whitespace in the last 20% of the window — a break point
    // near the start would produce lots of tiny runs.
    const floor = Math.floor(MAX_RICH_TEXT_LENGTH * 0.8);
    let cut = window.lastIndexOf("\n");
    if (cut < floor) cut = window.lastIndexOf(" ");
    if (cut < floor) cut = MAX_RICH_TEXT_LENGTH;
    out.push({ ...run, text: { ...run.text, content: rest.slice(0, cut) } });
    rest = rest.slice(cut);
  }

  if (rest) out.push({ ...run, text: { ...run.text, content: rest } });
  return out;
}

// Inline marks (v0.21, NRICH-05). Ordered so that longer delimiters win:
// `**bold**` must be tried before `*italic*`, and a code span must be matched
// before anything inside it is interpreted (Notion treats code as opaque).
//
// Two CommonMark guards, both of which exist because the naive form corrupts
// ordinary prose:
//   · word boundaries on `_`: without them `MAX_PAGE_BLOCKS` parses as
//     MAX<italic>PAGE</italic>BLOCKS. snake_case is everywhere in the
//     technical docs this connector writes.
//   · no flanking whitespace: without it "50% * 3 = 150 and 2 * 4" turns
//     "* 3 = 150 and 2 *" into an italic run. A delimiter must hug its
//     content to open/close a span.
// Both also break the read/write round-trip, since rendering back re-emits
// delimiters around text that never had them.
const INLINE_PATTERN = new RegExp(
  [
    "`([^`]+)`", // 1: code
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)", // 2: link text, 3: url
    "\\*\\*(?!\\s)([^*]+?)(?<!\\s)\\*\\*", // 4: bold
    "(?<![A-Za-z0-9_])__(?!\\s)([^_]+?)(?<!\\s)__(?![A-Za-z0-9_])", // 5: bold (alt)
    "\\*(?!\\s)([^*]+?)(?<!\\s)\\*", // 6: italic
    "(?<![A-Za-z0-9_])_(?!\\s)([^_]+?)(?<!\\s)_(?![A-Za-z0-9_])", // 7: italic (alt)
    "~~([^~]+)~~", // 8: strikethrough
  ].join("|"),
  "g"
);

/**
 * Parse inline markdown marks into annotated rich_text runs (NRICH-05).
 *
 * Notion models a styled span as its own rich_text object, so "a **b** c" is
 * three runs, not one. Marks are NOT nested: the first matching delimiter wins
 * and its content is taken literally. That keeps the parser predictable and
 * matches what renderRichText() can reproduce — the round-trip is the contract
 * (NRICH-06), so anything we can't render back, we don't parse.
 */
function parseInline(content: string): RichTextRun[] {
  const runs: RichTextRun[] = [];
  let last = 0;

  const push = (text: string, annotations?: NotionAnnotations, url?: string) => {
    if (!text) return;
    const run: RichTextRun = { type: "text", text: { content: text } };
    if (url) run.text.link = { url };
    if (annotations) run.annotations = annotations;
    runs.push(run);
  };

  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_PATTERN.exec(content)) !== null) {
    push(content.slice(last, match.index));

    if (match[1] !== undefined) push(match[1], { code: true });
    else if (match[2] !== undefined) push(match[2], undefined, match[3]);
    else if (match[4] !== undefined) push(match[4], { bold: true });
    else if (match[5] !== undefined) push(match[5], { bold: true });
    else if (match[6] !== undefined) push(match[6], { italic: true });
    else if (match[7] !== undefined) push(match[7], { italic: true });
    else if (match[8] !== undefined) push(match[8], { strikethrough: true });

    last = match.index + match[0].length;
  }

  push(content.slice(last));
  return runs;
}

/**
 * Build a rich_text array from markdown, parsing inline marks and splitting
 * any run that exceeds Notion's per-run character cap.
 */
function richText(content: string): RichTextRun[] {
  if (!content) return [];
  return parseInline(content).flatMap(splitRun);
}

/** Plain text with no inline parsing — for code blocks, where marks are literal. */
function literalText(content: string): RichTextRun[] {
  if (!content) return [];
  return splitRun({ type: "text", text: { content } });
}

/**
 * Render annotated rich_text back to markdown (NRICH-06 / read side).
 *
 * The inverse of parseInline: emit the same delimiters it consumes, so a page
 * written by notion_create/notion_update and read back by notion_read
 * round-trips. Order matters — code wins over other marks because Notion
 * renders code spans opaquely.
 */
function renderRichText(rt: NotionRichText[] | undefined): string {
  return (rt || [])
    .map((run) => {
      let text = run.plain_text;
      if (!text) return "";
      const a = run.annotations;
      if (a?.code) return `\`${text}\``;
      if (a?.bold) text = `**${text}**`;
      if (a?.italic) text = `*${text}*`;
      if (a?.strikethrough) text = `~~${text}~~`;
      if (run.href) text = `[${text}](${run.href})`;
      return text;
    })
    .join("");
}

function block(type: string, payload: Record<string, unknown>) {
  return { object: "block" as const, type, [type]: payload };
}

/**
 * Notion accepts at most TWO levels of nesting in a single request. A block
 * carrying children is level 1 and those children are level 2; anything
 * deeper is a 400.
 *
 * This bites without any nested toggles: a markdown table inside a toggle is
 * toggle → table → table_row, i.e. three levels, and a table MUST carry its
 * rows inline (Notion rejects a table created without them). So the converter
 * tracks its own depth and, at the limit, degrades the offending construct to
 * something valid rather than emitting a payload the API will reject.
 */
const MAX_NESTING_DEPTH = 2;

/**
 * Notion's block colors are a closed enum — an unknown value is a 400. The
 * `{…}` suffix on a callout is therefore only treated as a color when it
 * actually names one; otherwise it stays part of the text (prose ending in
 * `{something}` is far more likely than a typo'd color).
 */
const BLOCK_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

/**
 * `code.language` is a closed enum too. We map the common fence aliases an
 * agent actually writes and fall back to "plain text" for anything unknown,
 * so a ```sh or ```notalang fence degrades instead of failing the request.
 */
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  sh: "shell",
  zsh: "shell",
  bash: "bash",
  shell: "shell",
  console: "shell",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  go: "go",
  rust: "rust",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "c++",
  "c++": "c++",
  cs: "c#",
  "c#": "c#",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
  scala: "scala",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  markdown: "markdown",
  md: "markdown",
  diff: "diff",
  docker: "docker",
  dockerfile: "docker",
  graphql: "graphql",
  makefile: "makefile",
  "plain text": "plain text",
  text: "plain text",
  txt: "plain text",
};

function normalizeCodeLanguage(fence: string): string {
  if (!fence) return "plain text";
  return CODE_LANGUAGE_ALIASES[fence.toLowerCase()] ?? "plain text";
}

/**
 * Parse a markdown string into Notion block objects. Recognizes the same
 * constructs readPage() emits:
 *   #/##/### → heading_1/2/3 · - → bulleted_list_item · 1. → numbered_list_item
 *   [ ]/[x] → to_do (checked) · ```lang fenced → code · --- → divider
 *   `> [!icon] text` → callout · `<details> summary` + indented body → toggle
 *   `| a | b |` runs → table · `![cap](url)` → image · blank-line runs → paragraph
 * Anything unrecognized falls through to a paragraph.
 *
 * `depth` is internal: it tracks how deep in the block tree we already are so
 * children that would exceed Notion's 2-level limit are flattened instead of
 * producing an invalid payload.
 */
export function markdownToBlocks(md: string, depth = 1): unknown[] {
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
      const language = normalizeCodeLanguage(fence[1] || "");
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // skip the closing fence
      // literalText, not richText: code is opaque — `**x**` inside a snippet
      // must stay literal, and renderBlock reads it back the same way.
      blocks.push(block("code", { rich_text: literalText(code.join("\n")), language }));
      continue;
    }

    // Blank line → paragraph boundary.
    if (trimmed === "") {
      flushParagraph();
      i++;
      continue;
    }

    // Drop our own truncation annotations: both the trailing marker and the
    // leading warning are read-side additions, not page content, so a
    // read → edit → replace_content cycle must not persist either of them.
    if (trimmed === TRUNCATION_MARKER || trimmed.startsWith(TRUNCATION_WARNING_PREFIX)) {
      flushParagraph();
      i++;
      continue;
    }

    // Markdown table (NRICH-03) — a run of `| a | b |` lines, with an optional
    // `| --- |` separator marking a header row. table_width is fixed at
    // creation and every row must carry exactly that many cells, so the width
    // comes from the first row and later rows are padded/trimmed to match.
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      const rows: string[][] = [];
      let hasHeader = false;

      while (i < lines.length && /^\|.*\|$/.test((lines[i] ?? "").trim())) {
        const raw = (lines[i] ?? "").trim();
        if (/^\|[\s:|-]+\|$/.test(raw)) {
          // Separator row: marks the preceding row as the header.
          hasHeader = rows.length > 0;
          i++;
          continue;
        }
        // Split on unescaped pipes only, then unescape — mirrors the `\|`
        // emitted by renderBlock for cells that contain a literal pipe.
        rows.push(
          raw
            .slice(1, -1)
            .split(/(?<!\\)\|/)
            .map((cell) => cell.trim().replace(/\\\|/g, "|"))
        );
        i++;
      }

      // A lone separator line (`| --- |`) yields no rows. Don't drop it —
      // emit it as text so nothing silently vanishes from the page.
      if (rows.length === 0) {
        blocks.push(block("paragraph", { rich_text: richText(trimmed) }));
        continue;
      }

      {
        const width = rows[0]!.length;
        // A table is table → table_row, so it needs two levels of its own. At
        // the depth limit we can't emit one; fall back to paragraphs holding
        // the original pipe syntax, which stays readable and round-trips back
        // into a real table when written at top level.
        if (depth + 1 > MAX_NESTING_DEPTH) {
          for (const cells of rows) {
            blocks.push(block("paragraph", { rich_text: richText(`| ${cells.join(" | ")} |`) }));
          }
        } else {
          blocks.push(
            block("table", {
              table_width: width,
              has_column_header: hasHeader,
              has_row_header: false,
              children: rows.map((cells) =>
                block("table_row", {
                  cells: Array.from({ length: width }, (_, c) => richText(cells[c] ?? "")),
                })
              ),
            })
          );
        }
      }
      continue;
    }

    // Callout (NRICH-01) — `> [!emoji] text`, optionally with a trailing
    // `{color}` attribute. Mirrors renderBlock's callout emission.
    const callout = trimmed.match(/^>\s*\[!([^\]]*)\]\s*(.*)$/);
    if (callout) {
      flushParagraph();
      let text = callout[2]!.trim();
      let color = "default";
      const colorMatch = text.match(/\s*\{([a-z_]+)\}$/);
      // Only strip the suffix when it names a real color — otherwise prose
      // like "set {my_var}" would lose its tail AND send an invalid color.
      if (colorMatch && BLOCK_COLORS.has(colorMatch[1]!)) {
        color = colorMatch[1]!;
        text = text.slice(0, colorMatch.index).trim();
      }
      const emoji = callout[1]!.trim();
      blocks.push(
        block("callout", {
          rich_text: richText(text),
          ...(emoji ? { icon: { type: "emoji", emoji } } : {}),
          color,
        })
      );
      i++;
      continue;
    }

    // Toggle (NRICH-02) — `<details> summary`, with the following indented
    // lines becoming its children. Notion allows 2 levels of nesting per
    // request, which a toggle plus its children fits exactly.
    const toggle = trimmed.match(/^<details>\s*(.*)$/);
    if (toggle) {
      flushParagraph();
      const summary = toggle[1]!.replace(/<\/?summary>/g, "").trim();
      i++;

      // Consume the indented body that follows.
      const body: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "") {
          // A blank line only ends the toggle if the next content is not indented.
          const after = lines[i + 1] ?? "";
          if (after.trim() !== "" && !/^\s{2,}/.test(after)) break;
          body.push("");
          i++;
          continue;
        }
        if (!/^\s{2,}/.test(next)) break;
        body.push(next.replace(/^\s{2}/, ""));
        i++;
      }

      // At the depth limit a toggle can't carry children — emit the summary as
      // a paragraph and hoist the body to this level so no content is lost.
      if (depth + 1 > MAX_NESTING_DEPTH) {
        blocks.push(block("paragraph", { rich_text: richText(summary) }));
        blocks.push(...markdownToBlocks(body.join("\n"), depth));
        continue;
      }

      const children = markdownToBlocks(body.join("\n"), depth + 1);
      blocks.push(
        block("toggle", {
          rich_text: richText(summary),
          ...(children.length > 0 ? { children } : {}),
        })
      );
      continue;
    }

    // Image / bookmark / embed (NRICH-04). `![caption](url)` is an image;
    // `[bookmark](url)` and `[embed](url)` use their label as the marker so
    // they round-trip through renderBlock.
    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      flushParagraph();
      const caption = image[1]!.trim();
      blocks.push(
        block("image", {
          type: "external",
          external: { url: image[2]! },
          ...(caption ? { caption: richText(caption) } : {}),
        })
      );
      i++;
      continue;
    }

    const media = trimmed.match(/^\[(bookmark|embed)\]\(([^)\s]+)\)$/);
    if (media) {
      flushParagraph();
      blocks.push(block(media[1]!, { url: media[2]! }));
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
    /** Emoji or external image URL (NWRITE-03). */
    icon?: string | undefined;
    /** External image URL (NWRITE-03). */
    cover?: string | undefined;
  }
): Promise<{ id: string; url: string }> {
  const children = opts.content ? markdownToBlocks(opts.content) : [];

  const kind = opts.parentType ?? (await detectParentType(tokens, opts.parentId));
  const parent = kind === "page" ? { page_id: opts.parentId } : { database_id: opts.parentId };

  // POST /pages accepts at most MAX_BLOCKS_PER_REQUEST children; anything
  // beyond that is appended afterwards (NWRITE-05).
  const initial = children.slice(0, MAX_BLOCKS_PER_REQUEST);
  const overflow = children.slice(MAX_BLOCKS_PER_REQUEST);

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
      children: initial,
      ...(opts.icon !== undefined ? { icon: buildIcon(opts.icon) } : {}),
      ...(opts.cover !== undefined ? { cover: buildCover(opts.cover) } : {}),
    },
  });

  if (overflow.length > 0) {
    await appendBlocks(tokens, data.id, overflow);
  }

  return { id: data.id, url: data.url };
}
