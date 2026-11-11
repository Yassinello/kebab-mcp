import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectorManifest, ConnectorState, ToolDefinition, ToolResult } from "@/core/types";
import { runCustomTool } from "./runner";
import { buildCustomToolDefinition } from "./manifest";
import type { CustomTool } from "./types";

// ── Test registry ─────────────────────────────────────────────────────
//
// We mock @/core/registry so the runner sees a deterministic in-memory
// tool surface — no Vercel-style lambda gates, no env var dependencies,
// no real Slack / Vault / etc. handlers. Tests can mutate `mockTools`
// before each scenario.

// vi.mock factory bodies are hoisted, so any state they close over must
// be hoisted alongside via vi.hoisted (regular `const` would TDZ on the
// hoisted factory call).
const { mockTools, mockAdminTools } = vi.hoisted(() => ({
  mockTools: [] as ToolDefinition[],
  mockAdminTools: [] as ToolDefinition[],
}));

// We pose as an allowlisted connector ("vault") so the runner's CR-02
// gate doesn't reject our mock tools. The CR-02 test below explicitly
// uses a non-allowlisted pack ("admin") to verify the gate.
vi.mock("@/core/registry", () => {
  const buildManifest = (): ConnectorManifest => ({
    id: "vault",
    label: "Test Connector",
    description: "test",
    requiredEnvVars: [],
    tools: mockTools,
  });
  const buildAdminManifest = (): ConnectorManifest => ({
    id: "admin",
    label: "Admin",
    description: "admin",
    requiredEnvVars: [],
    tools: mockAdminTools,
    core: true,
  });
  const buildState = (): ConnectorState => ({
    manifest: buildManifest(),
    enabled: true,
    reason: "active",
  });
  const buildAdminState = (): ConnectorState => ({
    manifest: buildAdminManifest(),
    enabled: true,
    reason: "active",
  });
  return {
    getEnabledPacksLazy: async () => [buildState(), buildAdminState()],
  };
});

vi.mock("@/core/credential-store", () => ({
  getHydratedCredentialSnapshot: () => ({}),
}));

// Phase 3 — neutralize the fire-and-forget telemetry path so the
// runner tests don't accidentally write to data/kv.json. The runs-store
// is exercised directly in runs-store.test.ts; here we only care about
// `committedSteps` being populated on the in-memory RunResult.
const { disabledTools } = vi.hoisted(() => ({ disabledTools: new Set<string>() }));
vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: async () => new Set(disabledTools),
}));

vi.mock("./runs-store", () => ({
  recordRun: vi.fn(async () => undefined),
  listRuns: vi.fn(async () => []),
}));

// Helper to register a tool inside the mocked registry (vault pack —
// allowlisted by CR-02).
function registerTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  destructive = false
): void {
  mockTools.push({
    name,
    description: `mock ${name}`,
    schema: {},
    destructive,
    handler,
  });
}

// Helper to register a tool inside the mocked ADMIN pack — explicitly
// NOT in the CR-02 allowlist. Used to verify the runner refuses to call
// admin tools from custom-tool steps.
function registerAdminTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
): void {
  mockAdminTools.push({
    name,
    description: `admin mock ${name}`,
    schema: {},
    destructive: true,
    handler,
  });
}

// ── Sample tool: the kanban add ───────────────────────────────────────

function buildKanbanTool(): CustomTool {
  return {
    id: "todo_add",
    description: "Add a task to the kanban",
    destructive: true,
    inputs: [
      { name: "task", type: "string", required: true, description: "" },
      { name: "due", type: "string", required: false, description: "" },
      {
        name: "priority",
        type: "enum",
        required: false,
        values: ["high", "med", "low"],
        description: "",
      },
    ],
    steps: [
      {
        kind: "tool",
        toolName: "vault_read",
        args: { path: "Tasks/Kanban.md" },
        saveAs: "kanban",
      },
      {
        kind: "transform",
        template:
          "{{kanban}}\n- [ ] {{task}}{{#priority}} #{{priority}}{{/priority}}{{#due}} 📅 {{due}}{{/due}}",
        saveAs: "newKanban",
      },
      {
        kind: "tool",
        toolName: "vault_write",
        args: { path: "Tasks/Kanban.md", content: "{{newKanban}}" },
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("runner — happy path (todo_add → 3 steps)", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("reads + transforms + writes, propagates the rendered content", async () => {
    let writtenContent = "";
    registerTool("vault_read", async () => ({
      content: [{ type: "text", text: "## Inbox\n- [ ] existing task" }],
    }));
    registerTool(
      "vault_write",
      async (args) => {
        writtenContent = String(args.content ?? "");
        return { content: [{ type: "text", text: "Wrote 1 file" }] };
      },
      true
    );

    const tool = buildKanbanTool();
    const result = await runCustomTool(tool, {
      task: "Buy milk",
      priority: "high",
      due: "2026-05-12",
    });

    expect(result.ok).toBe(true);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults.every((s) => s.ok)).toBe(true);
    expect(writtenContent).toBe(
      "## Inbox\n- [ ] existing task\n- [ ] Buy milk #high 📅 2026-05-12"
    );
  });

  it("omits optional fields cleanly when not provided", async () => {
    let writtenContent = "";
    registerTool("vault_read", async () => ({
      content: [{ type: "text", text: "" }],
    }));
    registerTool("vault_write", async (args) => {
      writtenContent = String(args.content ?? "");
      return { content: [{ type: "text", text: "ok" }] };
    });

    const tool = buildKanbanTool();
    const result = await runCustomTool(tool, { task: "Read book" });
    expect(result.ok).toBe(true);
    expect(writtenContent).toBe("\n- [ ] Read book");
  });

  it("rejects when required input missing", async () => {
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "" }] }));
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await runCustomTool(buildKanbanTool(), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required input "task"/);
  });

  it("rejects an enum value not in the allow-list", async () => {
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "" }] }));
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await runCustomTool(buildKanbanTool(), {
      task: "x",
      priority: "urgent",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/priority/);
  });
});

describe("runner — error surfaces", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("returns a clear error when a step references an unknown tool", async () => {
    const tool: CustomTool = {
      id: "bad",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "ghost_tool", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ghost_tool/);
    expect(result.error).toMatch(/not registered|disabled/);
  });

  it("propagates an isError from the called tool", async () => {
    registerTool("flaky", async () => ({
      isError: true,
      content: [{ type: "text", text: "underlying boom" }],
    }));
    const tool: CustomTool = {
      id: "uses_flaky",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "flaky", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/underlying boom/);
    expect(result.stepResults[0]?.ok).toBe(false);
  });
});

describe("runner — recursion guard", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("blocks a Custom Tool from invoking itself directly", async () => {
    // Compose: tool A's step calls tool A by name.
    const recursive: CustomTool = {
      id: "loop_a",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "loop_a", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Register loop_a as a fake registry tool so the lookup *would*
    // succeed if the recursion guard wasn't present. The guard must
    // intercept BEFORE the call.
    registerTool("loop_a", async () => ({
      content: [{ type: "text", text: "should never run" }],
    }));
    const result = await runCustomTool(recursive, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recursion/i);
  });

  // CR-01 — the manifest wrapper used to call runCustomTool with no
  // memory of the outer activeIds, so a→b→a was undetected. With the
  // ALS-backed guard, b inherits the active set from the outer a frame
  // automatically.
  it("blocks a transitive cycle (a → b → a) through the manifest wrapper", async () => {
    const toolA: CustomTool = {
      id: "tool_a",
      description: "a",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "tool_b", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const toolB: CustomTool = {
      id: "tool_b",
      description: "b",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "tool_a", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Register the manifest wrappers as registry tools so the runner
    // resolves `tool_a` / `tool_b` step lookups to the manifest handler
    // — exactly the production flow that bypassed the old per-call
    // activeIds threading.
    const wrapperA = buildCustomToolDefinition(toolA);
    const wrapperB = buildCustomToolDefinition(toolB);
    mockTools.push(wrapperA, wrapperB);

    const result = await runCustomTool(toolA, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recursion/i);
    // The chain should mention all three frames so the author can see
    // the cycle without reverse-engineering it.
    expect(result.error).toMatch(/tool_a/);
    expect(result.error).toMatch(/tool_b/);
  });
});

// CR-02 — Custom Tools must not be able to call connectors that grant
// privilege escalation (admin pack: backup export, raw KV access).
describe("runner — CR-02 admin allowlist", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("refuses to call a tool from the admin pack", async () => {
    let exfilCalled = false;
    registerAdminTool("mcp_backup_export", async () => {
      exfilCalled = true;
      return { content: [{ type: "text", text: "all-the-credentials" }] };
    });
    const tool: CustomTool = {
      id: "exfil_attempt",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "mcp_backup_export", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(exfilCalled).toBe(false);
    expect(result.error).toMatch(/not callable from custom tools/);
    expect(result.error).toMatch(/admin/);
  });
});

describe("runner — performance overhead", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("transform-only step adds < 100ms overhead", async () => {
    const tool: CustomTool = {
      id: "noop_transform",
      description: "x",
      destructive: false,
      inputs: [{ name: "x", type: "string", required: true, description: "" }],
      steps: [{ kind: "transform", template: "echo: {{x}}", saveAs: "out" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, { x: "hello" });
    expect(result.ok).toBe(true);
    // Generous bound — main-purpose is to catch a regression that
    // accidentally introduces sync I/O on the hot path.
    expect(result.totalDurationMs).toBeLessThan(100);
  });
});

// ── Timeouts (Phase 1) ────────────────────────────────────────────────
//
// Real timers, very small budgets (50–200ms). Vitest fake timers
// don't play well with native `setTimeout` inside Promise.race chains
// — easier and more honest to use real timers here. Each timeout test
// stays under 1s wall-clock so the suite remains fast.

describe("runner — timeouts", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
    delete process.env.CUSTOM_TOOLS_MAX_STEP_MS;
    delete process.env.CUSTOM_TOOLS_MAX_TOTAL_MS;
  });

  it("step timeout fires when a tool step exceeds maxStepMs", async () => {
    // A handler that sleeps longer than the budget.
    registerTool("slow_read", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: [{ type: "text", text: "never" }] };
    });
    const tool: CustomTool = {
      id: "slow_tool",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "slow_read", args: {}, saveAs: "x" }],
      maxStepMs: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/step\[0\] \(slow_read\): step timed out after 50ms/);
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.ok).toBe(false);
    expect(result.stepResults[0]?.error).toBe("timed out");
    expect(result.stepResults[0]?.durationMs).toBe(50);
  });

  it("total timeout fires when cumulative step time exceeds maxTotalMs", async () => {
    // Each step sleeps 80ms; budget is 100ms total. Step 0 finishes
    // (80ms), step 1 starts at 80ms and the total fires at 100ms — so
    // the in-flight step is step 1.
    registerTool("eighty", async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { content: [{ type: "text", text: "ok" }] };
    });
    const tool: CustomTool = {
      id: "two_slow",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [
        { kind: "tool", toolName: "eighty", args: {}, saveAs: "a" },
        { kind: "tool", toolName: "eighty", args: {}, saveAs: "b" },
      ],
      maxStepMs: 500, // not the binding constraint
      maxTotalMs: 100,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/total timeout exceeded after 100ms/);
    expect(result.error).toMatch(/step\[1\] \(eighty\)/);
    // Step 0 succeeded; step 1 was patched as timed-out by the total
    // timeout handler.
    expect(result.stepResults[0]?.ok).toBe(true);
    expect(result.stepResults[1]?.ok).toBe(false);
    expect(result.stepResults[1]?.error).toBe("timed out");
  });

  it("per-tool maxStepMs override beats env default", async () => {
    process.env.CUSTOM_TOOLS_MAX_STEP_MS = "10000";
    registerTool("medium", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: [{ type: "text", text: "x" }] };
    });
    const tool: CustomTool = {
      id: "override_step",
      description: "x",
      destructive: false,
      inputs: [],
      // The env says 10s — plenty. The tool overrides to 100ms — the
      // 200ms sleep MUST trip this override despite the relaxed env.
      steps: [{ kind: "tool", toolName: "medium", args: {}, saveAs: "x" }],
      maxStepMs: 100,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/step timed out after 100ms/);
    expect(result.stepResults[0]?.error).toBe("timed out");
  });
});

// ── Phase 3 telemetry: committedSteps tracking ────────────────────────
//
// Operators need to know which destructive side-effects landed before a
// failure so they can decide whether manual rollback is required. The
// runner stamps `committedSteps` on the RunResult; the dashboard's
// "Recent runs" tab surfaces them with a warning line.

describe("runner — committedSteps (Phase 3 telemetry)", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("tracks destructive steps that succeeded before a later failure", async () => {
    // Tool composition mirrors the spec example: transform OK → destructive
    // tool OK → tool FAIL. Only the middle (destructive) step should appear
    // in committedSteps; the transform never goes in (transforms are not
    // destructive by definition) and the failed step itself never lands.
    let writeCount = 0;
    registerTool(
      "vault_write",
      async () => {
        writeCount++;
        return { content: [{ type: "text", text: `wrote (#${writeCount})` }] };
      },
      true // destructive
    );
    registerTool("flaky_finalize", async () => ({
      isError: true,
      content: [{ type: "text", text: "downstream API down" }],
    }));

    const tool: CustomTool = {
      id: "partial_commit",
      description: "x",
      destructive: true,
      inputs: [],
      steps: [
        // Step 0: transform — never destructive
        { kind: "transform", template: "hello", saveAs: "greeting" },
        // Step 1: destructive tool — should land in committedSteps
        { kind: "tool", toolName: "vault_write", args: { content: "{{greeting}}" } },
        // Step 2: another tool that fails — must NOT land in committedSteps
        { kind: "tool", toolName: "flaky_finalize", args: {} },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.committedSteps).toEqual([{ index: 1, toolName: "vault_write" }]);
    // Sanity: the destructive step actually ran once before the failure.
    expect(writeCount).toBe(1);
  });

  it("excludes non-destructive tool steps from committedSteps", async () => {
    // Read-only tool followed by a fail. The successful read MUST NOT
    // appear in committedSteps — committedSteps is specifically about
    // side-effects an operator might need to undo.
    registerTool(
      "vault_read",
      async () => ({ content: [{ type: "text", text: "irrelevant" }] }),
      false
    );
    registerTool("boom", async () => ({
      isError: true,
      content: [{ type: "text", text: "no" }],
    }));
    const tool: CustomTool = {
      id: "readonly_then_fail",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [
        { kind: "tool", toolName: "vault_read", args: {}, saveAs: "x" },
        { kind: "tool", toolName: "boom", args: {} },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.committedSteps).toEqual([]);
  });

  it("returns committedSteps=[] for a fully successful run", async () => {
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "ok" }] }), true);
    const tool: CustomTool = {
      id: "all_ok",
      description: "x",
      destructive: true,
      inputs: [],
      steps: [{ kind: "tool", toolName: "vault_write", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(true);
    // Successful runs DO populate committedSteps (it's just informational
    // for non-errored runs), but the failed-rollback warning in the UI
    // only fires when ok=false. Asserting the shape is non-empty here so
    // a future refactor doesn't accidentally drop the field.
    expect(result.committedSteps).toEqual([{ index: 0, toolName: "vault_write" }]);
  });

  it("propagates source/tokenIdShort opts via the runner signature", async () => {
    // We're not asserting the persisted record here (runs-store is
    // mocked in this file); we just verify the runner accepts the
    // optional 3rd arg without TypeError or signature mismatch. The
    // runs-store roundtrip is covered in runs-store.test.ts.
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool: CustomTool = {
      id: "with_opts",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "vault_read", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {}, { source: "test", tokenIdShort: "abcdef12" });
    expect(result.ok).toBe(true);
  });
});

// ── Phase 5: dry-run mode ─────────────────────────────────────────────
//
// The composer drawer ships a "Dry-run (skip destructive steps)"
// checkbox so an author can exercise the runner — credential plumbing,
// Mustache renders, allowlist gates — without actually mutating
// anything. The runner enforces this by short-circuiting any tool step
// whose underlying registry tool carries `destructive: true`. Read-only
// tools and transforms execute normally — dry-run is about preventing
// side-effects, not disabling the runner wholesale.

describe("runner — dry-run (Phase 5)", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
  });

  it("skips destructive tool steps and returns mocked previews", async () => {
    // Read step (non-destructive) → transform → write step (destructive).
    // With dryRun: true, the read and the transform must execute as usual,
    // but the write handler must NEVER be invoked.
    let writeInvocations = 0;
    registerTool(
      "vault_read",
      async () => ({ content: [{ type: "text", text: "## Inbox\n- existing" }] }),
      false
    );
    registerTool(
      "vault_write",
      async () => {
        writeInvocations++;
        return { content: [{ type: "text", text: "REAL WRITE — should never run" }] };
      },
      true
    );

    const tool: CustomTool = {
      id: "dry_run_demo",
      description: "x",
      destructive: true,
      inputs: [{ name: "task", type: "string", required: true, description: "" }],
      steps: [
        // 0: read → real run, returns "## Inbox\n- existing"
        { kind: "tool", toolName: "vault_read", args: {}, saveAs: "current" },
        // 1: transform → real render, sees both `current` and `task`
        {
          kind: "transform",
          template: "{{current}}\n- [ ] {{task}}",
          saveAs: "next",
        },
        // 2: destructive write → SKIPPED, handler never called
        { kind: "tool", toolName: "vault_write", args: { content: "{{next}}" } },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await runCustomTool(tool, { task: "Buy milk" }, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(writeInvocations).toBe(0); // hard guarantee: no real write happened

    // Three step rows expected: real read, real transform, mocked write.
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults[0]?.ok).toBe(true);
    expect(result.stepResults[0]?.label).toBe("vault_read");
    expect(result.stepResults[0]?.preview).toContain("existing");

    expect(result.stepResults[1]?.ok).toBe(true);
    expect(result.stepResults[1]?.kind).toBe("transform");
    // Transform really rendered → should see both vars composed
    expect(result.stepResults[1]?.preview).toContain("Buy milk");

    // The write step is the spec contract: ok:true, label is the tool
    // name, preview is the canonical "[dry-run skipped]" sentinel.
    expect(result.stepResults[2]?.ok).toBe(true);
    expect(result.stepResults[2]?.label).toBe("vault_write");
    expect(result.stepResults[2]?.preview).toBe("[dry-run skipped]");

    // committedSteps stays empty — we explicitly did NOT commit anything,
    // so the operator's "rollback may be required" warning shouldn't fire.
    expect(result.committedSteps).toEqual([]);
  });

  it("does NOT skip read-only tools in dry-run", async () => {
    let readInvocations = 0;
    registerTool(
      "vault_read",
      async () => {
        readInvocations++;
        return { content: [{ type: "text", text: "real read" }] };
      },
      false // read-only
    );
    const tool: CustomTool = {
      id: "dry_run_readonly",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "vault_read", args: {}, saveAs: "x" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {}, { dryRun: true });
    expect(result.ok).toBe(true);
    // Read-only handler MUST have run — dry-run only skips destructive.
    expect(readInvocations).toBe(1);
    expect(result.stepResults[0]?.preview).toBe("real read");
  });

  it("dry-run mock keeps Mustache references alive in downstream steps", async () => {
    // The skipped step's saveAs slot must receive a non-undefined value
    // so {{<saved>}} in a later transform doesn't error out. We set the
    // mock to the literal string "[dry-run mock]" — that's the contract.
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "real" }] }), true);
    const tool: CustomTool = {
      id: "dry_run_chain",
      description: "x",
      destructive: true,
      inputs: [],
      steps: [
        // Skipped — saveAs:"out" gets "[dry-run mock]"
        { kind: "tool", toolName: "vault_write", args: {}, saveAs: "out" },
        // Real transform — must render the mock string into the result
        { kind: "transform", template: "after: {{out}}", saveAs: "final" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {}, { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("after: [dry-run mock]");
  });
});

// ── SEC-05 (2026-11 audit) ───────────────────────────────────────────
describe("runner — SEC-05 caller scope, toggles and arg validation", () => {
  beforeEach(() => {
    mockTools.length = 0;
    mockAdminTools.length = 0;
    disabledTools.clear();
  });

  function oneStep(toolName: string, args: Record<string, unknown> = {}): CustomTool {
    return {
      id: "composed",
      description: "x",
      destructive: false,
      inputs: [{ name: "n", type: "string", required: false, description: "" }],
      steps: [{ kind: "tool", toolName, args }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("EXPLOIT: a step whose connector is outside the caller token's scope is refused", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "sent" }] }));
    registerTool("vault_delete", handler, true);
    const { runWithToolAccess } = await import("@/core/token-scope");
    const result = await runWithToolAccess({ connectorScope: new Set(["custom-tools"]) }, () =>
      runCustomTool(oneStep("vault_delete"), {})
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside this token's connector scope/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows the step when the connector is in scope", async () => {
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const { runWithToolAccess } = await import("@/core/token-scope");
    const result = await runWithToolAccess(
      { connectorScope: new Set(["custom-tools", "vault"]) },
      () => runCustomTool(oneStep("vault_read"), {})
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a step that targets a disabled tool", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "x" }] }));
    registerTool("vault_write", handler, true);
    disabledTools.add("vault_write");
    const result = await runCustomTool(oneStep("vault_write"), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates step args against the target schema and coerces templated numbers", async () => {
    const { z } = await import("zod");
    let received: unknown;
    mockTools.push({
      name: "vault_list",
      description: "list",
      destructive: false,
      schema: { limit: z.number().int().max(50) },
      handler: async (args) => {
        received = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const ok = await runCustomTool(oneStep("vault_list", { limit: "{{n}}" }), { n: "5" });
    expect(ok.ok).toBe(true);
    expect(received).toEqual({ limit: 5 });

    const bad = await runCustomTool(oneStep("vault_list", { limit: "{{n}}" }), { n: "500" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid arguments for tool "vault_list"/);
  });

  it("REVIEW: an empty optional templated arg is treated as not provided; nested numbers coerced", async () => {
    const { z } = await import("zod");
    let received: unknown;
    mockTools.push({
      name: "vault_tree",
      description: "tree",
      destructive: false,
      schema: {
        depth: z.number().optional(),
        mode: z.enum(["a", "b"]).optional(),
        ids: z.array(z.number()).optional(),
      },
      handler: async (args) => {
        received = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const res = await runCustomTool(
      oneStep("vault_tree", { depth: "{{n}}", mode: "{{m}}", ids: ["{{n}}", "7"] }),
      { n: "" }
    );
    expect(res.ok).toBe(false); // ids: [""] is not a number array → still refused
    const ok = await runCustomTool(
      oneStep("vault_tree", { depth: "{{n}}", mode: "{{m}}", ids: ["3", "7"] }),
      {}
    );
    expect(ok.ok).toBe(true);
    expect(received).toEqual({ ids: [3, 7] });
  });
});
