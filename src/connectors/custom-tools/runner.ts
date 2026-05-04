import { getEnabledPacksLazy } from "@/core/registry";
import { runWithCredentials } from "@/core/request-context";
import { getHydratedCredentialSnapshot } from "@/core/credential-store";
import { toMsg } from "@/core/error-utils";
import type { ToolDefinition, ToolResult } from "@/core/types";
import type { CustomTool, CustomToolStep, RunResult, StepRunResult } from "./types";
import { expandArgs, renderTemplate } from "./expression";
import { getActiveCustomToolIds, runWithActiveCustomToolIds } from "./context";

/**
 * Custom Tool runner.
 *
 * Executes a tool's `steps[]` sequentially, accumulating results into a
 * single context object that subsequent steps can read via Mustache.
 *
 * Step semantics:
 *  - `tool`      → look up `toolName` in the loaded registry, expand
 *                  `args` against the context, invoke the handler in
 *                  process (no MCP round-trip), optionally save the
 *                  string result under `saveAs`.
 *  - `transform` → render `template`, save under `saveAs`.
 *
 * Output: the LAST step's textual contribution becomes the MCP-facing
 * result. Per-step results are returned alongside so the dashboard can
 * show a stack-trace-style breakdown.
 *
 * Recursion guard (CR-01): a Custom Tool can call other Custom Tools,
 * but never itself (direct or transitive). The set of active tool ids
 * is carried through an AsyncLocalStorage (`./context`) so transitive
 * calls (A→B→A) see the full call-stack regardless of how the inner
 * invocation is triggered (manifest wrapper, direct runner call, …).
 */

const MAX_STEPS = 32;
const PREVIEW_LIMIT = 240;

/**
 * CR-02 — Allowlist of connectors callable from Custom Tools.
 *
 * Custom Tools run inside an admin-authored definition but are exposed
 * to *any* MCP client (Claude.ai, Cline, …). A Custom Tool that calls
 * `mcp_backup_export` would dump every KV key — including credentials —
 * back through the standard MCP channel, escalating an LLM client to
 * effective admin. We therefore restrict the callable surface to the
 * connectors whose tools are designed for MCP-client consumption.
 *
 * Excluded explicitly:
 *  - `admin`       — privilege escalation (backup export, raw KV access).
 *  - `skills`      — prompt injection vector; skills are LLM-rendered
 *                    instructions, not deterministic operations.
 *  - `custom-tools` — recursion vector handled by activeIds, but kept
 *                    out of the lookup here as a defense-in-depth: an
 *                    enabled Custom Tool can still be referenced; the
 *                    activeIds guard catches A→B→A cycles regardless.
 */
const CALLABLE_FROM_CUSTOM_TOOLS = new Set([
  "google",
  "vault",
  "slack",
  "notion",
  "composio",
  "api-connections",
  "apify",
  "github",
  "linear",
  "airtable",
  "paywall",
  "webhook",
  "browser",
  "custom-tools",
]);

/**
 * Look up a tool in the merged registry, refusing any tool whose owning
 * pack is not in CALLABLE_FROM_CUSTOM_TOOLS.
 *
 * Returns `{ tool, packId }` on hit so the caller can surface a clear
 * "pack X is not in allowlist" message when the lookup matched a tool
 * but the pack was filtered.
 */
async function findToolByName(
  name: string
): Promise<{ tool: ToolDefinition; packId: string } | { blockedPackId: string } | null> {
  const packs = await getEnabledPacksLazy();
  for (const p of packs) {
    const found = p.manifest.tools.find((t) => t.name === name);
    if (!found) continue;
    if (!CALLABLE_FROM_CUSTOM_TOOLS.has(p.manifest.id)) {
      return { blockedPackId: p.manifest.id };
    }
    return { tool: found, packId: p.manifest.id };
  }
  return null;
}

export { CALLABLE_FROM_CUSTOM_TOOLS };

/**
 * Build the input bag the runner exposes to Mustache. Optional inputs
 * default to undefined (rendered as empty string by the expression
 * engine). Required-but-missing inputs are caught here, not at first
 * Mustache use, so the error message is more helpful.
 */
function buildInitialContext(
  tool: CustomTool,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const def of tool.inputs) {
    const raw = inputs[def.name];
    if (raw === undefined || raw === null || raw === "") {
      if (def.required) {
        throw new Error(`missing required input "${def.name}"`);
      }
      ctx[def.name] = undefined;
      continue;
    }
    if (def.type === "enum" && !def.values.includes(String(raw))) {
      throw new Error(
        `input "${def.name}" must be one of ${def.values.join(", ")} (got "${String(raw)}")`
      );
    }
    ctx[def.name] = raw;
  }
  return ctx;
}

/**
 * Run a custom tool. Throws only on programmer errors (unknown step
 * kind, internal invariants); all author-facing errors are folded into
 * the returned `RunResult` with `ok: false`.
 *
 * The recursion guard relies on an AsyncLocalStorage-backed set of
 * active ids (`./context`). When the manifest wrapper invokes
 * `runCustomTool` for tool B from inside A's step, B inherits the set
 * of active ids from the outer A context automatically — so A→B→A is
 * caught at the second `tool_a` lookup, not after a stack overflow.
 */
export async function runCustomTool(
  tool: CustomTool,
  inputs: Record<string, unknown>
): Promise<RunResult> {
  const startedAt = Date.now();
  const stepResults: StepRunResult[] = [];

  // Recursion guard — direct or transitive. Read the set already on the
  // call stack (empty Set if we're the outermost invocation), reject if
  // the current tool is in it, then push our own id and propagate the
  // extended set to nested invocations via the ALS.
  const previousActive = getActiveCustomToolIds();
  if (previousActive.has(tool.id)) {
    const chain = [...previousActive, tool.id].join(" → ");
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: 0,
      error: `recursion detected: ${chain}`,
    };
  }
  const activeIds = new Set(previousActive);
  activeIds.add(tool.id);

  if (tool.steps.length > MAX_STEPS) {
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: 0,
      error: `too many steps (max ${MAX_STEPS}, got ${tool.steps.length})`,
    };
  }

  // Build the initial context from the inputs.
  let context: Record<string, unknown>;
  try {
    context = buildInitialContext(tool, inputs);
  } catch (err) {
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: Date.now() - startedAt,
      error: toMsg(err),
    };
  }

  // Wrap the whole sequence in runWithCredentials so child tools that
  // depend on hydrated credentials (vault_*, slack_*, …) see them. The
  // snapshot is the same one resolveRegistryAsync uses to gate
  // connectors, so a tool that's enabled is necessarily callable here.
  const credSnapshot = getHydratedCredentialSnapshot();

  let lastSaved = "";
  let lastError: string | undefined;
  let lastFinalText = "";

  await runWithCredentials(credSnapshot, () =>
    runWithActiveCustomToolIds(activeIds, async () => {
      for (let i = 0; i < tool.steps.length; i++) {
        const step = tool.steps[i]!;
        const stepStarted = Date.now();
        const label = step.kind === "tool" ? step.toolName : "<transform>";
        try {
          const { saved, finalText } = await runStep(step, context, activeIds);
          if (step.kind === "tool" && step.saveAs) {
            context[step.saveAs] = saved;
          } else if (step.kind === "transform") {
            context[step.saveAs] = saved;
          }
          lastSaved = String(saved ?? "");
          lastFinalText = finalText;
          stepResults.push({
            index: i,
            kind: step.kind,
            label,
            ok: true,
            durationMs: Date.now() - stepStarted,
            preview: previewOf(saved),
          });
        } catch (err) {
          const msg = toMsg(err);
          lastError = `step[${i}] (${label}): ${msg}`;
          stepResults.push({
            index: i,
            kind: step.kind,
            label,
            ok: false,
            durationMs: Date.now() - stepStarted,
            error: msg,
          });
          return; // abort on first error — explicit, no continue-on-error
        }
      }
    })
  );

  const totalDurationMs = Date.now() - startedAt;
  if (lastError) {
    return {
      ok: false,
      result: lastSaved,
      stepResults,
      totalDurationMs,
      error: lastError,
    };
  }
  return {
    ok: true,
    result: lastFinalText || lastSaved,
    stepResults,
    totalDurationMs,
  };
}

async function runStep(
  step: CustomToolStep,
  context: Record<string, unknown>,
  activeIds: Set<string>
): Promise<{ saved: unknown; finalText: string }> {
  if (step.kind === "transform") {
    const rendered = renderTemplate(step.template, context);
    return { saved: rendered, finalText: rendered };
  }

  // tool step
  // Recursion guard at the lookup site too — defense in depth in case a
  // future code path bypasses the ALS-based guard above (e.g. a manifest
  // wrapper that doesn't go through runWithActiveCustomToolIds).
  if (activeIds.has(step.toolName)) {
    const chain = [...activeIds, step.toolName].join(" → ");
    throw new Error(`recursion detected: ${chain}`);
  }
  const lookup = await findToolByName(step.toolName);
  if (!lookup) {
    throw new Error(`tool "${step.toolName}" is not registered or its connector is disabled`);
  }
  if ("blockedPackId" in lookup) {
    throw new Error(
      `tool "${step.toolName}" is not callable from custom tools (pack "${lookup.blockedPackId}" is not in allowlist)`
    );
  }
  const expanded = expandArgs(step.args, context);
  const argsObj = (expanded ?? {}) as Record<string, unknown>;
  const result: ToolResult = await lookup.tool.handler(argsObj);

  if (result.isError) {
    const errText = toolResultToText(result) || "tool returned isError without a text payload";
    throw new Error(errText);
  }
  const finalText = toolResultToText(result);
  return { saved: finalText, finalText };
}

function toolResultToText(result: ToolResult): string {
  if (!Array.isArray(result.content) || result.content.length === 0) return "";
  return result.content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function previewOf(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return "";
  return s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s;
}
