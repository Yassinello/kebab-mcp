import { jsonSchemaToZod } from "@composio/json-schema-to-zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { clampNavTimeout, scrollPage } from "../lib/page-helpers";

type WebExtractParams = {
  url: string;
  instruction: string;
  schema?: Record<string, unknown> | undefined;
  scroll_count?: number | "auto" | undefined;
  nav_timeout_ms?: number | undefined;
  context_name?: string | undefined;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export async function handleWebExtract(params: WebExtractParams): Promise<ToolResult> {
  await validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");

  // Compile the optional JSON Schema before opening a browser session —
  // a bad schema is a caller error, not a Browserbase quota waster.
  let zodSchema: ReturnType<typeof jsonSchemaToZod> | undefined;
  if (params.schema) {
    // Stagehand's structured-extract path is built around an *object*
    // schema; passing a primitive (e.g. {type:"string"}) compiles cleanly
    // but produces unpredictable Stagehand output. Reject early with an
    // actionable message (review finding #6, 2026-05-01).
    const rootType = (params.schema as { type?: unknown }).type;
    if (rootType !== "object") {
      return errorResult(
        "schema must describe an object (root type must be 'object'); use a wrapper like { type: 'object', properties: { items: { type: 'array', ... } } }"
      );
    }
    try {
      zodSchema = jsonSchemaToZod(params.schema as Parameters<typeof jsonSchemaToZod>[0]);
    } catch (err) {
      return errorResult(`Invalid JSON Schema: ${sanitizeError(err)}`);
    }
  }

  const stagehand = await createBrowserSession(contextName);

  try {
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("Stagehand returned no page (unexpected state)");

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: clampNavTimeout(params.nav_timeout_ms),
    });

    await scrollPage(page, params.scroll_count);

    // Stagehand v3 picks the right overload based on whether a schema is
    // provided. With a schema, the LLM is forced into shape compliance —
    // free-form extraction is the main source of hallucinated URLs and
    // missing fields (Vinted regression, 2026-04-30).
    const result = zodSchema
      ? await stagehand.extract(params.instruction, zodSchema)
      : await stagehand.extract(params.instruction);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    return errorResult(`Error extracting from ${params.url}: ${sanitizeError(err)}`);
  } finally {
    await stagehand.close();
  }
}

function errorResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
