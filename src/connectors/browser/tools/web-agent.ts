import {
  createBrowserSession,
  validatePublicUrl,
  validateContextName,
  sanitizeError,
} from "../lib/browserbase";
import { clampNavTimeout } from "../lib/page-helpers";

type WebAgentParams = {
  url: string;
  instruction: string;
  max_steps?: number | undefined;
  nav_timeout_ms?: number | undefined;
  context_name?: string | undefined;
};

const DEFAULT_MAX_STEPS = 10;
const HARD_MAX_STEPS = 30;
// Wallclock cap on agent.execute(). Defense-in-depth against Stagehand
// step-counting bugs that have historically let agents loop past their
// declared maxSteps — without this cap a misbehaving agent silently
// drains Browserbase session minutes (review finding #5, 2026-05-01).
// Sized as a per-step budget × the hard ceiling, matching Stagehand's
// own per-tool default (~45s).
const PER_STEP_WALLCLOCK_MS = 45_000;

/**
 * Stagehand `agent` — multi-step autonomous goal completion. The agent
 * plans tool calls (act/extract/observe/goto/scroll) until it considers
 * the instruction satisfied or hits `max_steps`.
 *
 * Failure modes worth surfacing to the caller:
 * - Step budget exhausted (`completed: false` with partial actions log)
 * - Tool error mid-flight (returned in the actions array)
 * - Hard timeout via AbortController (we don't set one here — Stagehand
 *   handles per-tool timeouts; the calling MCP transport's own timeout
 *   bounds end-to-end runtime)
 */
export async function handleWebAgent(params: WebAgentParams) {
  await validatePublicUrl(params.url);
  const contextName = validateContextName(params.context_name || "default");
  const stagehand = await createBrowserSession(contextName);

  const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(1, params.max_steps ?? DEFAULT_MAX_STEPS));

  try {
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("Stagehand returned no page (unexpected state)");

    await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: clampNavTimeout(params.nav_timeout_ms),
    });

    const agent = stagehand.agent();
    const ctrl = new AbortController();
    const wallclockMs = maxSteps * PER_STEP_WALLCLOCK_MS;
    const timer = setTimeout(() => ctrl.abort(), wallclockMs);
    let result;
    try {
      result = await agent.execute({
        instruction: params.instruction,
        maxSteps,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: result.success,
              completed: result.completed,
              message: result.message,
              steps: result.actions.length,
              actions: result.actions.map((a) => ({
                type: a.type,
                action: a.action,
                reasoning: a.reasoning,
                taskCompleted: a.taskCompleted,
                pageUrl: a.pageUrl,
              })),
              usage: result.usage,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error running agent on ${params.url}: ${sanitizeError(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    await stagehand.close();
  }
}
