import type { AccountTokenSet } from "@/core/connector-accounts";

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

  do {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    const page: BlockPage = await fetchChildrenPage(tokens, blockId, cursor);
    for (const block of page.results) {
      if (budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      budget.remaining--;
      out.push(block);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);

  return out;
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
    | { rich_text?: NotionRichText[]; checked?: boolean; language?: string }
    | undefined;
  const text = plain(payload?.rich_text);

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
      return `\`\`\`${payload?.language || ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
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

function renderTree(nodes: BlockNode[], level: number, out: string[]): void {
  for (const node of nodes) {
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
    lines.push(
      `_[Kebab: page truncated — hit the ${MAX_PAGE_BLOCKS}-block / depth-${MAX_CHILD_DEPTH} read bound. Content below this point was not read.]_`
    );
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
    const res = await notionFetch<{ results?: { id: string }[] }>(
      tokens,
      `/blocks/${blockId}/children`,
      {
        method: "PATCH",
        body: { children: chunk, ...(anchor ? { after: anchor } : {}) },
      }
    );
    // Chain the next chunk after the last block we just wrote. If Notion
    // didn't echo the ids back, drop the anchor: appending at the end is the
    // correct fallback, whereas reusing the old anchor would interleave.
    const written = res?.results;
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
      `Page has more than ${MAX_PAGE_BLOCKS} top-level blocks — refusing to replace_content, ` +
        `as it would leave the page partially cleared. Trim the page in Notion first.`
    );
  }

  let deleted = 0;
  for (const block of blocks) {
    try {
      await notionFetch(tokens, `/blocks/${block.id}`, { method: "DELETE" });
      deleted++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
// Inverse of the readPage() switch above (heading_1/2/3, paragraph,
// bulleted_list_item, numbered_list_item, to_do, code, divider). Keeping the
// two in lockstep means content written by notion_create / notion_update and
// then read back by notion_read round-trips without surprises. Inline marks
// (bold/italic/links) are intentionally NOT parsed — readPage flattens them
// too, so a single rich_text run per block keeps write/read symmetric.

/**
 * Build a rich_text array, splitting on MAX_RICH_TEXT_LENGTH (NWRITE-06).
 * Notion rejects any single run over 2000 characters, so a long paragraph or
 * code block has to become several runs rather than one oversized one. Splits
 * prefer a newline, then a space, then fall back to a hard cut, so the seam
 * lands between words where possible. Notion concatenates the runs, so the
 * rendered text is identical either way.
 */
function richText(content: string) {
  if (!content) return [];
  if (content.length <= MAX_RICH_TEXT_LENGTH) {
    return [{ type: "text" as const, text: { content } }];
  }

  const runs: { type: "text"; text: { content: string } }[] = [];
  let rest = content;

  while (rest.length > MAX_RICH_TEXT_LENGTH) {
    const window = rest.slice(0, MAX_RICH_TEXT_LENGTH);
    // Only break on whitespace in the last 20% of the window — a break point
    // near the start would produce lots of tiny runs.
    const floor = Math.floor(MAX_RICH_TEXT_LENGTH * 0.8);
    let cut = window.lastIndexOf("\n");
    if (cut < floor) cut = window.lastIndexOf(" ");
    if (cut < floor) cut = MAX_RICH_TEXT_LENGTH;
    runs.push({ type: "text" as const, text: { content: rest.slice(0, cut) } });
    rest = rest.slice(cut);
  }

  if (rest) runs.push({ type: "text" as const, text: { content: rest } });
  return runs;
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
