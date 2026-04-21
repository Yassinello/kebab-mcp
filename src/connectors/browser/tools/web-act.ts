// Phase 44 SCM-01: V2/V3 dispatch gated on KEBAB_BROWSER_CONNECTOR_V2.
// See .planning/phases/44-supply-chain/MIGRATION-NOTES.md.

import { z } from "zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { getBrowserConnectorVersion } from "../flag";

export const webActSchema = {
  url: z.string().describe("URL to navigate to before performing actions"),
  actions: z
    .array(z.string())
    .describe(
      'List of actions in natural language, executed in order. Example: ["click on \'Start a post\'", "type \'Hello world\' in the editor", "click Post"]'
    ),
  context_name: z
    .string()
    .optional()
    .describe("Browser context for session persistence (default: 'default')"),
};

type WebActParams = {
  url: string;
  actions: string[];
  context_name?: string;
};

/**
 * V2-compat path (default). Frozen for safe rollback.
 */
export async function handleWebActV2(params: WebActParams) {
  validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");
  const stagehand = await createBrowserSession(contextName);

  try {
    const page = stagehand.context.pages()[0];

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30000,
    });

    const results: { action: string; status: string }[] = [];

    for (const action of params.actions) {
      try {
        await stagehand.act(action);
        results.push({ action, status: "done" });
      } catch (err: unknown) {
        results.push({ action, status: `failed: ${sanitizeError(err)}` });
        break; // Stop on first failure
      }

      // Random delay between actions to simulate human behavior
      const delay = 1000 + Math.random() * 2000;
      await new Promise((r) => setTimeout(r, delay));
    }

    const finalUrl = page.url();
    const summary = results.map((r) => `- ${r.action} → ${r.status}`).join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Actions performed on ${finalUrl}:\n\n${summary}`,
        },
      ],
    };
  } catch (err: unknown) {
    return {
      content: [
        { type: "text" as const, text: `Error acting on ${params.url}: ${sanitizeError(err)}` },
      ],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}

/**
 * V3 path — delegates to V2 today. TODO: switch to page.act() (v3 idiomatic)
 * when the project needs those semantics.
 */
export async function handleWebActV3(params: WebActParams) {
  return handleWebActV2(params);
}

export async function handleWebAct(params: WebActParams) {
  const version = getBrowserConnectorVersion();
  return version === "v3" ? handleWebActV3(params) : handleWebActV2(params);
}
