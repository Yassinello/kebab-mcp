import { z } from "zod";
import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";

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

export async function handleWebAct(params: {
  url: string;
  actions: string[];
  context_name?: string;
}) {
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
