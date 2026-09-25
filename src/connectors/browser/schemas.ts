/**
 * Browser connector schemas — separated from handlers to enable lazy
 * loading of heavy deps (Stagehand ~2.3 MB, Browserbase SDK).
 *
 * The manifest imports only this file at registration time; the actual
 * handler code (and its heavy imports) is loaded on first tool call
 * via dynamic `import()`.
 */
import { z } from "zod";

const scrollSchema = z
  .union([z.literal("auto"), z.coerce.number().int().min(0).max(50)])
  .optional()
  .describe(
    "Scroll before extracting. Number = fixed scroll steps. 'auto' = scroll until the page stops growing (recommended for infinite-scroll feeds). Default: 0 (no scroll)."
  );

const navTimeoutSchema = z
  .number()
  .int()
  .min(5_000)
  .max(90_000)
  .optional()
  .describe(
    "Navigation timeout in ms. Clamped to [5000, 90000]. Default: 30000. Bump this for slow first paints (Vinted, Seloger)."
  );

const contextNameSchema = z
  .string()
  .optional()
  .describe(
    "Browser context for session persistence. Use 'linkedin' for LinkedIn, 'default' for anonymous."
  );

export const webBrowseSchema = {
  url: z.string().describe("URL to navigate to"),
  scroll_count: scrollSchema,
  nav_timeout_ms: navTimeoutSchema,
  context_name: contextNameSchema,
};

export const webExtractSchema = {
  url: z.string().describe("URL to extract data from"),
  instruction: z
    .string()
    .describe(
      "What to extract, in natural language. Example: 'Extract all feed posts with author, content, likes count, and date'"
    ),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional JSON Schema constraining the extraction shape. Strongly recommended — without it the LLM extracts free-form and may hallucinate fields like URLs. Use a JSON Schema with `type: 'object'` and a `properties` map. Example: {type:'object', properties:{items:{type:'array', items:{type:'object', properties:{title:{type:'string'}, price:{type:'string'}}}}}}"
    ),
  scroll_count: scrollSchema,
  nav_timeout_ms: navTimeoutSchema,
  context_name: contextNameSchema,
};

export const webActSchema = {
  url: z.string().describe("URL to navigate to before performing actions"),
  actions: z
    .array(z.string())
    .describe(
      'List of actions in natural language, executed in order. Example: ["click on \'Start a post\'", "type \'Hello world\' in the editor", "click Post"]'
    ),
  nav_timeout_ms: navTimeoutSchema,
  context_name: contextNameSchema,
};

export const webObserveSchema = {
  url: z.string().describe("URL to navigate to before observing"),
  instruction: z
    .string()
    .describe(
      "What kind of elements to surface. Example: 'all clickable product cards', 'the search submit button', 'the cookie consent accept button'"
    ),
  scroll_count: scrollSchema,
  nav_timeout_ms: navTimeoutSchema,
  context_name: contextNameSchema,
};

export const webAgentSchema = {
  url: z.string().describe("Starting URL — the agent navigates here before reasoning"),
  instruction: z
    .string()
    .describe(
      "Goal for the autonomous agent. The agent will plan and execute multiple steps (click, type, extract, navigate) until it considers the task done. Example: 'Find the cheapest 2-bedroom apartment in Vincennes under 1500€/month and return its title, price, and link.'"
    ),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe("Maximum tool-call steps the agent may take. Default: 10."),
  nav_timeout_ms: navTimeoutSchema,
  context_name: contextNameSchema,
};

export const extractLinksSchema = {
  url: z.string().describe("URL to extract links from"),
  selector: z
    .string()
    .optional()
    .describe(
      "Optional CSS selector restricting which anchors to collect. Example: 'a[href*=\"/items/\"]' for Vinted listings, 'a.product-card' for product grids. If omitted, returns every anchor on the page."
    ),
  href_pattern: z
    .string()
    .optional()
    .describe(
      "Optional substring or regex (slash-delimited) the href must match. String 'foo' = href.includes('foo'). String '/foo.+/i' = parsed as regex. Applied AFTER `selector`."
    ),
  scroll_count: scrollSchema,
  nav_timeout_ms: navTimeoutSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Cap on the number of links returned. Default: 100."),
  context_name: contextNameSchema,
};

export const linkedinFeedSchema = {
  max_posts: z.number().optional().describe("Max posts to return (default: 20, max: 30)"),
};
